import type { ConnectorGate, XmlOperation } from './xml-transport.js'
import { SupplierCallError } from './supplier-types.js'

/**
 * Credential-wide gate built on the platform's best-effort coordination (Redis locks) and cache ports, so several API
 * workers share one concurrency limit, one pacing interval and one circuit per connector.
 *
 * It fails CLOSED: if coordination is unavailable (no Redis, Noop adapter, Redis error) no supplier call is allowed, because an
 * unbounded burst against a shared credential is worse than a refused call. Failure counting is approximate (read-modify-write
 * on the cache); the circuit opening a call or two late is acceptable, the concurrency and pacing limits are atomic.
 */
export interface GateCoordination { acquire(key: string, ttlMs: number): Promise<{ key: string; token: string } | null>; release(lease: { key: string; token: string }): Promise<void> }
export interface GateCache { get<T>(key: string): Promise<T | null>; set<T>(key: string, value: T, options: { ttlMs: number }): Promise<void>; delete(key: string): Promise<void> }
export interface SharedGateOptions {
  tenantId: string
  connectorId: string
  maxConcurrent?: number
  /** Minimum gap between call starts across all workers. */
  minIntervalMs?: number
  /** Upper bound on how long a call may hold a slot (must exceed the transport's overall timeout). */
  slotTtlMs?: number
  failureThreshold?: number
  openMs?: number
}

export class SharedConnectorGate implements ConnectorGate {
  private readonly prefix: string
  constructor(private readonly coordination: GateCoordination, private readonly cache: GateCache, private readonly options: SharedGateOptions) {
    for (const v of [options.tenantId, options.connectorId]) if (!/^[A-Za-z0-9_-]{1,100}$/.test(v)) throw new SupplierCallError('configuration', 'not_sent')
    this.prefix = `fbeds:v1:${options.tenantId}:connector-gate:${options.connectorId}`
  }

  async acquire(_operation: XmlOperation): Promise<(outcome: 'ok' | 'provider_failure' | 'other') => void> {
    const o = this.options
    const failuresKey = `${this.prefix}:failures`
    try {
      const openFor = await this.cache.get<number>(`${this.prefix}:open`)
      if (openFor !== null) throw new SupplierCallError('circuit_open', 'not_sent', Math.max(0, openFor - Date.now()))
      if (o.minIntervalMs) {
        const pace = await this.coordination.acquire(`${this.prefix}:pace`, o.minIntervalMs)
        if (!pace) throw new SupplierCallError('rate_limited', 'not_sent', o.minIntervalMs)
      }
      let lease: { key: string; token: string } | null = null
      for (let slot = 0; slot < (o.maxConcurrent ?? 4) && !lease; slot++) lease = await this.coordination.acquire(`${this.prefix}:slot:${slot}`, o.slotTtlMs ?? 30_000)
      if (!lease) throw new SupplierCallError('busy', 'not_sent')
      const held = lease
      return (outcome) => {
        void (async () => {
          try {
            await this.coordination.release(held)
            if (outcome === 'ok') await this.cache.delete(failuresKey)
            else if (outcome === 'provider_failure') {
              const count = ((await this.cache.get<number>(failuresKey)) ?? 0) + 1
              if (count >= (o.failureThreshold ?? 5)) {
                const openMs = o.openMs ?? 30_000
                await this.cache.set(`${this.prefix}:open`, Date.now() + openMs, { ttlMs: openMs })
                await this.cache.delete(failuresKey)
              } else await this.cache.set(failuresKey, count, { ttlMs: 5 * 60_000 })
            }
          } catch { /* the slot TTL bounds a lost release; bookkeeping failure must not affect the already-finished call */ }
        })()
      }
    } catch (error) {
      if (error instanceof SupplierCallError) throw error
      throw new SupplierCallError('busy', 'not_sent')
    }
  }
}
