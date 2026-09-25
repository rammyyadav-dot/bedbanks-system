export interface LockOptions { ttlMs: number; waitTimeoutMs: number; retryDelayMs: number }
export interface LockHandle {
  readonly fencingToken: bigint
  extend(ttlMs: number): Promise<void>
  release(): Promise<void>
}
export interface DistributedLock {
  acquire(key: string, options: LockOptions): Promise<LockHandle>
}
export const DISTRIBUTED_LOCK = Symbol('DISTRIBUTED_LOCK')

// No runtime provider is registered until infrastructure ownership, fencing
// semantics and secret references are approved. PostgreSQL remains authoritative.
