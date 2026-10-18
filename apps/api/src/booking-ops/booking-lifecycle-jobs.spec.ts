import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { actionBlock, availableActions, BOOKING_ACTION_RULES, BOOKING_ACTIONS, BOOKING_CLOSABLE_STATUSES, BOOKING_STATUSES, CLOSE_ACTION_BY_STATUS, parseCloseAfterDays } from '@bedbanks/contracts'
import { BookingLifecycleJobs, checkoutCutoffDay } from './booking-lifecycle-jobs.service'
import type { BookingOpsDatabase } from './booking-ops-database'

const db = (configured = true) => ({ configured: () => configured, checkoutDueTenants: jest.fn().mockResolvedValue([]), closeDueTenants: jest.fn().mockResolvedValue([]) }) as unknown as BookingOpsDatabase
const resolver = { resolve: () => null }

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
    await expect(new BookingLifecycleJobs(d, {}).runOnce(() => new Date('2030-06-10T12:00:00Z'))).resolves.toEqual({ checkedOut: 0, closed: 0, skipped: 0, failed: 0 })
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

  it('LJ-06: the dispute window is read from one setting: unset means no close at all; a bad value is an error, never a guess', () => {
    expect(parseCloseAfterDays(undefined)).toEqual({ ok: true, days: null }); expect(parseCloseAfterDays('')).toEqual({ ok: true, days: null }); expect(parseCloseAfterDays('  ')).toEqual({ ok: true, days: null })
    expect(parseCloseAfterDays('30')).toEqual({ ok: true, days: 30 }); expect(parseCloseAfterDays(' 1 ')).toEqual({ ok: true, days: 1 }); expect(parseCloseAfterDays('365')).toEqual({ ok: true, days: 365 })
    for (const bad of ['0', '366', '-5', '30.5', '1e2', 'thirty', '30 days', '0030x']) expect(parseCloseAfterDays(bad).ok).toBe(false)
  })

  it('LJ-07: the job refuses to start with a bad window, or with a window but no supplier resolver to judge operations cases with; with no window it starts and never closes', async () => {
    const on = { BOOKING_LIFECYCLE_JOB_ENABLED: 'true' }
    expect(() => new BookingLifecycleJobs(db(), { ...on, BOOKING_CLOSE_AFTER_DAYS: '0' }, resolver).onModuleInit()).toThrow(/BOOKING_CLOSE_AFTER_DAYS/)
    expect(() => new BookingLifecycleJobs(db(), { ...on, BOOKING_CLOSE_AFTER_DAYS: '30' }).onModuleInit()).toThrow(/supplier resolver/)
    const d = db(); const unset = new BookingLifecycleJobs(d, on, resolver); unset.onModuleInit()
    await unset.runOnce(() => new Date('2030-06-10T12:00:00Z')); unset.onModuleDestroy()
    expect(d.closeDueTenants).not.toHaveBeenCalled()
    const d2 = db(); const set = new BookingLifecycleJobs(d2, { ...on, BOOKING_CLOSE_AFTER_DAYS: '30' }, resolver); set.onModuleInit()
    await set.runOnce(() => new Date('2030-06-10T12:00:00.000Z')); set.onModuleDestroy()
    expect(d2.closeDueTenants).toHaveBeenCalledWith(new Date('2030-05-11T12:00:00.000Z'))
  })

  it('LJ-08: the close actions: one system-only action per closable status, each keeps the status and sets the lock; people are never offered them; nothing else can be closed', () => {
    expect(Object.keys(CLOSE_ACTION_BY_STATUS).sort()).toEqual([...BOOKING_CLOSABLE_STATUSES].sort())
    for (const status of BOOKING_CLOSABLE_STATUSES) {
      const rule = BOOKING_ACTION_RULES[CLOSE_ACTION_BY_STATUS[status]!]
      expect(rule).toMatchObject({ from: status, to: status, actors: ['SYSTEM'], permissions: [], locks: true })
      expect(actionBlock(rule, { status, closedAt: null, isRefundable: null, checkIn: null }, new Date())).toBeNull()
      expect(actionBlock(rule, { status, closedAt: '2030-01-01T00:00:00Z', isRefundable: null, checkIn: null }, new Date())).toBe('CLOSED')
      for (const level of ['OPERATOR', 'AGENCY'] as const) expect(availableActions({ status, closedAt: null, isRefundable: null, checkIn: null }, level, new Set(['booking.rebook', 'booking.cancel', 'booking.amend', 'booking.no-show.mark']), new Date()).map((a) => a.action)).not.toContain(CLOSE_ACTION_BY_STATUS[status])
    }
    for (const status of BOOKING_STATUSES.filter((st) => !(BOOKING_CLOSABLE_STATUSES as readonly string[]).includes(st))) expect(CLOSE_ACTION_BY_STATUS[status]).toBeUndefined()
    expect(BOOKING_ACTIONS.filter((a) => BOOKING_ACTION_RULES[a].locks).sort()).toEqual(['close', ...Object.values(CLOSE_ACTION_BY_STATUS)].sort())
  })

  it('LJ-09: wiring. The close pass locks only through transitionBooking, judges "still needs a person" with the queue\'s own ruleset and the penalty state, and never touches money', () => {
    const src = readFileSync(join(__dirname, 'booking-lifecycle-jobs.service.ts'), 'utf8')
    const close = src.slice(src.indexOf('private async closeTenant'))
    expect(close).toContain('evaluateBookingOps(facts, now, policy).inQueue'); expect(close).toContain("penalty.state !== 'QUOTED'"); expect(close).toContain('FOR UPDATE'); expect(close).toContain('transitionBooking(')
    expect(close).not.toMatch(/closedAt\s*:\s*(new Date|now)/); expect(src).not.toMatch(/\.booking\.(update|updateMany|upsert)\(|emitFinance|ledgerEntry|wallet/i)
    const sql = readFileSync(join(__dirname, '../../prisma/migrations/202611260001_booking_close_job/migration.sql'), 'utf8')
    const statements = sql.split('\n').filter((l) => !l.trim().startsWith('--') && l.trim() !== '').join(' ')
    expect(statements).toMatch(/SECURITY DEFINER/); expect(statements).toMatch(/REVOKE ALL ON FUNCTION "fbeds_booking_close_due_tenants"\(TIMESTAMP\) FROM PUBLIC/); expect(statements).not.toMatch(/GRANT|DROP |ALTER TABLE|DELETE|UPDATE /)
  })
})
