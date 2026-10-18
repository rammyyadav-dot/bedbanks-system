import { randomBytes } from 'crypto'
import { PrismaClient } from '@prisma/client'
import { BookingOpsDatabase } from '../src/booking-ops/booking-ops-database'
import { BookingLifecycleJobs } from '../src/booking-ops/booking-lifecycle-jobs.service'
import { enableBookingOps } from './support/booking-ops'

jest.setTimeout(240_000)

/** The scheduled Checked-out job (ADR 0039, Phase 6E) against PostgreSQL with the booking module's own limited role and forced RLS. */
describe('Booking lifecycle jobs: Checked-out (PostgreSQL, booking role)', () => {
  const owner = new PrismaClient()
  const suffix = `lj-${Date.now()}-${randomBytes(3).toString('hex')}`
  let tenantA = '', tenantB = '', hotelA = '', hotelB = ''; let restore: () => void = () => undefined; let n = 0
  let database: BookingOpsDatabase; let job: BookingLifecycleJobs
  const NOW = new Date('2030-06-10T09:00:00.000Z')
  const day = (offset: number) => new Date(Date.UTC(2030, 5, 10 + offset))

  async function booking(tenant: 'A' | 'B', over: { status?: string; checkOut?: Date | null; closedAt?: Date | null } = {}) {
    const tenantId = tenant === 'A' ? tenantA : tenantB; n += 1
    const out = over.checkOut === undefined ? day(-1) : over.checkOut
    const b = await owner.booking.create({ data: { tenantId, reference: `FB-${randomBytes(10).toString('hex').toUpperCase()}`, supplier: 'Supplier One', hotelId: tenant === 'A' ? hotelA : hotelB, status: (over.status ?? 'CONFIRMED') as never,
      currency: 'AED', totalMinor: 100_000n, idempotencyKey: `${suffix}-${n}`, searchSnapshot: {}, supplierRef: `S-${n}`, hotelConfirmationNo: `H-${n}`, checkIn: out === null ? null : new Date(out.getTime() - 4 * 86_400_000), checkOut: out, nights: 4, closedAt: over.closedAt ?? null } })
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
})
