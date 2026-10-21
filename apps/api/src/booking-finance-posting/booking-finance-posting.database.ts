import { Injectable, Optional, ServiceUnavailableException } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import { BOOKING_FINANCE_POSTING_UNAVAILABLE } from '@bedbanks/contracts'
import { PrismaService } from '../database/prisma.service'
import { NarrowRoleDatabase } from '../supply/narrow-role-database'

const UNAVAILABLE = 'Booking finance posting is not available: the finance posting database role is not configured or lacks a grant. See ADR 0076.'

/**
 * The connection of the narrow finance posting role in `database/finance-posting-role.ts` (ADR 0076). Everything the consumer reads or writes runs here, as that role, and
 * never falls back to the HTTP client: the strict API runtime role has no ledger grant, and "not postable" must never become "posted with a broader principal".
 */
@Injectable()
export class BookingFinancePostingDatabase extends NarrowRoleDatabase {
  constructor(@Optional() env?: Record<string, string | undefined>) {
    super(env ?? process.env, { urlKey: 'BOOKING_FINANCE_POSTING_DATABASE_URL', label: 'Booking finance posting', unavailable: { message: UNAVAILABLE, code: BOOKING_FINANCE_POSTING_UNAVAILABLE } })
  }

  /**
   * The base class would open a connection from `DATABASE_URL` when its own credential is unset. That is exactly the fallback this role exists to forbid (the consumer would then post
   * as whatever principal the API runs as), so an unconfigured consumer refuses before any connection is made.
   */
  override async withTenant<T>(tenantId: string, work: (tx: Prisma.TransactionClient) => Promise<T>, call?: { timeoutMs?: number }): Promise<T> {
    this.assertConfigured()
    return super.withTenant(tenantId, work, call)
  }

  private assertConfigured(): void {
    if (!this.configured()) throw new ServiceUnavailableException({ message: UNAVAILABLE, code: BOOKING_FINANCE_POSTING_UNAVAILABLE })
  }

  /** Tenants with an event the consumer has not finished: ids only, from the SECURITY DEFINER function the role may execute. */
  async dueTenantIds(): Promise<string[]> {
    this.assertConfigured()
    return this.onClient(async (client: PrismaService) => (await client.$queryRaw<Array<{ tenant_id: string }>>`SELECT fbeds_finance_posting_due_tenants() AS tenant_id`).map((r) => r.tenant_id))
  }
}
