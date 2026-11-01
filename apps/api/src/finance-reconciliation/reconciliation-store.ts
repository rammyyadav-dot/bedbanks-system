import { Injectable, Optional } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import { PrismaService } from '../database/prisma.service'
import { NarrowRoleDatabase } from '../supply/narrow-role-database'

const UNAVAILABLE = 'Finance reconciliation is not available: the reconciliation database role is not configured or lacks a grant. See ADR 0070.'

/**
 * The connection of the narrow reconciliation role in `database/reconciliation-role.ts` (ADR 0070). Isolation is left at the default: every write is a
 * conditional update or an insert guarded by a unique key, so concurrent callers are serialized by the database, not by the isolation level.
 */
@Injectable()
export class ReconciliationDatabase extends NarrowRoleDatabase {
  constructor(@Optional() env?: Record<string, string | undefined>) {
    super(env ?? process.env, { urlKey: 'FINANCE_RECONCILIATION_DATABASE_URL', label: 'Finance reconciliation', unavailable: { message: UNAVAILABLE, code: 'FINANCE_RECONCILIATION_UNAVAILABLE' } })
  }

  /** Tenants with a queued or abandoned run: ids only, from the SECURITY DEFINER function the role may execute. */
  dueTenantIds(): Promise<string[]> {
    return this.onClient(async (client) => (await client.$queryRaw<Array<{ tenant_id: string }>>`SELECT fbeds_reconciliation_due_tenants() AS tenant_id`).map((r) => r.tenant_id))
  }
}

/**
 * Where reconciliation reads and writes. When `FINANCE_RECONCILIATION_DATABASE_URL` is set (and differs from `DATABASE_URL`) everything runs as the narrow
 * role and never falls back. When it is not set the HTTP client is used, exactly like the other finance-gated paths: a strict runtime login is then refused by
 * the database itself with a typed 403, and an owner connection in a disposable environment works.
 */
@Injectable()
export class ReconciliationStore {
  constructor(private readonly prisma: PrismaService, @Optional() private readonly narrow?: ReconciliationDatabase) {}

  private get viaRole(): ReconciliationDatabase | null { return this.narrow?.configured() ? this.narrow : null }

  withTenant<T>(tenantId: string, work: (tx: Prisma.TransactionClient) => Promise<T>, options?: { timeoutMs?: number }): Promise<T> {
    const role = this.viaRole
    return role ? role.withTenant(tenantId, work, options) : this.prisma.withTenant(tenantId, work, options)
  }

  async dueTenantIds(): Promise<string[]> {
    const role = this.viaRole
    if (role) return role.dueTenantIds()
    return (await this.prisma.$queryRaw<Array<{ tenant_id: string }>>`SELECT fbeds_reconciliation_due_tenants() AS tenant_id`).map((r) => r.tenant_id)
  }
}
