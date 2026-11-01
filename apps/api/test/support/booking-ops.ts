import { randomBytes } from 'crypto'
import { BOOKING_OPS_LOGIN_ROLE, provisionBookingOpsRole } from '../../src/database/booking-ops-role'

/**
 * Gives an HTTP e2e suite the booking module's own limited database role (ADR 0039), on the disposable database the suite already uses.
 * It provisions `fbeds_booking_ops` with a random password and sets `BOOKING_OPS_DATABASE_URL`, which the module reads when it first connects.
 * Without this the Admin booking routes correctly answer 503 (not readable), so every suite that exercises them calls it before building the app.
 * Returns a function that restores the environment.
 */
export async function enableBookingOps(owner: { $executeRawUnsafe(query: string): Promise<number>; $queryRawUnsafe<T = unknown>(query: string): Promise<T> }): Promise<() => void> {
  const ownerUrl = process.env.DATABASE_URL
  if (!ownerUrl) throw new Error('DATABASE_URL is required')
  const password = `bo-${randomBytes(20).toString('hex')}`
  await provisionBookingOpsRole(owner, { password })
  const url = new URL(ownerUrl); url.username = BOOKING_OPS_LOGIN_ROLE; url.password = password
  const previous = process.env.BOOKING_OPS_DATABASE_URL
  process.env.BOOKING_OPS_DATABASE_URL = url.toString()
  return () => { if (previous === undefined) delete process.env.BOOKING_OPS_DATABASE_URL; else process.env.BOOKING_OPS_DATABASE_URL = previous }
}
