import { randomBytes } from 'crypto'
import { INestApplication, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { PrismaClient } from '@prisma/client'
import * as cookieParser from 'cookie-parser'
import * as request from 'supertest'
import { OPERATIONS_READ_DENIED, type BookingDetailView, type BookingListPage } from '@bedbanks/contracts'
import { AppModule } from '../src/app.module'
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter'
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor'
import { hashPassword } from '../src/auth/utils/password'
import { provisionApiRuntimeRole, API_RUNTIME_LOGIN_ROLE } from '../src/database/api-runtime-role'
import { enableBookingOps } from './support/booking-ops'

jest.setTimeout(180_000)

/**
 * The Admin booking list and detail over HTTP (ADR 0039, Phase 1), on PostgreSQL, with the application connected as the non-owner API runtime role
 * (which cannot read bookings) and the booking module connected as its own limited role. Two operator tenants, two agencies, ten statuses.
 */
describe('Admin bookings read model (PostgreSQL, HTTP, runtime role + booking role)', () => {
  const owner = new PrismaClient()
  const suffix = `bk-${Date.now()}-${randomBytes(3).toString('hex')}`
  const password = 'booking-read-certification-password'
  const runtimePassword = `rt-${randomBytes(20).toString('hex')}`
  const origin = 'http://localhost:3001'
  const DAY = 86_400_000
  const at = (days: number) => new Date(Date.now() + days * DAY)
  const ymd = (days: number) => at(days).toISOString().slice(0, 10)
  let app: INestApplication; let previousUrl: string | undefined; let restoreOps: () => void = () => undefined
  let tenantA = '', tenantB = '', agencyX = '', agencyY = '', hotelDubai = '', hotelLondon = '', hotelB = ''
  const cookies: Record<string, string> = {}; const userIds: string[] = []
  const ids: Record<string, string> = {}; const refs: Record<string, string> = {}

  async function user(label: string, tenantId: string, keys: string[], role = 'agent', agencyId?: string) {
    const u = await owner.user.create({ data: { email: `${suffix}-${label}@example.test`, name: label, passwordHash: await hashPassword(password), status: 'ACTIVE' } }); userIds.push(u.id)
    await owner.membership.create({ data: { tenantId, userId: u.id, role } })
    if (keys.length) {
      const r = await owner.role.create({ data: { tenantId, name: `${suffix}-${label}` } })
      for (const key of keys) { const p = await owner.permission.upsert({ where: { key }, update: {}, create: { key, description: key } }); await owner.rolePermission.create({ data: { roleId: r.id, permissionId: p.id } }) }
      await owner.userRole.create({ data: { tenantId, userId: u.id, roleId: r.id } })
    }
    if (agencyId) await owner.agencyMember.create({ data: { tenantId, agencyId, userId: u.id } })
    return u.id
  }

  interface B { key: string; status: string; agency?: 'X' | 'Y' | null; hotel?: string; supplier?: string; supplierRef?: string | null; hotelConf?: string | null; agentRef?: string | null; checkIn?: number | null; nights?: number; created?: number; deadline?: number | null; refundable?: boolean | null; net?: bigint | null; payment?: string | null; version?: number; closed?: boolean; tenant?: 'A' | 'B'; guest?: [string, string] | null; sell?: bigint; currency?: string }
  async function booking(o: B) {
    const tenantId = o.tenant === 'B' ? tenantB : tenantA
    const hotelId = o.tenant === 'B' ? hotelB : o.hotel === 'London' ? hotelLondon : hotelDubai
    const ref = `FB-${suffix.replace(/[^a-z0-9]/gi, '').toUpperCase()}${o.key}`.slice(0, 30)
    const checkIn = o.checkIn === null ? null : ymd(o.checkIn ?? 30); const nights = o.nights ?? 2
    const b = await owner.booking.create({ data: {
      tenantId, reference: ref, supplier: o.supplier ?? 'Global Hotel Supply', hotelId, status: o.status as never, currency: o.currency ?? 'AED', totalMinor: o.sell ?? 100_000n, idempotencyKey: `${suffix}-${o.key}`, searchSnapshot: {},
      agencyId: o.agency === 'X' ? agencyX : o.agency === 'Y' ? agencyY : null, supplierRef: o.supplierRef ?? null, hotelConfirmationNo: o.hotelConf ?? null, agentRef: o.agentRef ?? null,
      checkIn: checkIn ? new Date(`${checkIn}T00:00:00Z`) : null, checkOut: checkIn ? new Date(`${ymd((o.checkIn ?? 30) + nights)}T00:00:00Z`) : null, nights: checkIn ? nights : null,
      netMinor: o.net === undefined ? null : o.net, markupMinor: o.net ? (o.sell ?? 100_000n) - o.net : null, paymentStatus: (o.payment ?? null) as never, isRefundable: o.refundable ?? null,
      cancelDeadline: o.deadline === undefined || o.deadline === null ? null : at(o.deadline), version: o.version ?? 1, closedAt: o.closed ? at(-1) : null, createdAt: at(o.created ?? -1),
    } })
    await owner.bookingRoom.create({ data: { tenantId, bookingId: b.id, roomName: 'Deluxe Sea View', boardCode: 'BB', adults: 2, children: 1, childAges: [6], sellMinor: o.sell ?? 100_000n } })
    if (o.guest !== null) await owner.bookingGuest.create({ data: { tenantId, bookingId: b.id, firstName: (o.guest ?? ['Amira', 'Haddad'])[0], lastName: (o.guest ?? ['Amira', 'Haddad'])[1], isLead: true } })
    await owner.bookingEvent.create({ data: { tenantId, bookingId: b.id, toStatus: o.status as never, actorType: 'SYSTEM', reason: 'fixture', payload: { backfill: true } } })
    ids[o.key] = b.id; refs[o.key] = ref
    return b
  }
  const get = (path: string, who: string) => { const r = request(app.getHttpServer()).get(`/api/v1/admin/operations${path}`); return who === 'anon' ? r : r.set('Cookie', cookies[who]) }
  const list = async (qs: string, who = 'ops'): Promise<BookingListPage> => (await get(`/bookings?${qs}`, who).expect(200)).body.data
  const detail = async (key: string, who = 'ops'): Promise<BookingDetailView> => (await get(`/bookings/${ids[key]}`, who).expect(200)).body.data
  const keysOf = (page: BookingListPage) => page.items.map((i) => Object.keys(ids).find((k) => ids[k] === i.id)).sort()

  beforeAll(async () => {
    await owner.$connect()
    tenantA = (await owner.tenant.create({ data: { name: suffix, slug: suffix } })).id
    tenantB = (await owner.tenant.create({ data: { name: `${suffix}-b`, slug: `${suffix}-b` } })).id
    const creator = (await owner.user.create({ data: { email: `${suffix}-creator@example.test`, name: 'creator' } })); userIds.push(creator.id)
    agencyX = (await owner.agency.create({ data: { tenantId: tenantA, code: `X-${suffix.slice(-6)}`.toUpperCase(), name: 'Travel Republic', countryCode: 'GB', createdById: creator.id } })).id
    agencyY = (await owner.agency.create({ data: { tenantId: tenantA, code: `Y-${suffix.slice(-6)}`.toUpperCase(), name: 'Atlas Getaways', countryCode: 'AE', createdById: creator.id } })).id
    hotelDubai = (await owner.hotel.create({ data: { tenantId: tenantA, name: `${suffix} Atlantis The Palm`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', timeZone: 'Asia/Dubai' } })).id
    hotelLondon = (await owner.hotel.create({ data: { tenantId: tenantA, name: `${suffix} Hoxton Shoreditch`, propertyType: 'HOTEL', city: 'London', countryCode: 'GB', timeZone: 'Europe/London' } })).id
    hotelB = (await owner.hotel.create({ data: { tenantId: tenantB, name: `${suffix} Other Operator Hotel`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE' } })).id

    //                                                                  one booking per status, then variations
    await booking({ key: '01', status: 'PENDING_SUPPLIER', agency: 'X', created: -2 })
    await booking({ key: '02', status: 'ON_REQUEST', agency: 'X', created: -3, supplierRef: null })
    await booking({ key: '03', status: 'CONFIRMED', agency: 'X', supplierRef: 'SUP-0003', hotelConf: 'HC-3', agentRef: 'TR-3', checkIn: 3, deadline: 1, refundable: false, net: 80_000n, payment: 'UNPAID', version: 2, sell: 100_000n })
    await booking({ key: '04', status: 'CONFIRMED', agency: 'Y', supplierRef: null, checkIn: 40, deadline: 20, refundable: true, net: null, payment: 'PAID', hotel: 'London', supplier: 'Supplier One', currency: 'GBP' })
    await booking({ key: '05', status: 'AMEND_REQUESTED', agency: 'Y', supplierRef: 'SUP-0005', checkIn: 10, deadline: 5, version: 2 })
    await booking({ key: '06', status: 'CANCEL_REQUESTED', agency: 'X', supplierRef: 'SUP-0006', checkIn: 12 })
    await booking({ key: '07', status: 'CANCELLED', agency: 'X', supplierRef: 'SUP-0007', created: -10 })
    await booking({ key: '08', status: 'CHECKED_OUT', agency: 'Y', supplierRef: 'SUP-0008', checkIn: -5, created: -20 })
    await booking({ key: '09', status: 'NO_SHOW', agency: 'Y', supplierRef: 'SUP-0009', checkIn: -4, created: -21 })
    await booking({ key: '10', status: 'REJECTED', agency: 'Y', created: -6 })
    await booking({ key: '11', status: 'FAILED', agency: 'X', created: -1, supplier: 'Regional DMC' })
    await booking({ key: '12', status: 'FAILED', agency: 'X', created: -30, closed: true })
    await booking({ key: '13', status: 'CONFIRMED', agency: null, supplierRef: 'SUP-0013', checkIn: 5 })           // Unassigned
    await booking({ key: '14', status: 'CONFIRMED', agency: 'X', supplierRef: 'SUP-0014', checkIn: null, guest: null }) // no stay dates, no guest recorded
    await booking({ key: '15', status: 'CONFIRMED', agency: 'X', supplierRef: 'SUP-0015', checkIn: -2, created: -9 })   // no-show candidate (check-in 2 days ago, still Confirmed)
    await booking({ key: 'B1', status: 'CONFIRMED', tenant: 'B', supplierRef: 'SUP-B1' })

    const PII = ['booking.read', 'booking.pii.view']; const NET = ['booking.read', 'booking.view.net']
    await user('ops', tenantA, ['booking.read']); await user('opspii', tenantA, PII); await user('opsnet', tenantA, NET); await user('opsall', tenantA, ['booking.read', 'booking.view.net', 'booking.pii.view'])
    await user('legacyowner', tenantA, [], 'owner')
    await user('agx', tenantA, ['booking.view.agency'], 'agent', agencyX); await user('agy', tenantA, ['booking.view.agency', 'booking.pii.view'], 'agent', agencyY)
    await user('agnone', tenantA, ['booking.view.agency']); await user('none', tenantA, []); await user('bops', tenantB, ['booking.read'])

    restoreOps = await enableBookingOps(owner)
    await provisionApiRuntimeRole(owner, { password: runtimePassword })
    previousUrl = process.env.DATABASE_URL
    const u = new URL(previousUrl as string); u.username = API_RUNTIME_LOGIN_ROLE; u.password = runtimePassword
    process.env.DATABASE_URL = u.toString(); process.env.ADMIN_ORIGIN = origin
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication(); app.use(cookieParser()); app.setGlobalPrefix('api/v1')
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
    app.useGlobalFilters(new HttpExceptionFilter()); app.useGlobalInterceptors(new ResponseInterceptor())
    await app.init()
    for (const label of ['ops', 'opspii', 'opsnet', 'opsall', 'legacyowner', 'agx', 'agy', 'agnone', 'none', 'bops']) {
      const r = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', origin).send({ email: `${suffix}-${label}@example.test`, password }).expect(200)
      cookies[label] = (r.headers['set-cookie'][0] as string).split(';')[0]
    }
  })

  afterAll(async () => {
    await app?.close(); restoreOps()
    if (previousUrl) process.env.DATABASE_URL = previousUrl
    for (const t of [tenantA, tenantB].filter(Boolean)) {
      for (const q of [`DELETE FROM "AuditEvent" WHERE tenant_id = '${t}'`, `DELETE FROM "Booking" WHERE tenant_id = '${t}'`, `DELETE FROM "AgencyMember" WHERE tenant_id = '${t}'`, `DELETE FROM "Agency" WHERE tenant_id = '${t}'`, `DELETE FROM "RoomType" WHERE hotel_id IN (SELECT id FROM "Hotel" WHERE tenant_id = '${t}')`, `DELETE FROM "Hotel" WHERE tenant_id = '${t}'`,
        `DELETE FROM "UserRole" WHERE tenant_id = '${t}'`, `DELETE FROM "RolePermission" WHERE role_id IN (SELECT id FROM "Role" WHERE tenant_id = '${t}')`, `DELETE FROM "Role" WHERE tenant_id = '${t}'`, `DELETE FROM memberships WHERE tenant_id = '${t}'`]) await owner.$executeRawUnsafe(q).catch(() => undefined)
    }
    await owner.session.deleteMany({ where: { userId: { in: userIds } } }); await owner.user.deleteMany({ where: { id: { in: userIds } } }); await owner.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB].filter(Boolean) } } })
    await owner.$disconnect()
  })

  it('BK-E01: authentication, authorization and tenant scope', async () => {
    await get('/bookings', 'anon').expect(401)
    await get('/bookings', 'none').expect(403)       // no booking permission at all
    await get('/bookings', 'agnone').expect(403)     // booking.view.agency but no agency membership: fail closed
    await get(`/bookings/${ids['01']}`, 'none').expect(403)
    const a = await list('chip=latest&pageSize=100', 'ops'); const b = await list('chip=latest&pageSize=100', 'bops')
    expect(a.total).toBe(15); expect(b.total).toBe(1); expect(keysOf(b)).toEqual(['B1'])
    expect(a.items.some((i) => i.id === ids.B1)).toBe(false)
    await get(`/bookings/${ids.B1}`, 'ops').expect(404)  // another operator's booking
    await get(`/bookings/${ids['01']}`, 'bops').expect(404)
    expect((await list('chip=latest', 'legacyowner')).access).toMatchObject({ level: 'OPERATOR', canViewNet: false, canViewPii: false }) // owner membership reads, but is never implied net or guest data
  })

  it('BK-E02: an agency-scoped caller sees only their agency; Unassigned and other agencies never leak; the scope cannot be widened from the query', async () => {
    const x = await list('chip=latest&pageSize=100', 'agx')
    expect(x.access).toMatchObject({ level: 'AGENCY', agencyId: agencyX })
    expect(x.items.every((i) => i.agency?.id === agencyX)).toBe(true)
    expect(keysOf(x)).toEqual(['01', '02', '03', '06', '07', '11', '12', '14', '15'])
    const y = await list('chip=latest&pageSize=100', 'agy'); expect(keysOf(y)).toEqual(['04', '05', '08', '09', '10'])
    expect(keysOf(x).includes('13')).toBe(false) // Unassigned: operator-level only
    await get(`/bookings/${ids['04']}`, 'agx').expect(404); await get(`/bookings/${ids['13']}`, 'agx').expect(404); await get(`/bookings/${ids['03']}`, 'agy').expect(404)
    await get(`/bookings?agencyId=${agencyY}`, 'agx').expect(403)
    await get('/bookings?agencyId=unassigned', 'agx').expect(403)
    expect((await list(`chip=latest&agencyId=${agencyX}&pageSize=100`, 'agx')).total).toBe(9) // naming your own agency is fine
    expect((await detail('03', 'agx')).operationsRecord).toBeNull() // internal finance and audit are operator-only
    expect((await detail('03', 'agx')).timeline.every((e) => e.kind === 'status')).toBe(true)
  })

  it('BK-E03: operators can filter by agency, including Unassigned', async () => {
    expect(keysOf(await list('chip=latest&agencyId=unassigned&pageSize=100'))).toEqual(['13'])
    expect(keysOf(await list(`chip=latest&agencyId=${agencyY}&pageSize=100`))).toEqual(['04', '05', '08', '09', '10'])
    expect(keysOf(await list(`chip=latest&agencyId=${agencyY},unassigned&pageSize=100`))).toEqual(['04', '05', '08', '09', '10', '13'])
    const row = (await list(`reference=${refs['03']}`)).items[0]
    expect(row.agency).toEqual({ id: agencyX, name: 'Travel Republic' })
  })

  it('BK-E04: guest names are masked without booking.pii.view and the unmasked read is audited without any name', async () => {
    const masked = await list('reference=' + refs['03'], 'ops')
    expect(masked.items[0].leadGuest).toEqual({ name: 'A••• H•••', masked: true })
    expect(JSON.stringify(masked)).not.toContain('Amira'); expect(JSON.stringify(masked)).not.toContain('Haddad')
    expect((await detail('03', 'ops')).guests).toEqual([expect.objectContaining({ name: 'A••• H•••', masked: true, isLead: true })])
    const before = await owner.auditEvent.count({ where: { tenantId: tenantA, action: { startsWith: 'booking.pii' } } })
    expect(before).toBe(1) // masked reads write no PII audit; the one row is the agency-Y reader (booking.pii.view) from BK-E02
    const open = await list('chip=latest&pageSize=100', 'opspii')
    expect(open.items.find((i) => i.id === ids['03'])?.leadGuest).toEqual({ name: 'Amira Haddad', masked: false })
    const d = await detail('03', 'opspii'); expect(d.guests[0]).toMatchObject({ name: 'Amira Haddad', masked: false })
    const events = (await owner.auditEvent.findMany({ where: { tenantId: tenantA, action: { startsWith: 'booking.pii' } }, orderBy: { createdAt: 'asc' } })).slice(before)
    expect(events.map((e) => e.action)).toEqual(['booking.pii.list_viewed', 'booking.pii.viewed'])
    expect(events[0].payload).toMatchObject({ bookingCount: 14 }) // 14 of the 15 in this tenant have a lead guest recorded
    expect(events[1]).toMatchObject({ entityType: 'booking', entityId: ids['03'] })
    expect(JSON.stringify(events.map((e) => e.payload))).not.toMatch(/Amira|Haddad/)
    expect(events.every((e) => e.userId)).toBe(true)
  })

  it('BK-E05: guest search needs booking.pii.view; with it, the search is literal and finds any guest', async () => {
    await get('/bookings?guest=amira', 'ops').expect(403)
    await get('/bookings?guest=amira', 'agx').expect(403)
    expect((await list('chip=latest&guest=hadd&pageSize=100', 'opspii')).total).toBe(14)
    expect((await list('chip=latest&guest=zzz', 'opspii')).total).toBe(0)
    expect((await list('chip=latest&guest=%25%25', 'opspii')).total).toBe(0) // "%%" is matched literally, not as a wildcard
    await get('/bookings?guest=a', 'opspii').expect(400)
    expect((await list('chip=latest&guest=hadd&pageSize=100', 'agy')).total).toBe(5) // an agency reader with the permission searches within their agency only
  })

  it('BK-E06: net rate, markup and margin appear only with booking.view.net; missing is not zero', async () => {
    const hidden = (await list('reference=' + refs['03'], 'ops')).items[0]
    expect(hidden).toMatchObject({ sellMinor: '100000', netMinor: null, marginMinor: null })
    const shown = (await list('reference=' + refs['03'], 'opsnet')).items[0]
    expect(shown).toMatchObject({ sellMinor: '100000', netMinor: '80000', marginMinor: '20000' })
    const unknown = (await list('reference=' + refs['04'], 'opsnet')).items[0]
    expect(unknown).toMatchObject({ netMinor: null, marginMinor: null }) // not recorded: null, never 0
    expect((await detail('03', 'ops')).pricing).toMatchObject({ netVisibility: 'HIDDEN_BY_PERMISSION', netMinor: null, markupMinor: null, marginMinor: null })
    expect((await detail('03', 'opsnet')).pricing).toMatchObject({ netVisibility: 'VISIBLE', netMinor: '80000', markupMinor: '20000', marginMinor: '20000', sellMinor: '100000', currency: 'AED', isRefundable: false })
    expect((await detail('04', 'opsnet')).pricing).toMatchObject({ netVisibility: 'NOT_RECORDED', netMinor: null, cancellationPolicy: null, markupRule: null })
    const agencyNet = await detail('03', 'agx'); expect(agencyNet.pricing.netMinor).toBeNull()
    expect(JSON.stringify(await list('chip=latest&pageSize=100', 'ops'))).not.toContain('80000')
  })

  it('BK-E07: one reference box finds the FBEDS reference, supplier reference, hotel confirmation number and agent reference', async () => {
    for (const q of [refs['03'], refs['03'].toLowerCase(), 'SUP-0003', 'sup-0003', 'HC-3', 'TR-3']) expect(keysOf(await list(`reference=${encodeURIComponent(q)}`))).toEqual(['03'])
    expect(keysOf(await list(`reference=${encodeURIComponent(refs['03'].slice(0, -2))}&pageSize=100`)).includes('03')).toBe(true) // reference prefix
    expect((await list('reference=NOPE-NOT-THERE')).total).toBe(0)
    await get(`/bookings?reference=${encodeURIComponent("x' OR 1=1 --")}`, 'ops').expect(400)
  })

  it('BK-E08: every quick search returns exactly its documented set', async () => {
    const expectKeys: Record<string, string[]> = {
      needsAction: ['01', '02', '04', '05', '06', '11'],         // statuses 1,2,5,6,failed-open + confirmed without supplier ref (04); 12 is closed
      latest: Object.keys(ids).filter((k) => k !== 'B1').sort(),
      checkInNext7: ['03', '13'],                                // not cancelled/failed/rejected, check-in today..+7 (05 is +10, 06 is +12)
      missingSupplierRef: ['04'],
      deadline48h: ['03'],                                       // deadline +1 day; 04/05 are later
      failed: ['11'],                                            // 12 is closed
      latestCancelled: ['07'],
      onRequest: ['02'],
      unpaid: ['03'],                                            // 04 is PAID; the rest are unknown, which is not unpaid
      noShowCandidates: ['15', '08', '09'].filter((k) => k === '15'), // Confirmed with check-in in the last 7 days
    }
    for (const [chip, keys] of Object.entries(expectKeys)) expect({ chip, keys: keysOf(await list(`chip=${chip}&pageSize=100`)) }).toEqual({ chip, keys: [...keys].sort() })
    // the server default is the unfiltered latest list; the Admin page opens on the Needs action chip
    expect(keysOf(await list('pageSize=100'))).toEqual(expectKeys.latest.slice().sort())
  })

  it('BK-E09: filters combine, multi-select works, and exact totals survive paging with no duplicates or gaps', async () => {
    expect(keysOf(await list('chip=latest&status=CONFIRMED,FAILED&pageSize=100'))).toEqual(['03', '04', '11', '12', '13', '14', '15'])
    expect(keysOf(await list('chip=latest&status=CONFIRMED&supplier=Supplier%20One'))).toEqual(['04'])
    expect(keysOf(await list('chip=latest&hotel=hoxton'))).toEqual(['04'])
    expect(keysOf(await list('chip=latest&hotel=dubai&pageSize=100')).includes('04')).toBe(false)
    expect((await list('chip=latest&hotel=nothing-like-this')).total).toBe(0)
    expect(keysOf(await list('chip=latest&dateType=checkIn&from=' + ymd(2) + '&to=' + ymd(6) + '&pageSize=100'))).toEqual(['03', '13'])
    expect(keysOf(await list('chip=latest&nonRefundable=true'))).toEqual(['03'])
    expect(keysOf(await list('chip=latest&amended=true&pageSize=100'))).toEqual(['03', '05'])
    expect(keysOf(await list('chip=latest&missingSupplierRef=true'))).toEqual(['04'])
    expect(keysOf(await list('chip=latest&paymentStatus=PAID'))).toEqual(['04'])
    const seen: string[] = []; let total = 0
    for (let page = 1; page <= 3; page++) { const p = await list(`chip=latest&pageSize=25&page=${page}&sort=amount&dir=asc`); total = p.total; seen.push(...p.items.map((i) => i.id)); if (!p.items.length) break }
    expect(total).toBe(15); expect(new Set(seen).size).toBe(seen.length); expect(seen).toHaveLength(15)
    const empty = await list('chip=latest&status=REJECTED&supplier=Regional%20DMC')
    expect(empty).toMatchObject({ total: 0, items: [] }); expect(empty.applied.map((a) => a.key)).toEqual(['chip', 'supplier', 'status'])
    for (const bad of ['status=PENDING', 'pageSize=30', 'chip=nope', 'dateType=booked', 'from=2030-02-31', 'sort=name']) await get(`/bookings?${bad}`, 'ops').expect(400)
  })

  it('BK-E10: rows carry hotel zone, deadline, the Unassigned and missing-reference facts, and sorting puts unknown dates last', async () => {
    const p = await list('chip=latest&pageSize=100&sort=checkIn&dir=asc')
    expect(p.items.at(-1)?.id).toBe(ids['14']) // no stay dates: last in both directions
    expect((await list('chip=latest&pageSize=100&sort=checkIn&dir=desc')).items.at(-1)?.id).toBe(ids['14'])
    const r04 = p.items.find((i) => i.id === ids['04'])!
    expect(r04).toMatchObject({ missingSupplierRef: true, supplierRef: null, hotel: { name: expect.stringContaining('Hoxton'), city: 'London', timeZone: 'Europe/London' }, room: { name: 'Deluxe Sea View', board: 'BB', quantity: 1 }, guests: { adults: 2, children: 1 }, currency: 'GBP', isRefundable: true })
    expect(p.items.find((i) => i.id === ids['13'])).toMatchObject({ agency: null })
    expect(p.items.find((i) => i.id === ids['03'])).toMatchObject({ amended: true, version: 2, checkIn: ymd(3), checkOut: ymd(5), nights: 2 })
    expect(p.items.find((i) => i.id === ids['14'])).toMatchObject({ checkIn: null, checkOut: null, nights: null, leadGuest: null })
  })

  it('BK-E11: detail by id or by reference, with the timeline, and an unreadable transaction record is labelled, never empty', async () => {
    const byRef = (await get(`/bookings/${refs['03'].toLowerCase()}`, 'ops').expect(200)).body.data as BookingDetailView
    expect(byRef.booking.id).toBe(ids['03']); expect((await detail('03')).booking.id).toBe(ids['03'])
    expect(byRef.booking).toMatchObject({ reference: refs['03'], hotelConfirmationNo: 'HC-3', agentRef: 'TR-3', specialRequests: null, channel: 'PORTAL' })
    expect(byRef.rooms).toEqual([expect.objectContaining({ roomName: 'Deluxe Sea View', boardCode: 'BB', adults: 2, children: 1, childAges: [6] })])
    expect(byRef.timeline[0]).toMatchObject({ kind: 'status', toStatus: 'CONFIRMED', backfilled: true, actorType: 'SYSTEM' })
    // the API role cannot read the transaction tables, so the existing record is "unavailable", not an empty record
    expect(byRef.operationsRecord).toEqual({ state: 'unavailable', reason: OPERATIONS_READ_DENIED })
    await get('/bookings/not%20valid!', 'ops').expect(400); await get('/bookings/does-not-exist', 'ops').expect(404)
  })

  it('BK-E12: reconciliation flags are unknown, not empty, when their evidence is unreadable; the flag filter says so', async () => {
    const p = await list('chip=latest&pageSize=100')
    expect(p.attentionAvailable).toBe(false); expect(p.items.every((i) => i.attention === null)).toBe(true)
    const denied = await get('/bookings?attention=true', 'ops').expect(503)
    expect(denied.body.error?.code ?? denied.body.code).toBe(OPERATIONS_READ_DENIED)
  })

  it('BK-E13: reading changes nothing: no booking, room, guest or event row changes and no business audit is written for masked reads', async () => {
    const snap = async () => JSON.stringify([await owner.booking.findMany({ where: { tenantId: tenantA }, orderBy: { id: 'asc' }, select: { id: true, status: true, version: true, updatedAt: true } }), await owner.bookingEvent.count({ where: { tenantId: tenantA } })])
    const before = await snap(); const audits = await owner.auditEvent.count({ where: { tenantId: tenantA, action: { not: 'tenant.context.selected' } } })
    for (let i = 0; i < 3; i++) { await list('chip=latest&pageSize=100', 'ops'); await detail('03', 'ops'); await list('chip=needsAction', 'agx') }
    expect(await snap()).toBe(before)
    expect(await owner.auditEvent.count({ where: { tenantId: tenantA, action: { not: 'tenant.context.selected' } } })).toBe(audits)
  })
})
