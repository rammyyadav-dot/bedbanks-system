import { Injectable, Optional, ServiceUnavailableException } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import { NarrowRoleDatabase } from '../supply/narrow-role-database'

export const SUPPLIER_PROMOTION_UNAVAILABLE = 'SUPPLIER_PROMOTION_UNAVAILABLE'
const UNAVAILABLE = 'Supplier promotion is not available: the supplier promotion database role is not configured or lacks a grant. See ADR 0084.'

/**
 * The connection of the narrow promotion role in `database/supplier-promotion-role.ts` (ADR 0084). Promotion writes run here, as that role, and never fall back to the HTTP client: the strict
 * API runtime role has no grant on the tables promotion writes, and "not writable" must never become "written with a broader principal".
 */
@Injectable()
export class SupplierPromotionDatabase extends NarrowRoleDatabase {
  constructor(@Optional() env?: Record<string, string | undefined>) {
    super(env ?? process.env, { urlKey: 'SUPPLIER_PROMOTION_DATABASE_URL', label: 'Supplier promotion', unavailable: { message: UNAVAILABLE, code: SUPPLIER_PROMOTION_UNAVAILABLE } })
  }

  /** The base class would open a connection from `DATABASE_URL` when its own credential is unset; an unconfigured promotion refuses before any connection is made. */
  override async withTenant<T>(tenantId: string, work: (tx: Prisma.TransactionClient) => Promise<T>, call?: { timeoutMs?: number }): Promise<T> {
    if (!this.configured()) throw new ServiceUnavailableException({ message: UNAVAILABLE, code: SUPPLIER_PROMOTION_UNAVAILABLE })
    return super.withTenant(tenantId, work, call)
  }
}
