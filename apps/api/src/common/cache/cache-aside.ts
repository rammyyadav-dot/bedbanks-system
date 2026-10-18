import type { CachePort } from './cache.port'

export interface CacheAsideStats {
  hits: number
  misses: number
  /** Cache read/write/validation faults that fell through to the loader. */
  cacheFaults: number
  /** Callers that shared an in-flight load instead of issuing their own. */
  coalesced: number
}

export interface CacheAsideOptions<T> {
  /** Rejects a cached value that no longer matches the expected shape; it is deleted and reloaded. */
  accept?: (value: unknown) => value is T
  /** 0..0.5. Spreads expiry so entries written together do not all miss together. Default 0.1. */
  jitterRatio?: number
}

/**
 * Cache-aside for STATIC, non-authoritative reads (hotel content, facets, destinations).
 *
 * Policy, stated explicitly (CLAUDE.md invariant 5): a cache fault falls through to the authoritative loader, so a Redis outage costs
 * latency, never correctness. A loader fault is NOT swallowed; it propagates to the caller. Never use this for rates, availability,
 * wallet, booking or any value that authorizes an allocation.
 */
export class CacheAside {
  private readonly inflight = new Map<string, Promise<unknown>>()
  private readonly counters: CacheAsideStats = { hits: 0, misses: 0, cacheFaults: 0, coalesced: 0 }

  constructor(private readonly cache: CachePort) {}

  async read<T>(key: string, ttlMs: number, load: () => Promise<T>, options: CacheAsideOptions<T> = {}): Promise<T> {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error('A bounded positive cache TTL is required')
    const shared = this.inflight.get(key)
    if (shared) { this.counters.coalesced += 1; return shared as Promise<T> }

    const flight = this.fill(key, ttlMs, load, options).finally(() => this.inflight.delete(key))
    this.inflight.set(key, flight)
    return flight
  }

  async invalidate(key: string): Promise<void> {
    try { await this.cache.delete(key) } catch { this.counters.cacheFaults += 1 }
  }

  stats(): Readonly<CacheAsideStats> {
    return { ...this.counters }
  }

  private async fill<T>(key: string, ttlMs: number, load: () => Promise<T>, options: CacheAsideOptions<T>): Promise<T> {
    const cached = await this.lookup<T>(key, options)
    if (cached !== null) { this.counters.hits += 1; return cached }

    this.counters.misses += 1
    const value = await load()
    if (value !== null && value !== undefined) {
      try { await this.cache.set(key, value, { ttlMs: this.jittered(ttlMs, options.jitterRatio) }) } catch { this.counters.cacheFaults += 1 }
    }
    return value
  }

  private async lookup<T>(key: string, options: CacheAsideOptions<T>): Promise<T | null> {
    let raw: unknown
    try { raw = await this.cache.get<unknown>(key) } catch { this.counters.cacheFaults += 1; return null }
    if (raw === null || raw === undefined) return null
    if (options.accept && !options.accept(raw)) {
      this.counters.cacheFaults += 1
      await this.invalidate(key)
      return null
    }
    return raw as T
  }

  private jittered(ttlMs: number, ratio = 0.1): number {
    const bounded = Math.min(Math.max(ratio, 0), 0.5)
    const factor = 1 + (Math.random() * 2 - 1) * bounded
    return Math.max(1, Math.round(ttlMs * factor))
  }
}
