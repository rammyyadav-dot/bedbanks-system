import { Injectable, Optional, ServiceUnavailableException } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import { BOOKING_PRIVILEGE_BOUNDARY_UNAVAILABLE } from '@bedbanks/contracts'
import { NarrowRoleDatabase } from '../supply/narrow-role-database'

export const BOOKING_TRANSACTION_URL_KEY = 'BOOKING_TRANSACTION_DATABASE_URL'

const UNAVAILABLE = 'Booking mutations are unavailable until the booking transaction database role is configured. BOOKING_ENABLED does not grant them to the API role.'

/**
 * What an Agent booking service needs from its database. `PrismaService` satisfies it, so a test can still pass the owner client it built.
 * The Nest application injects `BookingTransactionDatabase` instead, and that class never opens `DATABASE_URL`.
 */
export interface BookingTransactionClient {
  withTenant<T>(tenantId: string, work: (tx: Prisma.TransactionClient) => Promise<T>, options?: { isolationLevel?: Prisma.TransactionIsolationLevel; timeoutMs?: number }): Promise<T>
}

/**
 * True when the booking transaction credential is set and is not the HTTP API credential.
 * `BOOKING_ENABLED=true` without this is not a completed privilege boundary (ADR 0101, ADR 0113).
 */
export function bookingTransactionConfigured(env: Record<string, string | undefined> = process.env): boolean {
  const url = env[BOOKING_TRANSACTION_URL_KEY]
  return Boolean(url) && url !== env.DATABASE_URL
}

/**
 * The connection of `fbeds_booktx_ops` (`database/booking-transaction-role.ts`). Agent hold, prebook, confirm, cancel, document and reconciliation
 * work runs here. An unset or reused URL refuses before any connection is opened: the strict API role has no booking or finance write, and a missing
 * grant must not become a write as that role or as the owner.
 */
@Injectable()
export class BookingTransactionDatabase extends NarrowRoleDatabase implements BookingTransactionClient {
  constructor(@Optional() env?: Record<string, string | undefined>) {
    super(env ?? process.env, {
      urlKey: BOOKING_TRANSACTION_URL_KEY,
      label: 'Booking transaction',
      unavailable: { message: UNAVAILABLE, code: BOOKING_PRIVILEGE_BOUNDARY_UNAVAILABLE },
    })
  }

  override async withTenant<T>(tenantId: string, work: (tx: Prisma.TransactionClient) => Promise<T>, options?: { isolationLevel?: Prisma.TransactionIsolationLevel; timeoutMs?: number }): Promise<T> {
    if (!this.configured()) throw new ServiceUnavailableException({ message: UNAVAILABLE, code: BOOKING_PRIVILEGE_BOUNDARY_UNAVAILABLE })
    return super.withTenant(tenantId, work, options?.timeoutMs !== undefined || options?.isolationLevel !== undefined ? { timeoutMs: options?.timeoutMs } : undefined)
  }
}
