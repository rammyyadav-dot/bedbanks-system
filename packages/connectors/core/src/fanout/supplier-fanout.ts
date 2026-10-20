import { SupplierCallError, type SupplierErrorCode } from '../xml/supplier-types'
import type { ConnectorGate, XmlOperation } from '../xml/xml-transport'

/**
 * Bounded, observable fan-out of one READ operation (search, content, availability) across several suppliers
 * (ADR 0075). Each supplier is a leg with its own deadline and its own circuit/concurrency gate, so one slow or
 * failing supplier can neither hold the response past the overall deadline nor take the others down with it.
 *
 * Rules, enforced here rather than left to callers:
 *  - reads only: a mutation (book, cancel) is never fanned out, raced or abandoned on a timer (ADR 0060 rule 4);
 *  - every leg finishes as `ok`, `fallback` or `failed`, and every failure is counted and emitted (invariant 5);
 *  - a fallback runs only when the caller declared one for that leg, and its value is tagged `fallback`, never `ok`;
 *  - a leg that ignores the abort signal is still abandoned at its deadline; a late answer is discarded;
 *  - events carry ids, codes and timings only: never the request, the response or a credential (invariant 7).
 */
export interface SupplierLeg<T> {
  supplierId: string
  connectorId: string
  /** Circuit breaker and concurrency limit for this supplier. Share one gate per supplier credential, not per call. */
  gate: ConnectorGate
  /** Must honour `signal`. Provider-specific work happens here; it returns canonical values only (invariant 9). */
  call: (signal: AbortSignal) => Promise<T>
  /** Per-leg budget. Capped by the overall deadline. */
  timeoutMs?: number
  /**
   * Explicit, caller-declared policy for a failed leg (for example last published static content). Omitted means the
   * leg is reported as failed and contributes nothing. Never declare one for rates, availability or prices.
   */
  fallback?: (failure: SupplierErrorCode) => Promise<T | null>
}

export interface FanoutOptions {
  operation: XmlOperation
  correlationId: string
  /** Hard budget for the whole fan-out. */
  deadlineMs: number
  /** Caller cancellation, for example the client disconnecting. */
  signal?: AbortSignal
  now?: () => number
  /** Receives the sanitized event only. A throwing sink is ignored. */
  event?: (event: FanoutLegEvent) => void
}

export type LegResult<T> =
  | { supplierId: string; connectorId: string; status: 'ok'; value: T; durationMs: number }
  | { supplierId: string; connectorId: string; status: 'fallback'; value: T; failure: SupplierErrorCode; durationMs: number }
  | { supplierId: string; connectorId: string; status: 'failed'; failure: SupplierErrorCode; durationMs: number }

export interface FanoutResult<T> {
  legs: LegResult<T>[]
  /** `degraded` counts legs answered from a declared fallback; they are also counted in `failed`. */
  summary: { queried: number; succeeded: number; failed: number; degraded: number }
}

export interface FanoutLegEvent {
  operation: string
  supplierId: string
  connectorId: string
  correlationId: string
  outcome: 'success' | SupplierErrorCode
  fallbackUsed: boolean
  durationMs: number
}

const IDENT = /^[a-zA-Z0-9_-]{1,100}$/
const DEFAULT_LEG_TIMEOUT_MS = 6_000
const MAX_LEGS = 64
/** Failures that say the supplier is unhealthy. Our own cancellation and a refused gate do not count against it. */
const PROVIDER_FAILURES: ReadonlySet<SupplierErrorCode> = new Set(['timeout', 'transport', 'provider_unavailable', 'rate_limited', 'malformed_response'])

class LegDeadline extends Error {}

export async function fanOutRead<T>(legs: readonly SupplierLeg<T>[], options: FanoutOptions): Promise<FanoutResult<T>> {
  if (options.operation.kind !== 'read') throw new SupplierCallError('unsupported', 'not_sent')
  if (!IDENT.test(options.correlationId) || !Number.isSafeInteger(options.deadlineMs) || options.deadlineMs <= 0 || legs.length > MAX_LEGS) throw new SupplierCallError('configuration', 'not_sent')
  const seen = new Set<string>()
  for (const leg of legs) {
    if (!IDENT.test(leg.supplierId) || !IDENT.test(leg.connectorId) || seen.has(leg.connectorId)) throw new SupplierCallError('configuration', 'not_sent')
    seen.add(leg.connectorId)
  }

  const now = options.now ?? Date.now
  const deadlineAt = now() + options.deadlineMs
  const results = await Promise.all(legs.map((leg) => runLeg(leg, options, now, deadlineAt)))
  const succeeded = results.filter((r) => r.status === 'ok').length
  return {
    legs: results,
    summary: { queried: results.length, succeeded, failed: results.length - succeeded, degraded: results.filter((r) => r.status === 'fallback').length },
  }
}

async function runLeg<T>(leg: SupplierLeg<T>, options: FanoutOptions, now: () => number, deadlineAt: number): Promise<LegResult<T>> {
  const started = now()
  const ids = { supplierId: leg.supplierId, connectorId: leg.connectorId }
  const finish = (result: LegResult<T>, outcome: FanoutLegEvent['outcome']): LegResult<T> => {
    try {
      options.event?.({ operation: options.operation.name, ...ids, correlationId: options.correlationId, outcome, fallbackUsed: result.status === 'fallback', durationMs: result.durationMs })
    } catch { /* telemetry cannot fail a search */ }
    return result
  }

  let failure: SupplierErrorCode
  try {
    const value = await callWithinBudget(leg, options, Math.min(leg.timeoutMs ?? DEFAULT_LEG_TIMEOUT_MS, deadlineAt - started))
    return finish({ ...ids, status: 'ok', value, durationMs: Math.max(0, now() - started) }, 'success')
  } catch (error) {
    failure = error instanceof SupplierCallError ? error.code : 'transport'
  }

  // The leg failed. Only a declared fallback may answer, and only inside what is left of the overall budget.
  if (leg.fallback && failure !== 'cancelled' && now() < deadlineAt) {
    let value: T | null = null
    try { value = await withTimer(leg.fallback(failure), deadlineAt - now()) } catch { value = null }
    if (value !== null) return finish({ ...ids, status: 'fallback', value, failure, durationMs: Math.max(0, now() - started) }, failure)
  }
  return finish({ ...ids, status: 'failed', failure, durationMs: Math.max(0, now() - started) }, failure)
}

/** One supplier call: gate, linked abort, hard timer. Throws SupplierCallError only. */
async function callWithinBudget<T>(leg: SupplierLeg<T>, options: FanoutOptions, budgetMs: number): Promise<T> {
  if (options.signal?.aborted) throw new SupplierCallError('cancelled', 'not_sent')
  if (budgetMs <= 0) throw new SupplierCallError('timeout', 'not_sent')

  let release: Awaited<ReturnType<ConnectorGate['acquire']>>
  try { release = await leg.gate.acquire(options.operation) } catch (error) {
    throw error instanceof SupplierCallError ? error : new SupplierCallError('busy', 'not_sent')
  }

  const controller = new AbortController()
  const onCallerAbort = () => controller.abort()
  options.signal?.addEventListener('abort', onCallerAbort, { once: true })
  let gateOutcome: 'ok' | 'provider_failure' | 'other' = 'other'
  try {
    const value = await withTimer(leg.call(controller.signal), budgetMs)
    gateOutcome = 'ok'
    return value
  } catch (error) {
    const code: SupplierErrorCode = options.signal?.aborted ? 'cancelled'
      : error instanceof LegDeadline ? 'timeout'
      : error instanceof SupplierCallError ? error.code
      : 'transport'
    if (PROVIDER_FAILURES.has(code)) gateOutcome = 'provider_failure'
    throw new SupplierCallError(code, 'answered', error instanceof SupplierCallError ? error.retryAfterMs : null)
  } finally {
    controller.abort()
    options.signal?.removeEventListener('abort', onCallerAbort)
    release(gateOutcome)
  }
}

/** Rejects with LegDeadline after `ms`, even when `work` never settles. A late settlement is ignored. */
async function withTimer<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  work.catch(() => undefined)
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new LegDeadline()), Math.max(0, ms)) })])
  } finally { if (timer) clearTimeout(timer) }
}
