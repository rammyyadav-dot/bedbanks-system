import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BOOKING_ACTION_RULES } from '@bedbanks/contracts'
import { BookingLifecycleJobs, checkoutCutoffDay } from './booking-lifecycle-jobs.service'
import type { BookingOpsDatabase } from './booking-ops-database'

const db = (configured = true) => ({ configured: () => configured, checkoutDueTenants: jest.fn().mockResolvedValue([]) }) as unknown as BookingOpsDatabase

describe('booking lifecycle jobs: Checked-out (ADR 0039, Phase 6E)', () => {
  it('LJ-01: the cutoff is the UTC day, so a booking is due from the day AFTER its check-out date', () => {
    expect(checkoutCutoffDay(new Date('2030-06-10T00:00:00.000Z'))).toBe('2030-06-10')
    expect(checkoutCutoffDay(new Date('2030-06-10T23:59:59.999Z'))).toBe('2030-06-10')
    expect(checkoutCutoffDay(new Date('2030-06-11T00:00:00.000Z'))).toBe('2030-06-11')
  })

  it('LJ-02: it is off unless switched on, and refuses to start without the booking module credential or with a silly interval', () => {
    expect(() => new BookingLifecycleJobs(db(), {}).onModuleInit()).not.toThrow()
    expect(() => new BookingLifecycleJobs(db(false), { BOOKING_LIFECYCLE_JOB_ENABLED: 'true' }).onModuleInit()).toThrow(/BOOKING_OPS_DATABASE_URL/)
    expect(() => new BookingLifecycleJobs(db(), { BOOKING_LIFECYCLE_JOB_ENABLED: 'true', BOOKING_LIFECYCLE_JOB_INTERVAL_MS: '100' }).onModuleInit()).toThrow(/INTERVAL/)
    const job = new BookingLifecycleJobs(db(), { BOOKING_LIFECYCLE_JOB_ENABLED: 'true', BOOKING_LIFECYCLE_JOB_INTERVAL_MS: '60000' })
    job.onModuleInit(); job.onModuleDestroy()
  })

  it('LJ-03: the action it uses is system-only, has no permission a person could hold, and moves Confirmed to Checked out', () => {
    expect(BOOKING_ACTION_RULES.markCheckedOut).toMatchObject({ from: 'CONFIRMED', to: 'CHECKED_OUT', actors: ['SYSTEM'], permissions: [] })
  })

  it('LJ-04: a pass lists tenants through the ids-only function and a failure listing them is contained, not thrown', async () => {
    const d = db(); (d.checkoutDueTenants as jest.Mock).mockRejectedValueOnce(new Error('boom'))
    await expect(new BookingLifecycleJobs(d, {}).runOnce(() => new Date('2030-06-10T12:00:00Z'))).resolves.toEqual({ checkedOut: 0, skipped: 0, failed: 0 })
    const ok = db(); await new BookingLifecycleJobs(ok, {}).runOnce(() => new Date('2030-06-10T12:00:00Z'))
    expect(ok.checkoutDueTenants).toHaveBeenCalledWith('2030-06-10')
  })

  it('LJ-05: wiring. It writes status only through transitionBooking, never directly, and never touches ledger, wallet or finance tables', () => {
    const src = readFileSync(join(__dirname, 'booking-lifecycle-jobs.service.ts'), 'utf8')
    expect(src).toContain("action: 'markCheckedOut'")
    expect(src).not.toMatch(/booking\.(update|updateMany|upsert)\(/)
    expect(src).not.toMatch(/ledger|wallet|bookingFinanceEvent|emitFinance/i)
    const module = readFileSync(join(__dirname, '../admin-operations/admin-operations.module.ts'), 'utf8')
    expect(module).toContain('BookingLifecycleJobs')
    const sql = readFileSync(join(__dirname, '../../prisma/migrations/202611240001_booking_checkout_job/migration.sql'), 'utf8')
    const statements = sql.split('\n').filter((l) => !l.trim().startsWith('--') && l.trim() !== '').join(' ')
    expect(statements).toMatch(/SECURITY DEFINER/); expect(statements).toMatch(/REVOKE ALL ON FUNCTION "fbeds_booking_checkout_due_tenants"\(DATE\) FROM PUBLIC/)
    expect(statements).not.toMatch(/GRANT|DROP |ALTER TABLE|DELETE|UPDATE /)
  })
})
