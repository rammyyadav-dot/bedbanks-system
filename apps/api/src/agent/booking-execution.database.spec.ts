import { ServiceUnavailableException } from '@nestjs/common'
import { PrismaService } from '../database/prisma.service'
import { BOOKING_EXECUTION_UNAVAILABLE, BookingExecutionDatabase, bookingTenantDb } from './booking-execution.database'

describe('BookingExecutionDatabase', () => {
  it('is configured only by a URL that differs from DATABASE_URL', () => {
    expect(new BookingExecutionDatabase({}).configured()).toBe(false)
    expect(new BookingExecutionDatabase({ BOOKING_EXECUTION_DATABASE_URL: 'postgresql://exec@h/db', DATABASE_URL: 'postgresql://exec@h/db' }).configured()).toBe(false)
    expect(new BookingExecutionDatabase({ BOOKING_EXECUTION_DATABASE_URL: 'postgresql://exec@h/db', DATABASE_URL: 'postgresql://api@h/db' }).configured()).toBe(true)
  })

  it('answers an unreachable credential with a sanitized 503 and does not fall back', async () => {
    const db = new BookingExecutionDatabase({ BOOKING_EXECUTION_DATABASE_URL: 'postgresql://exec:secretsecretsecretsecretsecret123@127.0.0.1:1/db', DATABASE_URL: 'postgresql://api@h/db' })
    const error = await db.withTenant('tenant', async () => 'must not run').catch((e: unknown) => e)
    await db.onModuleDestroy()
    expect(error).toBeInstanceOf(ServiceUnavailableException)
    const body = JSON.stringify((error as ServiceUnavailableException).getResponse())
    expect(body).toContain(BOOKING_EXECUTION_UNAVAILABLE)
    expect(body).not.toMatch(/secretsecret|127\.0\.0\.1|postgresql:/)
  })

  it('a rejected credential is the same sanitized 503 on every attempt', async () => {
    const spy = jest.spyOn(PrismaService.prototype, 'assertRestrictedRuntimeRole').mockRejectedValue(new Error('password authentication failed for user "fbeds_booking_exec_ops" secretsecretsecret'))
    try {
      const db = new BookingExecutionDatabase({ BOOKING_EXECUTION_DATABASE_URL: 'postgresql://exec:secretsecretsecretsecretsecret123@127.0.0.1:1/db', DATABASE_URL: 'postgresql://api@h/db' })
      for (const attempt of [1, 2]) {
        const error = await db.withTenant('tenant', async () => 'must not run').catch((e: unknown) => e)
        expect(error).toBeInstanceOf(ServiceUnavailableException)
        const body = JSON.stringify((error as ServiceUnavailableException).getResponse())
        expect(body).toContain(BOOKING_EXECUTION_UNAVAILABLE)
        expect(body).not.toMatch(/secretsecret|fbeds_booking_exec_ops|127\.0\.0\.1|postgresql:|password/)
        expect(spy).toHaveBeenCalledTimes(attempt)
      }
      await db.onModuleDestroy()
    } finally { spy.mockRestore() }
  })
})

describe('bookingTenantDb', () => {
  const primary = { withTenant: async <T>() => 'primary' as T }
  const execution = { configured: () => true, withTenant: async <T>() => 'execution' as T }
  const absent = { configured: () => false, withTenant: async <T>() => 'execution' as T }

  it('uses the execution role whenever that credential is configured', () => {
    expect(bookingTenantDb(primary, execution, {})).toBe(execution)
    expect(bookingTenantDb(primary, execution, { BOOKING_ENABLED: 'true' })).toBe(execution)
  })

  it('refuses the owner and the strict runtime role when booking or servicing is on and the execution role is not configured', () => {
    for (const env of [{ BOOKING_ENABLED: 'true' }, { BOOKING_SERVICING_ENABLED: 'true' }]) {
      expect(() => bookingTenantDb(primary, undefined, env)).toThrow(ServiceUnavailableException)
      try { bookingTenantDb(primary, absent, env) } catch (error) {
        expect(error).toBeInstanceOf(ServiceUnavailableException)
        expect(JSON.stringify((error as ServiceUnavailableException).getResponse())).toContain(BOOKING_EXECUTION_UNAVAILABLE)
      }
    }
  })

  it('keeps the injected client only while booking stays off and no execution credential is set', () => {
    expect(bookingTenantDb(primary, undefined, {})).toBe(primary)
    expect(bookingTenantDb(primary, absent, { BOOKING_ENABLED: 'false' })).toBe(primary)
  })
})
