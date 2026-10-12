import { isIP } from 'node:net'
import { lookup as dnsLookup } from 'node:dns/promises'
import { DEFAULT_XML_LIMITS, parseXml, XmlParseError, type XmlLimits, type XmlNode } from './xml-parser.js'
import { SupplierCallError, type SupplierCallContext, type SupplierErrorCode, type SupplierScope } from './supplier-types.js'

/**
 * Hardened HTTPS transport for supplier XML/SOAP endpoints (WebBeds, TBO, Darina and later suppliers share it; only the
 * request builders and response mappers differ per provider).
 *
 * Controls, all enforced here rather than left to each provider profile:
 *  - disabled by default; the caller scope must equal the configured tenant/supplier/connector;
 *  - the endpoint is operator configuration, never request input: https only, no userinfo, port 443, exact host allowlist,
 *    no IP literals, optional DNS check that refuses private/loopback/link-local answers, redirects refused;
 *  - credentials come from a secret reference resolved per call; they reach only the request builder and are never
 *    stored, logged, or placed in an error or event;
 *  - reads retry once for transient faults; MUTATIONS NEVER RETRY and report whether the supplier may have acted;
 *  - bounded time, bounded response size, strict UTF-8, XML content-type, hardened parser;
 *  - circuit breaker and concurrency limit through a pluggable gate (in-process by default).
 *
 * The in-process gate does not coordinate several workers or other clients sharing a credential. Provide a shared
 * gate before running this from more than one process.
 */
export type OperationKind = 'read' | 'mutation'
export interface XmlOperation { name: string; kind: OperationKind }
export interface XmlRequest {
  method?: 'POST' | 'GET'
  body: string
  /** Provider headers such as SOAPAction or Content-Type. Host, Content-Length and Transfer-Encoding are refused. */
  headers?: Record<string, string>
}
export interface XmlTransportConfig extends SupplierScope {
  enabled: boolean
  /** Full https URL of the supplier endpoint, taken from approved operator configuration. */
  endpoint: string
  /** Exact hostnames this deployment may call. The endpoint host must be listed. */
  allowedHosts: readonly string[]
  /** Secret-manager reference only. */
  secretRef: string
  attemptTimeoutMs?: number
  /** Total budget across retries. */
  overallTimeoutMs?: number
  maxResponseBytes?: number
  xmlLimits?: Partial<XmlLimits>
}
export interface TransportEvent { operation: string; kind: OperationKind; outcome: 'success' | SupplierErrorCode; attempt: number; durationMs: number; httpStatus: number | null; correlationId: string }
export interface ConnectorGate {
  /** Resolve with a release function, or throw SupplierCallError('busy' | 'circuit_open' | 'rate_limited'). */
  acquire(operation: XmlOperation): Promise<(outcome: 'ok' | 'provider_failure' | 'other') => void>
}
export interface XmlTransportDeps<S> {
  resolveSecret: (reference: string, scope: SupplierScope) => Promise<S>
  fetch?: typeof fetch
  now?: () => number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  random?: () => number
  /** Return every address the host resolves to. Defaults to the system resolver. */
  resolveHost?: (host: string) => Promise<string[]>
  gate?: ConnectorGate
  /** Must receive only the sanitized event. */
  event?: (event: TransportEvent) => void
}
export interface XmlResponse { status: number; root: XmlNode }

const FORBIDDEN_HEADERS = new Set(['host', 'content-length', 'transfer-encoding', 'connection', 'upgrade'])
const IDENT = /^[a-zA-Z0-9_-]{1,100}$/
const XML_TYPE = /^(?:application|text)\/(?:[a-z0-9.+-]+\+)?xml\s*(?:;|$)/i

function fail(code: SupplierErrorCode, delivery: 'not_sent' | 'maybe_sent' | 'answered' = 'not_sent', retryAfterMs: number | null = null): never { throw new SupplierCallError(code, delivery, retryAfterMs) }

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) {
    const [a, b] = address.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224
  }
  if (family === 6) {
    const v = address.toLowerCase()
    if (v === '::' || v === '::1' || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb') || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('ff')) return true
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v)
    return mapped ? isPrivateAddress(mapped[1]) : false
  }
  return true
}

/** Validates operator-supplied endpoint configuration. Throws `endpoint_rejected` for anything outside the allowlist. */
export function assertSafeEndpoint(endpoint: string, allowedHosts: readonly string[]): URL {
  let url: URL
  try { url = new URL(endpoint) } catch { return fail('endpoint_rejected') }
  const host = url.hostname.toLowerCase()
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443') ||
      isIP(host.replace(/^\[|\]$/g, '')) !== 0 || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') ||
      !allowedHosts.map((h) => h.toLowerCase()).includes(host)) fail('endpoint_rejected')
  return url
}

/** One-process concurrency limit and circuit breaker. */
export class InProcessGate implements ConnectorGate {
  private active = 0
  private failures = 0
  private openUntil = 0
  constructor(private readonly options: { maxConcurrent?: number; failureThreshold?: number; openMs?: number; now?: () => number } = {}) {}
  async acquire(): Promise<(outcome: 'ok' | 'provider_failure' | 'other') => void> {
    const now = (this.options.now ?? Date.now)()
    if (now < this.openUntil) fail('circuit_open', 'not_sent', this.openUntil - now)
    if (this.active >= (this.options.maxConcurrent ?? 4)) fail('busy')
    this.active += 1
    let released = false
    return (outcome) => {
      if (released) return
      released = true
      this.active -= 1
      if (outcome === 'ok') this.failures = 0
      else if (outcome === 'provider_failure' && ++this.failures >= (this.options.failureThreshold ?? 5)) {
        this.openUntil = (this.options.now ?? Date.now)() + (this.options.openMs ?? 30_000)
        this.failures = 0
      }
    }
  }
  snapshot(): { active: number; failures: number; circuitOpen: boolean } {
    return { active: this.active, failures: this.failures, circuitOpen: (this.options.now ?? Date.now)() < this.openUntil }
  }
}

const sleepDefault = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(new SupplierCallError('cancelled', 'not_sent'))
  const abort = () => { clearTimeout(timer); reject(new SupplierCallError('cancelled', 'not_sent')) }
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, ms)
  signal?.addEventListener('abort', abort, { once: true })
})

export function parseRetryAfter(value: string | null, now: number): number | null {
  if (value === null) return null
  if (/^\d+$/.test(value)) { const ms = Number(value) * 1000; return Number.isSafeInteger(ms) ? ms : null }
  const at = Date.parse(value)
  return Number.isFinite(at) ? Math.max(0, at - now) : null
}

async function readLimited(response: Response, maxBytes: number): Promise<Uint8Array> {
  const length = response.headers.get('content-length')
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) throw new XmlParseError('too_large')
  if (!response.body) throw new XmlParseError('empty')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) throw new XmlParseError('too_large')
      chunks.push(value)
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
  return Buffer.concat(chunks)
}

export class XmlSupplierTransport<S> {
  private readonly config: Readonly<XmlTransportConfig>
  private readonly url: URL | null
  private readonly gate: ConnectorGate

  constructor(config: XmlTransportConfig, private readonly deps: XmlTransportDeps<S>) {
    if (![config.tenantId, config.supplierId, config.connectorId].every((v) => IDENT.test(v)) || !config.secretRef || config.secretRef.length > 200 || /[\r\n]/.test(config.secretRef)) fail('configuration')
    this.config = Object.freeze({ ...config, allowedHosts: [...config.allowedHosts] })
    // A disabled connector never inspects its endpoint, so draft connectors can be stored without a live host.
    this.url = config.enabled ? assertSafeEndpoint(config.endpoint, config.allowedHosts) : null
    this.gate = deps.gate ?? new InProcessGate({ now: deps.now })
  }

  async send(operation: XmlOperation, build: (secrets: S) => XmlRequest, context: SupplierCallContext): Promise<XmlResponse> {
    const { config, deps } = this
    if (!config.enabled || !this.url) fail('disabled')
    if (context.tenantId !== config.tenantId || context.supplierId !== config.supplierId || context.connectorId !== config.connectorId || !IDENT.test(context.correlationId)) fail('scope')
    if (context.signal?.aborted) fail('cancelled')

    const now = deps.now ?? Date.now
    const sleep = deps.sleep ?? sleepDefault
    const overall = config.overallTimeoutMs ?? 20_000
    const started = now()
    const maxAttempts = operation.kind === 'read' ? 2 : 1
    const emit = (outcome: TransportEvent['outcome'], attempt: number, since: number, httpStatus: number | null) =>
      deps.event?.({ operation: operation.name, kind: operation.kind, outcome, attempt, durationMs: Math.max(0, now() - since), httpStatus, correlationId: context.correlationId })

    await this.assertPublicHost(this.url.hostname)
    const release = await this.gate.acquire(operation)
    let outcome: 'ok' | 'provider_failure' | 'other' = 'other'
    try {
      let secrets: S
      try { secrets = await withTimeout(deps.resolveSecret(config.secretRef, { tenantId: config.tenantId, supplierId: config.supplierId, connectorId: config.connectorId }), 2_000) } catch { return fail('secret_unavailable') }
      for (let attempt = 1; ; attempt++) {
        const attemptStarted = now()
        try {
          const response = await this.once(operation, build(secrets), context, Math.min(config.attemptTimeoutMs ?? 8_000, Math.max(1, overall - (attemptStarted - started))))
          outcome = 'ok'
          emit('success', attempt, attemptStarted, response.status)
          return response
        } catch (error) {
          const failure = error instanceof SupplierCallError ? error : new SupplierCallError('transport', operation.kind === 'mutation' ? 'maybe_sent' : 'answered')
          emit(failure.code, attempt, attemptStarted, null)
          const transient = failure.code === 'timeout' || failure.code === 'transport' || failure.code === 'provider_unavailable' || failure.code === 'rate_limited'
          if (transient) outcome = 'provider_failure'
          const wait = failure.retryAfterMs ?? Math.round(250 + (deps.random ?? Math.random)() * 250)
          if (!transient || attempt >= maxAttempts || wait > 2_000 || now() - started + wait >= overall) throw failure
          await sleep(wait, context.signal)
        }
      }
    } finally { release(outcome) }
  }

  private async assertPublicHost(host: string): Promise<void> {
    let addresses: string[]
    try { addresses = await (this.deps.resolveHost ?? (async (h: string) => (await dnsLookup(h, { all: true })).map((a) => a.address)))(host) } catch { return fail('transport') }
    if (addresses.length === 0 || addresses.some(isPrivateAddress)) fail('endpoint_rejected')
  }

  private async once(operation: XmlOperation, request: XmlRequest, context: SupplierCallContext, timeoutMs: number): Promise<XmlResponse> {
    const maxBytes = this.config.maxResponseBytes ?? DEFAULT_XML_LIMITS.maxBytes
    const headers: Record<string, string> = { Accept: 'application/xml, text/xml, application/soap+xml' }
    for (const [name, value] of Object.entries(request.headers ?? {})) {
      if (FORBIDDEN_HEADERS.has(name.toLowerCase()) || /[\r\n]/.test(name + value)) fail('configuration')
      headers[name] = value
    }
    if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['Content-Type'] = 'text/xml; charset=utf-8'
    if (Buffer.byteLength(request.body, 'utf8') > 2 * 1024 * 1024) fail('unsupported')

    // After this point the request may have reached the supplier.
    const afterSend: 'maybe_sent' | 'answered' = operation.kind === 'mutation' ? 'maybe_sent' : 'answered'
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    context.signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let timedOut = false
    controller.signal.addEventListener('abort', () => { timedOut = !context.signal?.aborted }, { once: true })
    try {
      let response: Response
      try {
        response = await (this.deps.fetch ?? fetch)(this.url!.toString(), { method: request.method ?? 'POST', headers, body: request.method === 'GET' ? undefined : request.body, redirect: 'error', signal: controller.signal })
      } catch { return fail(context.signal?.aborted ? 'cancelled' : timedOut ? 'timeout' : 'transport', afterSend) }

      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), (this.deps.now ?? Date.now)())
      if (response.status === 429) { await response.body?.cancel().catch(() => undefined); return fail('rate_limited', afterSend, retryAfterMs) }
      if (response.status === 401 || response.status === 403) { await response.body?.cancel().catch(() => undefined); return fail('authentication', 'answered') }
      if (response.status >= 500) { await response.body?.cancel().catch(() => undefined); return fail('provider_unavailable', afterSend, retryAfterMs) }
      // SOAP servers report faults as 500 with an XML body, which is handled above as unavailable; other 4xx are a definite refusal.
      if (response.status < 200 || response.status >= 300) { await response.body?.cancel().catch(() => undefined); return fail('supplier_fault', 'answered') }

      if (!XML_TYPE.test(response.headers.get('content-type') ?? '')) { await response.body?.cancel().catch(() => undefined); return fail('malformed_response', afterSend) }
      const charset = /charset\s*=\s*"?([^\s;"]+)/i.exec(response.headers.get('content-type') ?? '')?.[1]
      if (charset && !/^utf-?8$/i.test(charset)) { await response.body?.cancel().catch(() => undefined); return fail('malformed_response', afterSend) }
      try {
        const bytes = await readLimited(response, maxBytes)
        return { status: response.status, root: parseXml(bytes, { ...DEFAULT_XML_LIMITS, ...this.config.xmlLimits, maxBytes }) }
      } catch (error) {
        if (error instanceof XmlParseError || error instanceof SupplierCallError) return fail('malformed_response', afterSend)
        return fail(context.signal?.aborted ? 'cancelled' : timedOut ? 'timeout' : 'transport', afterSend)
      }
    } finally { clearTimeout(timer); context.signal?.removeEventListener('abort', onAbort) }
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms) })]) } finally { if (timer) clearTimeout(timer) }
}
