import { ServiceUnavailableException } from '@nestjs/common'
import { OPERATIONS_READ_DENIED } from '@bedbanks/contracts'
import { BookingOpsDatabase } from './booking-ops-database'

const code = async (work: () => Promise<unknown>) => { try { await work(); return null } catch (error) { return error instanceof ServiceUnavailableException ? (error.getResponse() as { code: string }).code : `other:${(error as Error).message}` } }

describe('booking module connection (ADR 0039)', () => {
  it('BO-10: with no BOOKING_OPS_DATABASE_URL every read is the sanitized not-readable state, never an empty result or the API role', async () => {
    const db = new BookingOpsDatabase({ DATABASE_URL: 'postgresql://api@h/db' })
    expect(db.configured()).toBe(false)
    expect(await code(() => db.withTenant('t1', async () => 'would-have-read'))).toBe(OPERATIONS_READ_DENIED)
  })

  it('BO-11: a URL equal to the HTTP credential is refused (the module must not run as the API role)', async () => {
    const url = 'postgresql://api:secret@h/db'
    const db = new BookingOpsDatabase({ DATABASE_URL: url, BOOKING_OPS_DATABASE_URL: url })
    expect(db.configured()).toBe(false)
    expect(await code(() => db.withTenant('t1', async () => 1))).toBe(OPERATIONS_READ_DENIED)
  })

  it('BO-12: a distinct URL counts as configured, and the not-readable message never carries the URL or a password', async () => {
    const db = new BookingOpsDatabase({ DATABASE_URL: 'postgresql://api@h/db', BOOKING_OPS_DATABASE_URL: 'postgresql://booking_ops:topsecret@127.0.0.1:1/none' })
    expect(db.configured()).toBe(true)
    let message = ''
    try { await db.withTenant('t1', async (tx) => tx.$queryRaw`SELECT 1`) } catch (error) { message = JSON.stringify((error as ServiceUnavailableException).getResponse()) }
    expect(message).toContain(OPERATIONS_READ_DENIED)
    expect(message).not.toMatch(/topsecret|booking_ops|127\.0\.0\.1/)
    await db.onModuleDestroy()
  })

  it('BO-13: a tenant context is required', async () => {
    const db = new BookingOpsDatabase({ DATABASE_URL: 'postgresql://api@h/db', BOOKING_OPS_DATABASE_URL: 'postgresql://x:y@127.0.0.1:1/none' })
    expect(await code(() => db.withTenant('', async () => 1))).toBe('other:A normalized tenant context is required')
    await db.onModuleDestroy()
  })
})
