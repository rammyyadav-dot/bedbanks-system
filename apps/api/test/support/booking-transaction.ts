import { randomBytes } from 'crypto'
import { deprovisionBooktxRole, provisionBooktxRole } from '../../src/database/booking-transaction-role'

/** Use the real restricted booking principal on the suite's disposable database. */
export async function enableBookingTransaction(owner: { $executeRawUnsafe(query: string): Promise<number>; $queryRawUnsafe<T = unknown>(query: string): Promise<T> }): Promise<() => Promise<void>> {
  const ownerUrl = process.env.DATABASE_URL
  if (!ownerUrl) throw new Error('DATABASE_URL is required')
  const loginRole = `fbeds_booktx_t${randomBytes(4).toString('hex')}`
  const password = randomBytes(24).toString('hex')
  await provisionBooktxRole(owner, { loginRole, password })
  const url = new URL(ownerUrl); url.username = loginRole; url.password = password
  const previous = process.env.BOOKING_TRANSACTION_DATABASE_URL
  process.env.BOOKING_TRANSACTION_DATABASE_URL = url.toString()
  return async () => {
    if (previous === undefined) delete process.env.BOOKING_TRANSACTION_DATABASE_URL
    else process.env.BOOKING_TRANSACTION_DATABASE_URL = previous
    // Group membership affects invoker-rights triggers even in later suites' owner fixtures.
    // Only call after the application pools close; this database is disposable.
    await deprovisionBooktxRole(owner, loginRole, { dropGroup: true })
  }
}
