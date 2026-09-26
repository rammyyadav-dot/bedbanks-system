export interface CacheWriteOptions { ttlMs: number }

/** Coordination/performance only. Cached values never authorize inventory allocation. */
export interface CachePort {
  get<T>(key: string): Promise<T | null>
  set<T>(key: string, value: T, options: CacheWriteOptions): Promise<void>
  delete(key: string): Promise<void>
}

export interface LockLease { key: string; token: string }

/** Best-effort distributed coordination. Failure must never change inventory truth. */
export interface CoordinationPort {
  acquire(key: string, ttlMs: number): Promise<LockLease | null>
  release(lease: LockLease): Promise<void>
}

export const CACHE_PORT = Symbol('CACHE_PORT')
export const COORDINATION_PORT = Symbol('COORDINATION_PORT')

export class NoopCache implements CachePort {
  async get<T>(_key: string): Promise<T | null> { return null }
  async set<T>(_key: string, _value: T, options: CacheWriteOptions): Promise<void> {
    if (!Number.isSafeInteger(options.ttlMs) || options.ttlMs <= 0) throw new Error('A bounded positive cache TTL is required')
  }
  async delete(_key: string): Promise<void> {}
}

export class NoopCoordination implements CoordinationPort {
  async acquire(_key: string, _ttlMs: number): Promise<LockLease | null> { return null }
  async release(_lease: LockLease): Promise<void> {}
}

export function tenantCacheKey(tenantId: string, namespace: string, identity: string, version = 'v1'): string {
  for (const value of [tenantId, namespace, identity, version]) {
    if (!value || value.trim() !== value || value.includes(':')) throw new Error('Invalid cache key component')
  }
  return `fbeds:${version}:${tenantId}:${namespace}:${identity}`
}
