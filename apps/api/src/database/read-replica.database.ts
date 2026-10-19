import { Injectable, Optional } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import { READ_REPLICA_UNAVAILABLE } from '@bedbanks/contracts'
import { NarrowRoleDatabase } from '../supply/narrow-role-database'

export const REPLICA_DEFAULT_TIMEOUT_MS = 15_000
const UNAVAILABLE = 'The reporting replica is unavailable. Try again shortly. See ADR 0074.'

/**
 * Analytical reads on a Neon read-only compute of the same branch (ADR 0074). `BOOKING_OPS_READ_REPLICA_URL` is the booking login's credential against the
 * replica endpoint, so grants, row-level security and the restricted-role identity check are exactly the primary's; only the host differs.
 *
 * - Not configured: `configured()` is false and callers use the primary. That is an explicit deployment choice, not an error path.
 * - Configured but unusable (refused, unreachable, role violation): a typed 503 `READ_REPLICA_UNAVAILABLE`. It never falls back to the primary, because a
 *   replica outage must not turn into the reporting load it was deployed to move; and it never returns an empty result (CLAUDE.md invariant 5).
 * - Every transaction is `READ ONLY` with a statement timeout, so a mistaken write is refused by PostgreSQL even if the endpoint were a primary.
 *
 * Replica reads can trail the primary by a short replication delay. Use it only for reports and exports that tolerate that. Never for a read that precedes
 * a decision (booking, hold, wallet, ledger) or that must show the caller's own just-written change.
 */
@Injectable()
export class BookingOpsReadReplica extends NarrowRoleDatabase {
  constructor(@Optional() env?: Record<string, string | undefined>) {
    super(env ?? process.env, { urlKey: 'BOOKING_OPS_READ_REPLICA_URL', label: 'Booking reporting replica', unavailable: { message: UNAVAILABLE, code: READ_REPLICA_UNAVAILABLE } })
    this.environment = env ?? process.env
  }

  private readonly environment: Record<string, string | undefined>

  /** A replica endpoint that equals a primary credential would silently put reporting load back on the primary, so it counts as not configured. */
  override configured(): boolean {
    const url = this.environment.BOOKING_OPS_READ_REPLICA_URL
    return Boolean(url) && url !== this.environment.DATABASE_URL && url !== this.environment.BOOKING_OPS_DATABASE_URL
  }

  /** Tenant-scoped, read-only, time-boxed. The caller has authenticated the user and checked the permission. */
  readTenant<T>(tenantId: string, work: (tx: Prisma.TransactionClient) => Promise<T>, options?: { timeoutMs?: number }): Promise<T> {
    const timeoutMs = options?.timeoutMs ?? REPLICA_DEFAULT_TIMEOUT_MS
    return this.withTenant(tenantId, async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`
      await tx.$executeRaw`SELECT set_config('statement_timeout', ${`${timeoutMs}ms`}, true)`
      return work(tx)
    }, { timeoutMs: timeoutMs + 5_000 })
  }
}
