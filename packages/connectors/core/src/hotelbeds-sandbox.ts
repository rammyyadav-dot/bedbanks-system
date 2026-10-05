import { createHash } from 'node:crypto'

export type SandboxErrorCode = 'disabled' | 'scope' | 'configuration' | 'authentication_or_quota' | 'rate_limited' | 'timeout' | 'cancelled' | 'transport' | 'provider_unavailable' | 'malformed_response' | 'unsupported' | 'busy' | 'circuit_open'
export class SandboxError extends Error {
  readonly code: SandboxErrorCode
  readonly retryAfterMs: number | null
  constructor(code: SandboxErrorCode, retryAfterMs: number | null = null) {
    super('Supplier sandbox operation failed')
    this.name = 'SandboxError'
    this.code = code
    this.retryAfterMs = retryAfterMs
  }
}
export interface SandboxScope { tenantId: string; supplierId: string; connectorId: string }
export interface SandboxContext extends SandboxScope { correlationId: string; signal?: AbortSignal }
export interface HotelbedsSecrets { apiKey: string; secret: string }
export interface SandboxEvent {
  operation: 'status' | 'search' | 'checkrates' | 'content'
  outcome: 'success' | SandboxErrorCode
  attempt: number
  durationMs: number
}
export interface SandboxConfig extends SandboxScope {
  enabled: boolean
  /** Name/reference only; the resolver receives the fixed tenant/supplier scope. */
  secretRef: string
}
export interface SandboxDependencies {
  resolveSecret: (reference: string, scope: SandboxScope) => Promise<HotelbedsSecrets>
  fetch?: typeof fetch
  now?: () => number
  /** Must write only the sanitized event, never headers, request/response bodies or rate keys. */
  event?: (event: SandboxEvent) => void
}
export interface SandboxSearch {
  checkIn: string
  checkOut: string
  hotelCodes: number[]
  /** The first slice supports exactly one room/two adults/no children. */
  rooms: 1
  adults: 2
  children: 0
}
const BASE = 'https://api.test.hotelbeds.com'
const MAX_BYTES = 2 * 1024 * 1024
const id = (value: string): boolean => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value)
function fail(code: SandboxErrorCode): never { throw new SandboxError(code) }
function date(value: string): boolean {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
}
export function validateSandboxSearch(input: SandboxSearch): void {
  if (!input || !date(input.checkIn) || !date(input.checkOut) || input.checkOut <= input.checkIn ||
      input.rooms !== 1 || input.adults !== 2 || input.children !== 0 ||
      !Array.isArray(input.hotelCodes) || input.hotelCodes.length < 1 || input.hotelCodes.length > 10 ||
      input.hotelCodes.some(c => !Number.isSafeInteger(c) || c <= 0) || new Set(input.hotelCodes).size !== input.hotelCodes.length) fail('unsupported')
}
export function retryAfter(value: string | null, now: number): number | null {
  if (value === null) return null
  if (/^\d+$/.test(value)) { const milliseconds = Number(value) * 1000; return Number.isSafeInteger(milliseconds) ? milliseconds : null }
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : null
}
async function jsonLimited(response: Response): Promise<unknown> {
  if (!(response.headers.get('content-type') ?? '').toLowerCase().match(/^application\/json(?:\s*;|$)/)) fail('malformed_response')
  const length = response.headers.get('content-length')
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) fail('malformed_response')
  if (!response.body) fail('malformed_response')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BYTES) fail('malformed_response')
      chunks.push(value)
    }
    const bytes = Buffer.concat(chunks)
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('malformed_response')
    return parsed
  } catch (error) {
    if (error instanceof SandboxError) throw error
    fail('malformed_response')
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
}
async function pause(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) fail('cancelled')
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new SandboxError('cancelled')) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, ms)
    signal?.addEventListener('abort', abort, { once: true })
  })
}

/** Disabled by default; no user-supplied path, host, method or redirect is accepted.
 * This is a SINGLE PROCESS evaluation client. Do not wire into multi-worker routing
 * until the credential-wide quota and circuit state have a shared atomic coordinator.
 */
export class HotelbedsSandboxTransport {
  private readonly config: SandboxConfig
  private readonly dependencies: SandboxDependencies
  private active = false
  private attemptsToday = 0
  private day = ''
  private nextRequestAt = 0
  private failures = 0
  private openUntil = 0
  private readonly successes = new Set<string>()
  constructor(config: SandboxConfig, dependencies: SandboxDependencies) {
    if (![config.tenantId, config.supplierId, config.connectorId].every(id) || !config.secretRef ||
        config.secretRef.length > 200 || config.secretRef.includes('\n')) fail('configuration')
    this.config = Object.freeze({ ...config })
    this.dependencies = dependencies
  }
  status(context: SandboxContext): Promise<unknown> { return this.request('status', 'GET', '/hotel-api/1.0/status', context) }
  search(input: SandboxSearch, context: SandboxContext): Promise<unknown> {
    validateSandboxSearch(input)
    return this.request('search', 'POST', '/hotel-api/1.0/hotels', context, {
      stay: { checkIn: input.checkIn, checkOut: input.checkOut },
      occupancies: [{ rooms: 1, adults: 2, children: 0 }],
      hotels: { hotel: input.hotelCodes },
    })
  }
  /** Only a rateType RECHECK from a prior response may use this operation.
   * No BOOKABLE checkrate amplification; obtaining extra comments is a future scope.
   */
  checkRate(rateKey: string, rateType: 'RECHECK', context: SandboxContext): Promise<unknown> {
    if (rateType !== 'RECHECK' || typeof rateKey !== 'string' || rateKey.length < 1 || rateKey.length > 4096 || /[\r\n]/.test(rateKey)) fail('unsupported')
    return this.request('checkrates', 'POST', '/hotel-api/1.0/checkrates', context, { rooms: [{ rateKey }] })
  }
  contentPage(from: number, to: number, context: SandboxContext, lastUpdateTime?: string): Promise<unknown> {
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from || to - from >= 100 ||
        (lastUpdateTime !== undefined && !date(lastUpdateTime))) fail('unsupported')
    const query = new URLSearchParams({ fields: 'all', language: 'ENG', from: String(from), to: String(to) })
    if (lastUpdateTime) query.set('lastUpdateTime', lastUpdateTime)
    return this.request('content', 'GET', '/hotel-content-api/1.0/hotels?' + query, context)
  }
  health(): { configured: boolean; capabilitiesSucceeded: string[]; failures: number; circuitOpen: boolean; attemptsToday: number } {
    return { configured: this.config.enabled, capabilitiesSucceeded: [...this.successes], failures: this.failures,
      circuitOpen: this.now() < this.openUntil, attemptsToday: this.attemptsToday }
  }
  private now(): number { return (this.dependencies.now ?? Date.now)() }
  private emit(event: SandboxEvent): void { try { this.dependencies.event?.(event) } catch { /* Telemetry failure cannot change request truth. */ } }
  private async request(operation: SandboxEvent['operation'], method: 'GET' | 'POST', path: string, context: SandboxContext, body?: unknown): Promise<unknown> {
    if (this.config.enabled !== true) fail('disabled')
    const allowed = (operation === 'status' && method === 'GET' && path === '/hotel-api/1.0/status') ||
      (operation === 'search' && method === 'POST' && path === '/hotel-api/1.0/hotels') ||
      (operation === 'checkrates' && method === 'POST' && path === '/hotel-api/1.0/checkrates') ||
      (operation === 'content' && method === 'GET' && /^\/hotel-content-api\/1\.0\/hotels\?fields=all&language=ENG&from=\d+&to=\d+(?:&lastUpdateTime=\d{4}-\d{2}-\d{2})?$/.test(path))
    if (!allowed) fail('unsupported')
    if (context.tenantId !== this.config.tenantId || context.supplierId !== this.config.supplierId ||
        context.connectorId !== this.config.connectorId || !id(context.correlationId)) fail('scope')
    if (context.signal?.aborted) fail('cancelled')
    if (this.active) fail('busy')
    if (this.now() < this.openUntil) fail('circuit_open')
    this.active = true
    const deadline = this.now() + 10_000
    try {
      const secrets = await Promise.race([
        this.dependencies.resolveSecret(this.config.secretRef, { tenantId: this.config.tenantId, supplierId: this.config.supplierId, connectorId: this.config.connectorId }),
        new Promise<never>((_, reject) => { const t = setTimeout(() => reject(new SandboxError('timeout')), 2000); t.unref() }),
      ])
      if (!secrets || typeof secrets.apiKey !== 'string' || !secrets.apiKey || secrets.apiKey.length > 512 ||
          typeof secrets.secret !== 'string' || !secrets.secret || secrets.secret.length > 512 || /[\r\n]/.test(secrets.apiKey)) fail('configuration')
      // POST operations intentionally have no automatic retry. Only safe GET reads retry once.
      const maxAttempts = method === 'GET' ? 2 : 1
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (context.signal?.aborted) fail('cancelled')
        const started = this.now()
        const today = new Date(started).toISOString().slice(0, 10)
        if (today !== this.day) { this.day = today; this.attemptsToday = 0 }
        if (this.attemptsToday >= 50) fail('rate_limited')
        const spacing = this.nextRequestAt - started
        if (spacing > 0) { if (this.now() + spacing >= deadline) fail('rate_limited'); await pause(spacing, context.signal) }
        this.nextRequestAt = this.now() + 1000
        this.attemptsToday++
        const controller = new AbortController()
        const abort = () => controller.abort()
        context.signal?.addEventListener('abort', abort, { once: true })
        const timer = setTimeout(abort, Math.min(5000, Math.max(1, deadline - this.now())))
        try {
          const signature = createHash('sha256').update(secrets.apiKey + secrets.secret + Math.floor(this.now() / 1000)).digest('hex')
          const response = await (this.dependencies.fetch ?? fetch)(BASE + path, {
            method, redirect: 'error', signal: controller.signal,
            headers: { 'Api-key': secrets.apiKey, 'X-Signature': signature, Accept: 'application/json', 'Content-Type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          })
          if (response.status === 401 || response.status === 403) { await response.body?.cancel(); fail('authentication_or_quota') }
          if (response.status === 429) { const delay = retryAfter(response.headers.get('retry-after'), this.now()); await response.body?.cancel(); throw new SandboxError('rate_limited', delay) }
          if (!response.ok) { await response.body?.cancel(); fail(response.status >= 500 ? 'provider_unavailable' : 'unsupported') }
          const parsed = await jsonLimited(response)
          if ((parsed as Record<string, unknown>).error !== undefined) fail('unsupported')
          this.failures = 0
          this.openUntil = 0
          this.successes.add(operation)
          this.emit({ operation, outcome: 'success', attempt, durationMs: Math.max(0, this.now() - started) })
          return parsed
        } catch (error) {
          const classified = context.signal?.aborted ? new SandboxError('cancelled') :
            controller.signal.aborted ? new SandboxError('timeout') :
            error instanceof SandboxError ? error : new SandboxError('transport')
          this.emit({ operation, outcome: classified.code, attempt, durationMs: Math.max(0, this.now() - started) })
          const transient = ['transport', 'timeout', 'provider_unavailable', 'rate_limited'].includes(classified.code)
          if (classified.code !== 'cancelled') { this.failures++; if (this.failures >= 3) this.openUntil = this.now() + 30_000 }
          const delay = classified.retryAfterMs ?? Math.floor(250 + Math.random() * 250)
          if (!transient || attempt === maxAttempts || this.now() + Math.max(delay, 1000) >= deadline || this.now() < this.openUntil) throw classified
          await pause(delay, context.signal)
        } finally { clearTimeout(timer); context.signal?.removeEventListener('abort', abort) }
      }
      return fail('transport')
    } catch (error) {
      if (error instanceof SandboxError) throw error
      return fail('configuration')
    } finally { this.active = false }
  }
}

/** A wire-price conversion, not a second canonical Money schema. AED-only slice. */
export function hotelbedsAedMinor(value: unknown): number {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,13})(\.\d{1,2})?$/.test(value)) fail('malformed_response')
  const [whole, fraction = ''] = value.split('.')
  const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'))
  if (minor <= 0n || minor > BigInt(Number.MAX_SAFE_INTEGER)) fail('malformed_response')
  return Number(minor)
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('malformed_response')
  return value as Record<string, unknown>
}
function text(value: unknown, maximum = 4096): string {
  if (typeof value !== 'string' || !value || value.length > maximum) fail('malformed_response')
  return value
}
export interface HotelbedsObservation {
  supplierHotelId: string
  supplierRoomId: string
  supplierBoardCode: string
  rateKey: string
  rateType: 'RECHECK' | 'BOOKABLE'
  netAmountMinor: number
  currency: 'AED'
  cancellationPolicies: Array<{ amountMinor: number; from: string }>
  rateComments: string | null
  allTaxesIncluded: boolean
  /** Local receipt is not supplier freshness, and is NEVER written to inventory. */
  receivedAt: string
  supplierUpdatedAt: null
  supplierExpiresAt: null
  selectable: false
  blockReasons: string[]
}
/** Returns staging observations only: no canonical IDs, sell price, invented expiry
 * or inventory counters. Fail closed until approved mappings/commercial authority exist.
 */
export function normalizeHotelbedsResponse(payload: unknown, receivedAt: string): HotelbedsObservation[] {
  if (!Number.isFinite(Date.parse(receivedAt))) fail('malformed_response')
  const root = object(payload)
  if (root.error !== undefined) fail('provider_unavailable')
  const wrapper = object(root.hotels ?? root.hotel)
  const hotels = root.hotel ? [wrapper] : wrapper.hotels
  if (!Array.isArray(hotels) || hotels.length > 100) fail('malformed_response')
  const observations: HotelbedsObservation[] = []
  for (const rawHotel of hotels) {
    const hotel = object(rawHotel)
    if (!Number.isSafeInteger(hotel.code) || (hotel.code as number) <= 0 || hotel.currency !== 'AED') fail('unsupported')
    if (!Array.isArray(hotel.rooms) || hotel.rooms.length > 100) fail('malformed_response')
    for (const rawRoom of hotel.rooms) {
      const room = object(rawRoom)
      const roomCode = text(room.code, 100)
      if (!Array.isArray(room.rates) || room.rates.length > 100) fail('malformed_response')
      for (const rawRate of room.rates) {
        const rate = object(rawRate)
        if (rate.rateType !== 'RECHECK' && rate.rateType !== 'BOOKABLE') fail('unsupported')
        if (rate.rooms !== 1 || rate.adults !== 2 || rate.children !== 0 || rate.packaging !== false || rate.paymentType !== 'AT_WEB') fail('unsupported')
        if (!Array.isArray(rate.cancellationPolicies) || !rate.cancellationPolicies.length) fail('malformed_response')
        const policies = rate.cancellationPolicies.map(raw => {
          const policy = object(raw)
          const from = text(policy.from, 100)
          if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(from) || !Number.isFinite(Date.parse(from))) fail('malformed_response')
          return { amountMinor: policy.amount === '0' || policy.amount === '0.00' ? 0 : hotelbedsAedMinor(policy.amount), from }
        })
        const taxes = rate.taxes === undefined ? null : object(rate.taxes)
        const included = taxes?.allIncluded === true && Array.isArray(taxes.taxes) && taxes.taxes.every(raw => {
          const tax = object(raw)
          return tax.included === true && tax.currency === 'AED' && typeof tax.amount === 'string' && /^(0|[1-9]\d*)(\.\d{1,2})?$/.test(tax.amount)
        })
        const blockReasons = ['sandbox_mapping_prohibited', 'canonical_board_mapping_missing', 'commercial_price_authority_missing', 'supplier_expiry_not_documented']
        if (!included) blockReasons.push('tax_inclusivity_unproven')
        if (observations.length >= 1000) fail('malformed_response')
        observations.push({
          supplierHotelId: String(hotel.code), supplierRoomId: roomCode, supplierBoardCode: text(rate.boardCode, 100),
          rateKey: text(rate.rateKey), rateType: rate.rateType, netAmountMinor: hotelbedsAedMinor(rate.net), currency: 'AED',
          cancellationPolicies: policies, rateComments: rate.rateComments === undefined ? null : text(rate.rateComments, 20000),
          allTaxesIncluded: included, receivedAt, supplierUpdatedAt: null, supplierExpiresAt: null,
          selectable: false, blockReasons,
        })
      }
    }
  }
  return observations
}
