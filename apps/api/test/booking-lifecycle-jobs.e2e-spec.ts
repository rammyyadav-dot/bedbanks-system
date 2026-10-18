import { randomBytes } from 'crypto'
import { PrismaClient } from '@prisma/client'
import { BookingOpsDatabase } from '../src/booking-ops/booking-ops-database'
import { BookingLifecycleJobs } from '../src/booking-ops/booking-lifecycle-jobs.service'
import { transitionBooking } from '../src/booking-ops/booking-transition'
import { enableBookingOps } from './support/booking-ops'

jest.setTimeout(240_000)

/** The scheduled Checked-out job (ADR 0039, Phase 6E) against PostgreSQL with the booking module's own limited role and forced RLS. */
describe('Booking lifecycle jobs: Checked-out (PostgreSQL, booking role)', () => {
  const owner = new PrismaClient()
  const suffix = `lj-${Date.now()}-${randomBytes(3).toString('hex')}`
  let tenantA = '', tenantB = '', hotelA = '', hotelB = ''; let restore: () => void = () => undefined; let n = 0
  let database: BookingOpsDatabase; let job: BookingLifecycleJobs
  const NOW = new Date('2030-06-10T09:00:00.000Z')
  const NOW_REAL = () => new Date()
  const day = (offset: number) => new Date(Date.UTC(2030, 5, 10 + offset))

  async function booking(tenant: 'A' | 'B', over: { status?: string; checkOut?: Date | null; closedAt?: Date | string | null } = {}) {
    const tenantId = tenant === 'A' ? tenantA : tenantB; n += 1
    const out = over.checkOut === undefined ? day(-1) : over.checkOut
    const b = await owner.booking.create({ data: { tenantId, reference: `FB-${randomBytes(10).toString('hex').toUpperCase()}`, supplier: 'Supplier One', hotelId: tenant === 'A' ? hotelA : hotelB, status: (over.status ?? 'CONFIRMED') as never,
      currency: 'AED', totalMinor: 100_000n, idempotencyKey: `${suffix}-${n}`, searchSnapshot: {}, supplierRef: `S-${n}`, hotelConfirmationNo: `H-${n}`, checkIn: out === null ? null : new Date(out.getTime() - 4 * 86_400_000), checkOut: out, nights: 4, closedAt: over.closedAt === undefined || over.closedAt === null ? null : new Date(over.closedAt) } })
    await owner.bookingEvent.create({ data: { tenantId, bookingId: b.id, toStatus: (over.status ?? 'CONFIRMED') as never, actorType: 'SYSTEM', reason: 'fixture', payload: { backfill: true } } })
    return b.id
  }
  const status = async (id: string) => (await owner.booking.findUniqueOrThrow({ where: { id } })).status
  const events = (id: string) => owner.bookingEvent.findMany({ where: { bookingId: id, action: 'markCheckedOut' } })

  beforeAll(async () => {
    await owner.$connect()
    tenantA = (await owner.tenant.create({ data: { name: suffix, slug: suffix } })).id; tenantB = (await owner.tenant.create({ data: { name: `${suffix}-b`, slug: `${suffix}-b` } })).id
    hotelA = (await owner.hotel.create({ data: { tenantId: tenantA, name: `${suffix} A`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', timeZone: 'Asia/Dubai' } })).id
    hotelB = (await owner.hotel.create({ data: { tenantId: tenantB, name: `${suffix} B`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE' } })).id
    restore = await enableBookingOps(owner)
    database = new BookingOpsDatabase(); job = new BookingLifecycleJobs(database, {})
  })
  afterAll(async () => {
    await database?.onModuleDestroy(); restore()
    for (const t of [tenantA, tenantB].filter(Boolean)) {
      for (const q of [`DELETE FROM "AuditEvent" WHERE tenant_id = '${t}'`, `DELETE FROM "Booking" WHERE tenant_id = '${t}'`, `DELETE FROM "Hotel" WHERE tenant_id = '${t}'`]) await owner.$executeRawUnsafe(q).catch(() => undefined)
    }
    await owner.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB].filter(Boolean) } } }); await owner.$disconnect()
  })

  it('LJE-01: only Confirmed, unlocked bookings whose check-out is before today move; each leaves a SYSTEM event, in every tenant; nothing else changes', async () => {
    const due = await booking('A', { checkOut: day(-1) }); const dueOld = await booking('A', { checkOut: day(-30) }); const dueB = await booking('B', { checkOut: day(-2) })
    const today = await booking('A', { checkOut: day(0) }); const future = await booking('A', { checkOut: day(3) }); const noDates = await booking('A', { checkOut: null })
    const cancelled = await booking('A', { status: 'CANCELLED', checkOut: day(-4) }); const onRequest = await booking('A', { status: 'ON_REQUEST', checkOut: day(-4) })
    const cancelReq = await booking('A', { status: 'CANCEL_REQUESTED', checkOut: day(-4) }); const locked = await booking('A', { checkOut: day(-4), closedAt: day(-1) })
    const result = await job.runOnce(() => NOW)
    expect(result).toMatchObject({ checkedOut: 3, failed: 0 })
    for (const id of [due, dueOld, dueB]) {
      expect(await status(id)).toBe('CHECKED_OUT')
      const ev = await events(id); expect(ev).toHaveLength(1); expect(ev[0]).toMatchObject({ fromStatus: 'CONFIRMED', toStatus: 'CHECKED_OUT', actorType: 'SYSTEM', actorId: null })
    }
    for (const [id, expected] of [[today, 'CONFIRMED'], [future, 'CONFIRMED'], [noDates, 'CONFIRMED'], [cancelled, 'CANCELLED'], [onRequest, 'ON_REQUEST'], [cancelReq, 'CANCEL_REQUESTED'], [locked, 'CONFIRMED']] as const) expect(await status(id)).toBe(expected)
    // A move of this kind is not money: no finance fact is written for it.
    expect(await owner.bookingFinanceEvent.count({ where: { bookingId: { in: [due, dueOld, dueB] } } })).toBe(0)
  })

  it('LJE-02: it is idempotent: a second pass moves nothing, and a booking checked out is not touched again', async () => {
    const id = await booking('A', { checkOut: day(-1) })
    expect((await job.runOnce(() => NOW)).checkedOut).toBe(1)
    expect(await job.runOnce(() => NOW)).toMatchObject({ checkedOut: 0, failed: 0 })
    expect(await events(id)).toHaveLength(1)
  })

  it('LJE-03: the day after check-out: not due at the end of the check-out day, due from the next UTC day', async () => {
    const id = await booking('A', { checkOut: day(0) })
    await job.runOnce(() => new Date('2030-06-10T23:59:59.000Z')); expect(await status(id)).toBe('CONFIRMED')
    await job.runOnce(() => new Date('2030-06-11T00:00:00.000Z')); expect(await status(id)).toBe('CHECKED_OUT')
  })

  it('LJE-04: two runners at once cannot move a booking twice or force one that a person changed first', async () => {
    const ids = await Promise.all(Array.from({ length: 6 }, () => booking('A', { checkOut: day(-1) })))
    const raced = await booking('A', { checkOut: day(-1) })
    await owner.booking.update({ where: { id: raced }, data: { status: 'CANCEL_REQUESTED' as never } }) // a person got there first
    const other = new BookingLifecycleJobs(new BookingOpsDatabase(), {})
    const [a, b] = await Promise.all([job.runOnce(() => NOW), other.runOnce(() => NOW)])
    expect(a.failed + b.failed).toBe(0); expect(a.checkedOut + b.checkedOut).toBe(ids.length)
    for (const id of ids) { expect(await status(id)).toBe('CHECKED_OUT'); expect(await events(id)).toHaveLength(1) }
    expect(await status(raced)).toBe('CANCEL_REQUESTED')
  })

  it('LJE-05: the cross-tenant function returns tenant ids only, and the booking role cannot do anything beyond it (no hotel read, no delete)', async () => {
    await booking('B', { checkOut: day(-1) })
    const tenants = await database.checkoutDueTenants('2030-06-10')
    expect(tenants).toEqual(expect.arrayContaining([tenantB])); expect(tenants.every((t) => typeof t === 'string')).toBe(true)
    await expect(database.withTenant(tenantA, (tx) => tx.hotel.findMany({ take: 1 }))).rejects.toBeDefined()
    await expect(database.withTenantWrite(tenantA, (tx) => tx.booking.deleteMany({ where: { tenantId: tenantA } }))).rejects.toBeDefined()
  })

  // ---- close after the dispute window (Phase 6G) ----------------------------------------------------------------------------------
  const closer = () => { const j = new BookingLifecycleJobs(database, { BOOKING_LIFECYCLE_JOB_ENABLED: 'true', BOOKING_LIFECYCLE_JOB_INTERVAL_MS: '3600000', BOOKING_CLOSE_AFTER_DAYS: '30' }, { resolve: () => null }); j.onModuleInit(); return j }
  const aged = async (id: string, days: number) => { await owner.$executeRawUnsafe(`UPDATE "Booking" SET updated_at = now() - interval '${days} days' WHERE id = '${id}'`); return id }
  const lock = async (id: string) => (await owner.booking.findUniqueOrThrow({ where: { id }, select: { status: true, closedAt: true } }))
  const decidedPenalty = async (id: string, tenantId = tenantA) => { await owner.bookingFinanceEvent.create({ data: { tenantId, bookingId: id, type: 'PENALTY_DECIDED', seq: 1, currency: 'AED', sellMinor: 100_000n, penaltyMinor: 20_000n, refundMinor: 80_000n } }); return id }

  it('LJE-06: with a 30-day window, each closable status is locked after 30 days of no change, keeps its status, and leaves a SYSTEM event; inside the window, other statuses and locked bookings are untouched', async () => {
    const closable: Array<[string, string]> = []
    for (const status of ['CHECKED_OUT', 'NO_SHOW', 'REJECTED', 'FAILED']) closable.push([status, await aged(await booking('A', { status }), 45)])
    closable.push(['CANCELLED', await aged(await decidedPenalty(await booking('A', { status: 'CANCELLED' })), 45)])
    const insideWindow = await aged(await booking('A', { status: 'FAILED' }), 29)
    const confirmed = await aged(await booking('A', { status: 'CONFIRMED', checkOut: day(5) }), 90); const onRequest = await aged(await booking('A', { status: 'ON_REQUEST', checkOut: day(5) }), 90)
    const alreadyClosed = await aged(await booking('A', { status: 'FAILED', closedAt: day(-40) }), 90)
    const closerJob = closer()
    try {
      const result = await closerJob.runOnce(() => NOW_REAL())
      expect(result).toMatchObject({ closed: 5, failed: 0 })
      for (const [status, id] of closable) {
        expect(await lock(id)).toMatchObject({ status, closedAt: expect.any(Date) })
        const ev = await owner.bookingEvent.findMany({ where: { bookingId: id, action: { startsWith: 'systemClose' } } })
        expect(ev).toHaveLength(1); expect(ev[0]).toMatchObject({ fromStatus: status, toStatus: status, actorType: 'SYSTEM', actorId: null }); expect(ev[0].payload).toMatchObject({ closed: true }); expect(ev[0].reason).toMatch(/no change for 30 days/)
      }
      for (const [id, status] of [[insideWindow, 'FAILED'], [confirmed, 'CONFIRMED'], [onRequest, 'ON_REQUEST']] as const) expect(await lock(id)).toMatchObject({ status, closedAt: null })
      expect((await lock(alreadyClosed)).closedAt).not.toBeNull(); expect(await owner.bookingEvent.count({ where: { bookingId: alreadyClosed, action: { startsWith: 'systemClose' } } })).toBe(0)
      expect(await owner.bookingFinanceEvent.count({ where: { bookingId: { in: closable.map(([, id]) => id) }, type: { not: 'PENALTY_DECIDED' } } })).toBe(0) // closing moves no money
    } finally { closerJob.onModuleDestroy() }
  })

  it('LJE-07: the window edge: 29 days of quiet is not enough, 31 is; a recent change restarts the clock', async () => {
    const a = await aged(await booking('A', { status: 'REJECTED' }), 29); const b = await aged(await booking('A', { status: 'REJECTED' }), 31)
    const closerJob = closer()
    try {
      await closerJob.runOnce(() => NOW_REAL()); expect((await lock(a)).closedAt).toBeNull(); expect((await lock(b)).closedAt).not.toBeNull()
      await owner.$executeRawUnsafe(`UPDATE "Booking" SET updated_at = now() - interval '40 days' WHERE id = '${a}'`); await owner.booking.update({ where: { id: a }, data: { agentRef: 'edited-today' } }) // an edit bumps updated_at
      await closerJob.runOnce(() => NOW_REAL()); expect((await lock(a)).closedAt).toBeNull()
    } finally { closerJob.onModuleDestroy() }
  })

  it('LJE-08: nothing that still needs a person is locked: an operations case (manual follow-up) and a Cancelled booking whose penalty nobody has decided are left, and are closed once resolved', async () => {
    const followUp = await aged(await booking('A', { status: 'FAILED' }), 60)
    await owner.bookingOpsState.create({ data: { tenantId: tenantA, bookingId: followUp, followUp: true, followUpAt: new Date(Date.now() - 3_600_000) } })
    const undecided = await aged(await booking('A', { status: 'CANCELLED' }), 60)
    const closerJob = closer()
    try {
      const first = await closerJob.runOnce(() => NOW_REAL())
      expect(first.failed).toBe(0); expect((await lock(followUp)).closedAt).toBeNull(); expect((await lock(undecided)).closedAt).toBeNull()
      await owner.bookingOpsState.update({ where: { tenantId_bookingId: { tenantId: tenantA, bookingId: followUp } }, data: { followUp: false, resolvedAt: new Date() } }); await aged(followUp, 60); await decidedPenalty(undecided); await aged(undecided, 60)
      await closerJob.runOnce(() => NOW_REAL())
      expect((await lock(followUp)).closedAt).not.toBeNull(); expect((await lock(undecided)).closedAt).not.toBeNull()
    } finally { closerJob.onModuleDestroy() }
  })

  it('LJE-09: idempotent and race-safe: a second pass closes nothing; two runners at once close each booking once', async () => {
    const ids = await Promise.all(Array.from({ length: 6 }, async () => aged(await booking('A', { status: 'NO_SHOW' }), 50)))
    const one = closer(); const two = closer()
    try {
      const [a, b] = await Promise.all([one.runOnce(() => NOW_REAL()), two.runOnce(() => NOW_REAL())])
      expect(a.failed + b.failed).toBe(0); expect(a.closed + b.closed).toBe(ids.length)
      for (const id of ids) expect(await owner.bookingEvent.count({ where: { bookingId: id, action: 'systemCloseNoShow' } })).toBe(1)
      expect((await one.runOnce(() => NOW_REAL())).closed).toBe(0)
    } finally { one.onModuleDestroy(); two.onModuleDestroy() }
  })

  it('LJE-10: with no window set, nothing is ever closed, however old; a closed booking refuses further actions', async () => {
    const old = await aged(await booking('A', { status: 'FAILED' }), 400)
    expect((await job.runOnce(() => NOW_REAL())).closed).toBe(0); expect((await lock(old)).closedAt).toBeNull()
    const closerJob = closer()
    try { await closerJob.runOnce(() => NOW_REAL()) } finally { closerJob.onModuleDestroy() }
    expect((await lock(old)).closedAt).not.toBeNull()
    await expect(database.withTenantWrite(tenantA, (tx) => transitionBooking(tx, { tenantId: tenantA, bookingId: old, action: 'close', expectedStatus: 'FAILED', actor: { type: 'USER', id: 'someone' }, level: 'OPERATOR', reason: 'again', now: new Date() }))).rejects.toMatchObject({ response: { code: 'BOOKING_CLOSED' } })
  })
})
