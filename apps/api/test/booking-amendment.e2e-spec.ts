import { randomBytes } from 'crypto'
import { INestApplication, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { PrismaClient } from '@prisma/client'
import * as cookieParser from 'cookie-parser'
import * as request from 'supertest'
import type { BookingDetailView } from '@bedbanks/contracts'
import { AppModule } from '../src/app.module'
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter'
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor'
import { hashPassword } from '../src/auth/utils/password'
import { provisionApiRuntimeRole, API_RUNTIME_LOGIN_ROLE } from '../src/database/api-runtime-role'
import { BookingOpsDatabase } from '../src/booking-ops/booking-ops-database'
import { eraseLedger } from './ledger-erasure'
import { enableBookingOps } from './support/booking-ops'

jest.setTimeout(240_000)

/** Structured amendments over HTTP (ADR 0072): strict API role + the booking role, real PostgreSQL. */
describe('Booking amendments (PostgreSQL, HTTP, strict roles)', () => {
  const owner = new PrismaClient()
  const suffix = `am-${Date.now()}-${randomBytes(3).toString('hex')}`
  const password = 'booking-amendment-certification-password'
  const runtimePassword = `rt-${randomBytes(20).toString('hex')}`
  const origin = 'http://localhost:3001'
  let app: INestApplication; let previousUrl: string | undefined; let restoreOps: () => void = () => undefined
  let tenantA = '', hotelA = '', agencyX = '', agencyY = '', walletId = ''
  const cookies: Record<string, string> = {}; const all: string[] = []; let n = 0
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
  const key = () => `k-${randomBytes(8).toString('hex')}`

  async function user(label: string, keys: string[], agencyId?: string) {
    const u = await owner.user.create({ data: { email: `${suffix}-${label}@example.test`.toLowerCase(), name: `User ${label}`, passwordHash: await hashPassword(password), status: 'ACTIVE' } }); all.push(u.id)
    await owner.membership.create({ data: { tenantId: tenantA, userId: u.id, role: 'agent' } })
    if (agencyId) await owner.agencyMember.create({ data: { tenantId: tenantA, agencyId, userId: u.id } })
    const r = await owner.role.create({ data: { tenantId: tenantA, name: `${suffix}-${label}` } })
    for (const k of keys) { const p = await owner.permission.upsert({ where: { key: k }, update: {}, create: { key: k, description: k } }); await owner.rolePermission.create({ data: { roleId: r.id, permissionId: p.id } }) }
    await owner.userRole.create({ data: { tenantId: tenantA, userId: u.id, roleId: r.id } })
    return u.id
  }
  /** A Confirmed booking: 4 nights from day 20, two rooms, total 730.00 AED, net 650.00, a free-cancellation deadline, per-room prices, an issued voucher on request. */
  async function booking(o: { agency?: 'X' | 'Y'; charged?: boolean; status?: string } = {}) {
    n += 1
    const b = await owner.booking.create({ data: { tenantId: tenantA, reference: `FB-${randomBytes(10).toString('hex').toUpperCase()}`, supplier: 'Supplier One', hotelId: hotelA, status: (o.status ?? 'CONFIRMED') as never, currency: 'AED', totalMinor: 73_000n, netMinor: 65_000n, markupMinor: 8_000n,
      idempotencyKey: `${suffix}-${n}`, searchSnapshot: {}, agencyId: o.agency === 'Y' ? agencyY : agencyX, supplierRef: `SUP-${n}`, hotelConfirmationNo: `H-${n}`, checkIn: new Date(`${day(20)}T00:00:00Z`), checkOut: new Date(`${day(24)}T00:00:00Z`), nights: 4,
      cancelDeadline: new Date(`${day(15)}T00:00:00Z`), isRefundable: true, paymentMode: 'CREDIT' as never } })
    await owner.bookingRoom.create({ data: { tenantId: tenantA, bookingId: b.id, position: 1, roomName: 'Deluxe', adults: 2, children: 1, childAges: [7], sellMinor: 40_000n, netMinor: 36_000n } })
    await owner.bookingRoom.create({ data: { tenantId: tenantA, bookingId: b.id, position: 2, roomName: 'Deluxe', adults: 2, sellMinor: 33_000n, netMinor: 29_000n } })
    await owner.bookingGuest.create({ data: { tenantId: tenantA, bookingId: b.id, firstName: 'Amira', lastName: 'Haddad', isLead: true } })
    await owner.bookingEvent.create({ data: { tenantId: tenantA, bookingId: b.id, toStatus: (o.status ?? 'CONFIRMED') as never, actorType: 'SYSTEM', reason: 'fixture', payload: { backfill: true } } })
    if (o.charged) {
      const k = `booking:${b.id}:authorize`
      for (const [type, amount, suffixKey] of [['HOLD', -73_000n, ''], ['RELEASE', 73_000n, ':settle-release'], ['DEBIT', -73_000n, ':settle-debit']] as const) await owner.ledgerEntry.create({ data: { tenantId: tenantA, walletId, type, amountMinor: amount, currency: 'AED', reference: `booking:${b.id}`, idempotencyKey: `${k}${suffixKey}` } })
    }
    return b.id
  }
  const post = (id: string, who: string, body: Record<string, unknown>, k: string | null = key()) => { const r = request(app.getHttpServer()).post(`/api/v1/admin/operations/bookings/${id}/actions`).set('Cookie', cookies[who]).set('Origin', origin); return (k ? r.set('Idempotency-Key', k) : r).send(body) }
  const code = (res: request.Response) => res.body.error?.code ?? res.body.code ?? res.body.message?.code
  const detail = async (id: string, who = 'lead'): Promise<BookingDetailView> => (await request(app.getHttpServer()).get(`/api/v1/admin/operations/bookings/${id}`).set('Cookie', cookies[who]).expect(200)).body.data
  const snap = (id: string) => owner.booking.findUniqueOrThrow({ where: { id }, include: { rooms: { orderBy: { position: 'asc' } } } })
  const amendments = (id: string) => owner.bookingAmendment.findMany({ where: { bookingId: id }, orderBy: { createdAt: 'asc' } })
  const finance = (id: string) => owner.bookingFinanceEvent.findMany({ where: { bookingId: id, type: 'AMENDED' }, orderBy: { seq: 'asc' } })
  const request_ = (id: string, amendment: Record<string, unknown> | undefined, who = 'lead', k = key()) => post(id, who, { action: 'requestAmendment', expectedStatus: 'CONFIRMED', reason: 'Guest asked to change the stay', ...(amendment ? { amendment } : {}) }, k)
  const approve = (id: string, approval: Record<string, unknown> | undefined, who = 'lead', k = key()) => post(id, who, { action: 'approveAmendment', expectedStatus: 'AMEND_REQUESTED', ...(approval ? { approval } : {}) }, k)
  const reject = (id: string, who = 'lead') => post(id, who, { action: 'rejectAmendment', expectedStatus: 'AMEND_REQUESTED', reason: 'Supplier could not do it' })
  const LONGER = { checkOut: day(26) } // 6 nights instead of 4
  const MORE = { rooms: [{ position: 2, adults: 3, children: 0, childAges: [] }] }

  beforeAll(async () => {
    await owner.$connect()
    tenantA = (await owner.tenant.create({ data: { name: suffix, slug: suffix } })).id
    hotelA = (await owner.hotel.create({ data: { tenantId: tenantA, name: `${suffix} A`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', timeZone: 'Asia/Dubai' } })).id
    const creator = await owner.user.create({ data: { email: `${suffix}-creator@example.test`, name: 'Creator', passwordHash: await hashPassword(password), status: 'ACTIVE' } }); all.push(creator.id)
    agencyX = (await owner.agency.create({ data: { tenantId: tenantA, code: `X-${suffix.slice(-6)}`.toUpperCase(), name: 'Travel Republic', countryCode: 'GB', createdById: creator.id } })).id
    agencyY = (await owner.agency.create({ data: { tenantId: tenantA, code: `Y-${suffix.slice(-6)}`.toUpperCase(), name: 'Atlas Getaways', countryCode: 'AE', createdById: creator.id } })).id
    walletId = (await owner.wallet.create({ data: { tenantId: tenantA, agencyId: agencyX, currency: 'AED' } })).id
    await user('lead', ['booking.read', 'booking.amend', 'booking.view.net', 'booking.finance.view', 'booking.cancel'])
    await user('nonet', ['booking.read', 'booking.amend'])
    await user('reader', ['booking.read'])
    await user('agx', ['booking.view.agency', 'booking.amend.request'], agencyX)
    const restoreDb = await enableBookingOps(owner); restoreOps = restoreDb
    await provisionApiRuntimeRole(owner, { password: runtimePassword })
    previousUrl = process.env.DATABASE_URL
    const u = new URL(previousUrl as string); u.username = API_RUNTIME_LOGIN_ROLE; u.password = runtimePassword
    process.env.DATABASE_URL = u.toString(); process.env.ADMIN_ORIGIN = origin
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication(); app.use(cookieParser()); app.setGlobalPrefix('api/v1')
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
    app.useGlobalFilters(new HttpExceptionFilter()); app.useGlobalInterceptors(new ResponseInterceptor())
    await app.init()
    for (const label of ['lead', 'nonet', 'reader', 'agx']) {
      const r = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', origin).send({ email: `${suffix}-${label}@example.test`.toLowerCase(), password }); if (r.status !== 200) throw new Error(`login ${label} ${r.status}`)
      cookies[label] = (r.headers['set-cookie'][0] as string).split(';')[0]
    }
  })
  afterAll(async () => {
    await app?.close(); restoreOps()
    if (previousUrl) process.env.DATABASE_URL = previousUrl
    await eraseLedger(owner, { where: { tenantId: tenantA } }).catch(() => undefined)
    for (const q of [`DELETE FROM "AuditEvent" WHERE tenant_id = '${tenantA}'`, `DELETE FROM "BookingDocument" WHERE tenant_id = '${tenantA}'`, `DELETE FROM "Wallet" WHERE tenant_id = '${tenantA}'`, `DELETE FROM "Booking" WHERE tenant_id = '${tenantA}'`, `DELETE FROM "Hotel" WHERE tenant_id = '${tenantA}'`,
      `DELETE FROM "AgencyMember" WHERE tenant_id = '${tenantA}'`, `DELETE FROM "Agency" WHERE tenant_id = '${tenantA}'`, `DELETE FROM "UserRole" WHERE tenant_id = '${tenantA}'`, `DELETE FROM "RolePermission" WHERE role_id IN (SELECT id FROM "Role" WHERE tenant_id = '${tenantA}')`,
      `DELETE FROM "Role" WHERE tenant_id = '${tenantA}'`, `DELETE FROM memberships WHERE tenant_id = '${tenantA}'`]) await owner.$executeRawUnsafe(q).catch(() => undefined)
    await owner.session.deleteMany({ where: { userId: { in: all } } }); await owner.user.deleteMany({ where: { id: { in: all } } }); await owner.tenant.deleteMany({ where: { id: tenantA } }); await owner.$disconnect()
  })

  it('AME-01: a structured request stores what was asked and the booking as it was, changes nothing else, and keeps guest data and the free-text reason out of the audit log', async () => {
    const id = await booking(); const before = await snap(id)
    await request_(id, { ...LONGER, ...MORE }).expect(200)
    const after = await snap(id)
    expect(after).toMatchObject({ status: 'AMEND_REQUESTED', totalMinor: 73_000n, nights: 4, version: 1 }); expect(after.checkOut).toEqual(before.checkOut)
    const [a] = await amendments(id)
    expect(a).toMatchObject({ status: 'REQUESTED', fromVersion: 1, approvedSellMinor: null })
    expect(a.proposal).toEqual({ checkOut: day(26), rooms: [{ position: 2, adults: 3, children: 0, childAges: [] }] })
    expect(a.beforeState).toMatchObject({ checkIn: day(20), checkOut: day(24), nights: 4, sellMinor: '73000', netMinor: '65000' })
    const audit = JSON.stringify((await owner.auditEvent.findMany({ where: { tenantId: tenantA, entityId: id } })).map((x) => x.payload))
    expect(audit).not.toContain('Haddad'); expect(audit).not.toContain('Guest asked')
    const ev = (await owner.bookingEvent.findMany({ where: { bookingId: id, action: 'requestAmendment' } }))[0]
    expect(ev.payload).toMatchObject({ amendmentId: a.id, changes: ['STAY_DATES', 'OCCUPANCY'] })
  })

  it('AME-02: approving a price increase applies dates, nights, occupancy, price, net and markup together; the version moves once; the deadline becomes unknown; the difference is a money fact', async () => {
    const id = await booking()
    await request_(id, { ...LONGER, ...MORE }).expect(200)
    const res = await approve(id, { sellMinor: '95000', netMinor: '84000' }).expect(200)
    expect(res.body.data).toMatchObject({ status: 'CONFIRMED', version: 2 })
    const b = await snap(id)
    expect(b).toMatchObject({ status: 'CONFIRMED', version: 2, totalMinor: 95_000n, netMinor: 84_000n, markupMinor: 11_000n, nights: 6, cancelDeadline: null })
    expect(b.checkIn?.toISOString().slice(0, 10)).toBe(day(20)); expect(b.checkOut?.toISOString().slice(0, 10)).toBe(day(26))
    expect(b.rooms.map((r) => [r.position, r.adults, r.children])).toEqual([[1, 2, 1], [2, 3, 0]])
    expect(b.rooms.every((r) => r.sellMinor === null && r.netMinor === null)).toBe(true) // per-room prices would be stale: unknown, not carried over
    const [a] = await amendments(id)
    expect(a).toMatchObject({ status: 'APPROVED', approvedSellMinor: 95_000n, approvedNetMinor: 84_000n, differenceMinor: 22_000n }); expect(a.decidedAt).not.toBeNull()
    const [fin] = await finance(id)
    expect(fin).toMatchObject({ type: 'AMENDED', seq: 1, sellMinor: 95_000n, netMinor: 84_000n, adjustmentMinor: 22_000n, currency: 'AED' })
    expect(fin.payload).toMatchObject({ direction: 'INCREASE', amendmentId: a.id })
    const ev = (await owner.bookingEvent.findMany({ where: { bookingId: id, action: 'approveAmendment' } }))[0]
    expect(ev.payload).toMatchObject({ amendment: 'approved', amendmentId: a.id, differenceMinor: '22000', newSellMinor: '95000' })
    expect(await owner.ledgerEntry.count({ where: { tenantId: tenantA, reference: `booking:${id}` } })).toBe(0) // nothing is posted to the ledger
    expect(await owner.hotelNotice.count({ where: { bookingId: id } })).toBe(0) // ADR 0106: the hotel was never told about this booking by us, so nothing is sent about the change
  })

  it('AME-03: a recorded cancellation deadline is kept; a price decrease is a negative fact; a second amendment is a second event; occupancy-only keeps the deadline', async () => {
    const id = await booking()
    await request_(id, LONGER).expect(200); await approve(id, { sellMinor: '95000', cancelDeadline: `${day(18)}T00:00:00.000Z` }).expect(200)
    expect((await snap(id)).cancelDeadline?.toISOString()).toBe(`${day(18)}T00:00:00.000Z`); expect((await snap(id)).netMinor).toBeNull() // net not recorded: unknown, never the stale 650.00
    await request_(id, MORE).expect(200); await approve(id, { sellMinor: '90000' }).expect(200)
    expect((await snap(id)).cancelDeadline?.toISOString()).toBe(`${day(18)}T00:00:00.000Z`) // dates did not move: unchanged
    const facts = await finance(id)
    expect(facts.map((f) => [f.seq, f.adjustmentMinor])).toEqual([[1, 22_000n], [2, -5_000n]]); expect(facts[1].payload).toMatchObject({ direction: 'DECREASE' })
    expect((await snap(id)).version).toBe(3)
  })

  it('AME-04: a zero difference applies the change and records no money fact', async () => {
    const id = await booking(); await request_(id, MORE).expect(200); await approve(id, { sellMinor: '73000', netMinor: '65000' }).expect(200)
    expect(await finance(id)).toHaveLength(0); expect((await snap(id)).rooms[1].adults).toBe(3)
    expect((await amendments(id))[0]).toMatchObject({ status: 'APPROVED', differenceMinor: 0n })
  })

  it('AME-05: a rejection leaves the booking exactly as it was and records the outcome', async () => {
    const id = await booking(); const before = await snap(id)
    await request_(id, { ...LONGER, ...MORE }).expect(200); await reject(id).expect(200)
    const after = await snap(id)
    expect({ ...after, status: 'x', updatedAt: null, rooms: after.rooms.map((r) => ({ ...r, updatedAt: null })) }).toEqual({ ...before, status: 'x', updatedAt: null, rooms: before.rooms.map((r) => ({ ...r, updatedAt: null })) })
    expect(after.status).toBe('CONFIRMED'); expect(after.version).toBe(1)
    expect((await amendments(id))[0]).toMatchObject({ status: 'REJECTED', approvedSellMinor: null }); expect(await finance(id)).toHaveLength(0)
    await request_(id, LONGER).expect(200) // the booking can be amended again
  })

  it('AME-06: approval rules: a structured amendment needs the price (422), a bad price is refused (422), a price with a free-text request is refused (400); nothing changes on any refusal', async () => {
    const id = await booking(); await request_(id, LONGER).expect(200)
    expect(code(await approve(id, undefined).expect(422))).toBe('AMENDMENT_APPROVAL_REQUIRED')
    for (const bad of [{ sellMinor: '95.50' }, { sellMinor: '0' }, { sellMinor: '100', netMinor: '101' }, { sellMinor: '100', cancelDeadline: 'soon' }, { sellMinor: '100', nope: 1 }]) expect(code(await approve(id, bad).expect(422))).toBe('AMENDMENT_APPROVAL_INVALID')
    expect(await snap(id)).toMatchObject({ status: 'AMEND_REQUESTED', version: 1, totalMinor: 73_000n }); expect((await amendments(id))[0].status).toBe('REQUESTED'); expect(await finance(id)).toHaveLength(0)
    const free = await booking(); await request_(free, undefined).expect(200)
    expect(code(await approve(free, { sellMinor: '100' }).expect(400))).toBe('AMENDMENT_APPROVAL_NOT_EXPECTED')
    expect(await amendments(free)).toHaveLength(0)
    const wrong = await post(free, 'lead', { action: 'confirmCancellation', expectedStatus: 'AMEND_REQUESTED', approval: { sellMinor: '1' } }).expect(400)
    expect(code(wrong)).toBe('AMENDMENT_APPROVAL_NOT_EXPECTED')
  })

  it('AME-07: a free-text request (names, special requests) still works as before: approval only moves the status and the version, and changes nothing else', async () => {
    const id = await booking(); const before = await snap(id)
    await request_(id, undefined).expect(200); await approve(id, undefined).expect(200)
    const after = await snap(id)
    expect(after).toMatchObject({ status: 'CONFIRMED', version: 2, totalMinor: before.totalMinor, nights: before.nights }); expect(after.checkOut).toEqual(before.checkOut)
    expect(await amendments(id)).toHaveLength(0); expect(await finance(id)).toHaveLength(0)
  })

  it('AME-08: a booking charged on the agency ledger: a price change is refused (409) and nothing changes; a same-price change is allowed; the ledger is never touched', async () => {
    const id = await booking({ charged: true }); const ledgerBefore = await owner.ledgerEntry.count({ where: { tenantId: tenantA, reference: `booking:${id}` } })
    await request_(id, LONGER).expect(200)
    const refused = await approve(id, { sellMinor: '95000' }).expect(409)
    expect(code(refused)).toBe('AMENDMENT_LEDGER_ADJUSTMENT_REQUIRED')
    expect(await snap(id)).toMatchObject({ status: 'AMEND_REQUESTED', version: 1, totalMinor: 73_000n, nights: 4 }); expect((await amendments(id))[0].status).toBe('REQUESTED'); expect(await finance(id)).toHaveLength(0)
    await approve(id, { sellMinor: '73000', netMinor: '65000' }).expect(200)  // the supplier kept the price: no ledger adjustment is needed
    expect(await snap(id)).toMatchObject({ status: 'CONFIRMED', version: 2, nights: 6, totalMinor: 73_000n })
    expect(await owner.ledgerEntry.count({ where: { tenantId: tenantA, reference: `booking:${id}` } })).toBe(ledgerBefore)
    // ...and it can be rejected instead, as the message says
    const again = await booking({ charged: true }); await request_(again, LONGER).expect(200); await reject(again).expect(200); expect((await snap(again)).status).toBe('CONFIRMED')
  })

  it('AME-09: invalid proposals are refused with every problem and leave nothing behind (no status change, no row)', async () => {
    const id = await booking()
    for (const bad of [{ checkIn: day(-3), checkOut: day(24) }, { checkOut: day(20) }, { checkOut: day(24) }, { rooms: [{ position: 9, adults: 2, children: 0, childAges: [] }] }, { rooms: [{ position: 1, adults: 2, children: 2, childAges: [3] }] }, { checkOut: day(26), guests: [{ firstName: 'X' }] }, {}]) {
      const res = await request_(id, bad as Record<string, unknown>).expect(422)
      expect(['AMENDMENT_INVALID', 'AMENDMENT_NO_CHANGE']).toContain(code(res))
    }
    expect(await snap(id)).toMatchObject({ status: 'CONFIRMED', version: 1 }); expect(await amendments(id)).toHaveLength(0)
    expect(code(await post(id, 'lead', { action: 'recordConfirmed', expectedStatus: 'CONFIRMED', amendment: LONGER }).expect(400))).toBe('AMENDMENT_INVALID')
  })

  it('AME-10: idempotent: the same key replays (one amendment, one approval, one money fact); the same key with a different body is a conflict', async () => {
    const id = await booking(); const k1 = key()
    const first = await request_(id, LONGER, 'lead', k1).expect(200); const replay = await request_(id, LONGER, 'lead', k1).expect(200)
    expect(replay.body.data.replayed).toBe(true); expect(first.body.data.replayed).toBe(false); expect(await amendments(id)).toHaveLength(1)
    expect(code(await request_(id, { checkOut: day(27) }, 'lead', k1).expect(409))).toBe('IDEMPOTENCY_CONFLICT')
    const k2 = key()
    await approve(id, { sellMinor: '95000' }, 'lead', k2).expect(200)
    expect((await approve(id, { sellMinor: '95000' }, 'lead', k2).expect(200)).body.data.replayed).toBe(true)
    expect(code(await approve(id, { sellMinor: '99000' }, 'lead', k2).expect(409))).toBe('IDEMPOTENCY_CONFLICT')
    expect(await finance(id)).toHaveLength(1); expect((await snap(id)).version).toBe(2)
  })

  it('AME-11: two approvals at once: one applies, the other is told the booking changed; one money fact, one version bump', async () => {
    const id = await booking(); await request_(id, LONGER).expect(200)
    const [a, b] = await Promise.all([approve(id, { sellMinor: '95000' }), approve(id, { sellMinor: '96000' })])
    expect([a.status, b.status].sort()).toEqual([200, 409])
    expect(await finance(id)).toHaveLength(1); expect((await snap(id)).version).toBe(2); expect((await snap(id)).status).toBe('CONFIRMED')
  })

  it('AME-12: who may do what: an agency user may request on their own booking only and never approve; a reader may not; an unknown booking is a 404 for the agency', async () => {
    const own = await booking({ agency: 'X' }); const foreign = await booking({ agency: 'Y' })
    await request_(own, LONGER, 'agx').expect(200)
    expect((await amendments(own))[0].requestedByUserId).not.toBeNull()
    await approve(own, { sellMinor: '95000' }, 'agx').expect(403)
    await request_(foreign, LONGER, 'agx').expect(404)
    await request_(await booking(), LONGER, 'reader').expect(403)
    expect(await snap(own)).toMatchObject({ status: 'AMEND_REQUESTED', version: 1 })
  })

  it('AME-13: the detail shows the amendments; the net and margin side stay hidden without booking.view.net; an agency sees its own booking\'s amendments', async () => {
    const id = await booking({ agency: 'X' }); await request_(id, { ...LONGER, ...MORE }).expect(200); await approve(id, { sellMinor: '95000', netMinor: '84000' }).expect(200)
    const lead = await detail(id); const nonet = await detail(id, 'nonet'); const agency = await detail(id, 'agx')
    expect(lead.amendments).toHaveLength(1)
    expect(lead.amendments![0]).toMatchObject({ status: 'APPROVED', fromVersion: 1, financeRecorded: true, proposal: { checkOut: day(26) }, approved: { sellMinor: '95000', netMinor: '84000', differenceMinor: '22000', direction: 'INCREASE' }, before: { sellMinor: '73000', netMinor: '65000' } })
    for (const view of [nonet, agency]) { expect(view.amendments![0].approved?.netMinor).toBeNull(); expect(view.amendments![0].before.netMinor).toBeNull(); expect(JSON.stringify(view.amendments)).not.toContain('84000'); expect(JSON.stringify(view.amendments)).not.toContain('65000') }
    expect(agency.amendments![0].approved?.sellMinor).toBe('95000')
  })

  it('AME-14: documents already issued are listed as NOT reissued on the amendment, and are never re-rendered or replaced', async () => {
    const id = await booking()
    for (const [type, prefix] of [['VOUCHER', 'VCH'], ['INVOICE', 'INV']] as const) await owner.bookingDocument.create({ data: { tenantId: tenantA, bookingId: id, type, number: `${prefix}-${suffix}-${n}`, payload: { total: '730.00' } } })
    await request_(id, LONGER).expect(200); await approve(id, { sellMinor: '95000' }).expect(200)
    expect((await amendments(id))[0].documentsNotReissued).toEqual(['INVOICE', 'VOUCHER'])
    const docs = (await owner.bookingDocument.findMany({ where: { bookingId: id } })).sort((a, b) => (a.type < b.type ? -1 : 1))
    expect(docs.map((d) => d.type)).toEqual(['INVOICE', 'VOUCHER']); expect(docs.every((d) => (d.payload as { total: string }).total === '730.00')).toBe(true) // still the issued figures
    expect((await detail(id)).amendments![0].documentsNotReissued).toEqual(['INVOICE', 'VOUCHER'])
  })

  it('AME-15: the booking role can write the decision columns and the stay/price, and nothing it must not: not the proposal, not the before-state, not the supplier', async () => {
    const id = await booking(); await request_(id, LONGER).expect(200)
    const db = new BookingOpsDatabase()
    try {
      await expect(db.withTenantWrite(tenantA, (tx) => tx.bookingAmendment.updateMany({ where: { bookingId: id }, data: { proposal: {} } }))).rejects.toBeDefined()
      await expect(db.withTenantWrite(tenantA, (tx) => tx.bookingAmendment.updateMany({ where: { bookingId: id }, data: { beforeState: {} } }))).rejects.toBeDefined()
      await expect(db.withTenantWrite(tenantA, (tx) => tx.booking.updateMany({ where: { id }, data: { supplier: 'x' } }))).rejects.toBeDefined()
      await expect(db.withTenantWrite(tenantA, (tx) => tx.bookingAmendment.deleteMany({ where: { bookingId: id } }))).rejects.toBeDefined()
    } finally { await db.onModuleDestroy() }
  })

  it('AME-16 (ADR 0106): an approved amendment queues an AMEND notice and a cancellation queues a CANCEL notice, as the booking role, to the address and copies of the original; a rejection and a free-text approval queue nothing', async () => {
    const id = await booking()
    const copies = ['agent@agency.test', 'admin@fbeds.test']
    await owner.hotelNotice.create({ data: { tenantId: tenantA, bookingId: id, kind: 'NEW', toAddress: 'reservations@atlas-hotel.test', copyAddresses: copies, status: 'SENT', sentAt: new Date(), runAfter: new Date() } })
    const rows = () => owner.hotelNotice.findMany({ where: { bookingId: id }, orderBy: [{ kind: 'asc' }, { createdAt: 'asc' }] })

    await request_(id, LONGER).expect(200)
    await reject(id).expect(200)
    expect((await rows()).length).toBe(1) // a rejected amendment changes nothing, so the hotel is told nothing

    await request_(id, LONGER).expect(200)
    await approve(id, { sellMinor: '90000', netMinor: '80000' }).expect(200)
    const [amendment] = (await amendments(id)).filter((a) => a.status === 'APPROVED')
    await request_(id, MORE).expect(200)
    await approve(id, { sellMinor: '92000', netMinor: '82000' }).expect(200)
    const amends = (await rows()).filter((n) => n.kind === 'AMEND')
    expect(amends.length).toBe(2) // two approved amendments, two notices
    expect(amends[0]).toMatchObject({ eventKey: amendment.id, status: 'QUEUED', toAddress: 'reservations@atlas-hotel.test', copyAddresses: copies, requestedByUserId: expect.any(String) })
    expect(new Set(amends.map((n) => n.eventKey)).size).toBe(2)

    await post(id, 'lead', { action: 'requestCancellation', expectedStatus: 'CONFIRMED', reason: 'Guest changed plans', confirmNonRefundable: true }).expect(200)
    await post(id, 'lead', { action: 'confirmCancellation', expectedStatus: 'CANCEL_REQUESTED', supplierCancellationRef: 'CXL-9', confirmNonRefundable: true }).expect(200)
    const cancel = (await rows()).filter((n) => n.kind === 'CANCEL')
    expect(cancel.map((n) => [n.eventKey, n.status, n.toAddress, n.copyAddresses])).toEqual([['cancel', 'QUEUED', 'reservations@atlas-hotel.test', copies]])
    expect(await owner.auditEvent.count({ where: { tenantId: tenantA, entityId: id, action: 'booking.hotel_notice.queued' } })).toBe(3)
  })
})
