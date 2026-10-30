import type { CoordinationPort } from './cache.port'

export type ExclusiveOutcome<T> = { ran: true; result: T; coordinated: boolean } | { ran: false }

/**
 * Runs `work` on at most one API instance at a time when Redis is available (ADR 0106). It is an efficiency guard, never a correctness one: PostgreSQL stays
 * authoritative and every job it guards is idempotent, so
 *  - no coordination configured -> run;
 *  - Redis unreachable or erroring -> run (fail open; `onUnavailable` lets the caller log the error name);
 *  - lease held by another instance -> skip this pass;
 *  - the lease expires mid-pass -> another instance may overlap, which is safe by the same idempotency.
 * The lease is always released, and only by its owner (the adapter compares the token).
 */
export async function runExclusive<T>(coordination: CoordinationPort | null, key: string, ttlMs: number, work: () => Promise<T>, onUnavailable?: (error: unknown) => void): Promise<ExclusiveOutcome<T>> {
  if (!coordination) return { ran: true, result: await work(), coordinated: false }
  let lease: Awaited<ReturnType<CoordinationPort['acquire']>>
  try { lease = await coordination.acquire(key, ttlMs) } catch (error) {
    onUnavailable?.(error)
    return { ran: true, result: await work(), coordinated: false }
  }
  if (!lease) return { ran: false }
  try { return { ran: true, result: await work(), coordinated: true } } finally {
    await coordination.release(lease).catch((error) => onUnavailable?.(error))
  }
}
