import { Injectable, Optional, ServiceUnavailableException } from '@nestjs/common'
import type { PrismaService } from '../database/prisma.service'
import { NarrowRoleDatabase } from '../supply/narrow-role-database'

export const BOOKING_EXECUTION_UNAVAILABLE = 'BOOKING_EXECUTION_UNAVAILABLE'
const MESSAGE = 'Booking is not available: the booking execution database role is not configured.'

/**
 * The connection that completes an agent booking (ADR 0113), as the narrow role in `database/booking-execution-role.ts`.
 *
 * When `BOOKING_EXECUTION_DATABASE_URL` is set and differs from `DATABASE_URL`, hold, prebook, confirm, cancel, documents
 * and the ledger entries inside those transactions run here. A configured connection never falls back to the HTTP client.
 */
@Injectable()
export class BookingExecutionDatabase extends NarrowRoleDatabase {
  constructor(@Optional() env?: Record<string, string | undefined>) {
    super(env ?? process.env, { urlKey: 'BOOKING_EXECUTION_DATABASE_URL', label: 'Booking execution', unavailable: { message: MESSAGE, code: BOOKING_EXECUTION_UNAVAILABLE } })
  }
}

export type BookingTenantDb = Pick<PrismaService, 'withTenant'>

/**
 * The database an agent booking service must use. A configured execution role wins. With booking or servicing enabled and
 * no execution credential, the call is refused: the strict runtime role cannot finish the transaction, and the owner login
 * is not a substitute.
 */
export function bookingTenantDb(primary: BookingTenantDb, execution: Pick<BookingExecutionDatabase, 'configured' | 'withTenant'> | undefined, env: Record<string, string | undefined> = process.env): BookingTenantDb {
  if (execution?.configured()) return execution
  if (env.BOOKING_ENABLED === 'true' || env.BOOKING_SERVICING_ENABLED === 'true') {
    throw new ServiceUnavailableException({ message: MESSAGE, code: BOOKING_EXECUTION_UNAVAILABLE })
  }
  return primary
}
