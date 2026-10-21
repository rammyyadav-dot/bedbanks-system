import { Injectable, Optional, ServiceUnavailableException } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import { NarrowRoleDatabase } from '../supply/narrow-role-database'

export const SUPPLIER_INGEST_UNAVAILABLE = 'SUPPLIER_INGEST_UNAVAILABLE'
const UNAVAILABLE = 'Supplier ingestion is not available: the supplier ingestion database role is not configured or lacks a grant. See ADR 0079.'

/**
 * The connection of the narrow ingestion role in `database/supplier-ingest-role.ts` (ADR 0079). Ingestion writes run here, as that role, and never fall back to the HTTP client:
 * the strict API runtime role has no grant on the ingestion tables, and "not writable" must never become "written with a broader principal".
 */
@Injectable()
export class SupplierIngestDatabase extends NarrowRoleDatabase {
  constructor(@Optional() env?: Record<string, string | undefined>) {
    super(env ?? process.env, { urlKey: 'SUPPLIER_INGEST_DATABASE_URL', label: 'Supplier ingestion', unavailable: { message: UNAVAILABLE, code: SUPPLIER_INGEST_UNAVAILABLE } })
  }

  /** The base class would open a connection from `DATABASE_URL` when its own credential is unset; an unconfigured ingestion refuses before any connection is made. */
  override async withTenant<T>(tenantId: string, work: (tx: Prisma.TransactionClient) => Promise<T>, call?: { timeoutMs?: number }): Promise<T> {
    if (!this.configured()) throw new ServiceUnavailableException({ message: UNAVAILABLE, code: SUPPLIER_INGEST_UNAVAILABLE })
    return super.withTenant(tenantId, work, call)
  }
}
