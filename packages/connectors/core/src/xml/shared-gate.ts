import { SupplierCallError } from './supplier-types'
import type { ConnectorGate, XmlOperation } from './xml-transport'

/**
 * Circuit breaker and concurrency limit shared by every API task that calls one supplier connector (ADR 0060 go-live
 * prerequisite, ADR 0075 amendment 1). The state lives in a `GateStore` (Redis in the API); this class owns the policy.
 *
 * States, per connector:
 *  - closed: calls pass while fewer than `maxConcurrent` are in flight across all tasks;
 *  - open: `failureThreshold` consecutive provider failures open it for `openMs`; every call is refused with
 *    `circuit_open` and the remaining time, without reaching the supplier;
 *  - half-open: after `openMs` exactly one call is let through as a probe. Success closes the circuit; a provider
 *    failure re-opens it for another `openMs`. While the probe runs, other calls are refused.
 *
 * A slot is a lease (`slotTtlMs`), so a task that dies mid-call frees its slot when the lease lapses instead of
 * shrinking capacity for good. Choose `slotTtlMs` above the transport's overall timeout.
 *
 * Store outage policy (invariant 5, explicit): when the store cannot be reached, calls go through `whenStoreUnavailable`,
 * a per-task gate that the caller sizes conservatively (for example `maxConcurrent / taskCount`). Each such fallback is
 * reported through `event`, so an outage is visible and never silent.
 */
export interface SharedGateLimits {
  maxConcurrent: number
  failureThreshold: number
  openMs: number
  slotTtlMs: number
}

export type GateAcquireResult =
  | { status: 'acquired'; slotId: string }
  | { status: 'busy' }
  | { status: 'open'; retryAfterMs: number }

export type GateOutcome = 'ok' | 'provider_failure' | 'other'

/** Atomic state operations. Implementations must apply each call as one indivisible step across all tasks. */
export interface GateStore {
  acquire(gateKey: string, limits: SharedGateLimits): Promise<GateAcquireResult>
  release(gateKey: string, slotId: string, outcome: GateOutcome, limits: SharedGateLimits): Promise<void>
}

export interface SharedGateEvent {
  gateKey: string
  event: 'store_unavailable' | 'release_failed'
}

export interface SharedConnectorGateOptions {
  tenantId: string
  connectorId: string
  store: GateStore
  /** Required, so the outage policy is a decision and not a default. */
  whenStoreUnavailable: ConnectorGate
  limits?: Partial<SharedGateLimits>
  /** Receives ids and event names only. A throwing sink is ignored. */
  event?: (event: SharedGateEvent) => void
}

export const DEFAULT_SHARED_GATE_LIMITS: Readonly<SharedGateLimits> = Object.freeze({ maxConcurrent: 4, failureThreshold: 5, openMs: 30_000, slotTtlMs: 60_000 })

const IDENT = /^[a-zA-Z0-9_-]{1,100}$/

export function sharedGateKey(tenantId: string, connectorId: string): string {
  if (!IDENT.test(tenantId) || !IDENT.test(connectorId)) throw new SupplierCallError('configuration', 'not_sent')
  return `fbeds:v1:gate:${tenantId}:${connectorId}`
}

export class SharedConnectorGate implements ConnectorGate {
  readonly gateKey: string
  private readonly limits: Readonly<SharedGateLimits>

  constructor(private readonly options: SharedConnectorGateOptions) {
    this.gateKey = sharedGateKey(options.tenantId, options.connectorId)
    const limits = { ...DEFAULT_SHARED_GATE_LIMITS, ...options.limits }
    const positive = (n: number) => Number.isSafeInteger(n) && n > 0
    if (!positive(limits.maxConcurrent) || !positive(limits.failureThreshold) || !positive(limits.openMs) || !positive(limits.slotTtlMs)) {
      throw new SupplierCallError('configuration', 'not_sent')
    }
    this.limits = Object.freeze(limits)
  }

  async acquire(operation: XmlOperation): Promise<(outcome: GateOutcome) => void> {
    let result: GateAcquireResult
    try {
      result = await this.options.store.acquire(this.gateKey, this.limits)
    } catch {
      this.emit('store_unavailable')
      return this.options.whenStoreUnavailable.acquire(operation)
    }
    if (result.status === 'open') throw new SupplierCallError('circuit_open', 'not_sent', Math.max(0, result.retryAfterMs))
    if (result.status === 'busy') throw new SupplierCallError('busy', 'not_sent')

    const { slotId } = result
    let released = false
    return (outcome) => {
      if (released) return
      released = true
      // The caller is not kept waiting on the store; a lost release is bounded by the slot lease.
      this.options.store.release(this.gateKey, slotId, outcome, this.limits).catch(() => this.emit('release_failed'))
    }
  }

  private emit(event: SharedGateEvent['event']): void {
    try { this.options.event?.({ gateKey: this.gateKey, event }) } catch { /* telemetry cannot fail a supplier call */ }
  }
}
