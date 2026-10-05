import { randomBytes } from 'crypto'
import { INestApplication, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { PrismaClient } from '@prisma/client'
import * as cookieParser from 'cookie-parser'
import * as request from 'supertest'
import { AppModule } from '../src/app.module'
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter'
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor'
import { hashPassword } from '../src/auth/utils/password'
import { PrismaService } from '../src/database/prisma.service'
import { provisionApiRuntimeRole, API_RUNTIME_LOGIN_ROLE } from '../src/database/api-runtime-role'
import { RateCertificationService } from '../src/rate-certification/rate-certification.service'
import { CommercialControlUnavailableError } from '../src/supply/commercial-controls'

jest.setTimeout(180_000)

/**
 * Rate plan audit and certification over HTTP, against the real AppModule and PostgreSQL, with two tenants.
 * Dates are relative to today (UTC). Every number asserted is derived from the fixtures below.
 */
describe('rate plan audit and certification (PostgreSQL, HTTP, two tenants)', () => {
  const prisma = new PrismaClient()
  const suffix = `rc-${Date.now()}-${randomBytes(3).toString('hex')}`
  const password = 'rate-certification-certification-password'
  const base = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z').getTime()
  const utc = (offset: number) => new Date(base + offset * 86_400_000)
  const day = (offset: number) => utc(offset).toISOString().slice(0, 10)
  const FROM = day(10); const DAYS = 5 // assessed window d+10 .. d+14
  const win = `from=${FROM}&days=${DAYS}`
  const q = { from: FROM, days: String(DAYS) }
  let app: INestApplication
  let tenantA = '', tenantB = '', supplierA = '', supplierB = '', boardA = '', boardB = '', ownerUserId = ''
  const userIds: string[] = []; const roleIds: string[] = []
  const cookies: Record<string, string> = {}
  const hotels: Record<string, { id: string; name: string; planId: string; plan2Id?: string; contractId: string; roomId: string }> = {}

  type RateOpts = { amount?: bigint; basis?: 'SELL' | 'NET' | null; currency?: string; zeroDays?: number[]; rateEnd?: number }
  async function makeHotel(key: string, o: RateOpts & { tenant?: 'A' | 'B'; plan?: 'ACTIVE' | 'DRAFT'; duplicate?: boolean } = {}) {
    const tenantId = o.tenant === 'B' ? tenantB : tenantA
    const supplierId = o.tenant === 'B' ? supplierB : supplierA
    const boardBasisId = o.tenant === 'B' ? boardB : boardA
    const hotel = await prisma.hotel.create({ data: { tenantId, name: `${suffix} ${key}`, externalRef: `${key}-${suffix.slice(-6)}`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', contentStatus: 'COMPLETE', starRating: 5 } })
    const room = await prisma.roomType.create({ data: { hotelId: hotel.id, name: 'Deluxe', code: `D-${key}`.slice(0, 40), maxAdults: 2, maxChildren: 0, maxOccupancy: 2 } })
    const mapping = await prisma.supplierHotelMapping.create({ data: { tenantId, supplierId, hotelId: hotel.id, supplierHotelId: `${suffix}-${key}`, status: 'MAPPED' } })
    await prisma.supplierRoomMapping.create({ data: { tenantId, supplierHotelMappingId: mapping.id, hotelId: hotel.id, supplierRoomId: `${suffix}-${key}-r`, roomTypeId: room.id, status: 'MAPPED' } })
    const contract = await prisma.contract.create({ data: { tenantId, supplierId, supplierHotelMappingId: mapping.id, code: `${suffix}-${key}`, status: 'ACTIVE', validFrom: utc(-400), validTo: utc(4000), settlementCurrency: 'AED' } })
    const range = Array.from({ length: 16 }, (_, i) => 8 + i).filter((offset) => offset <= (o.rateEnd ?? 23))
    const plans: string[] = []
    for (const code of o.duplicate ? [`${key.toUpperCase()}-BB`, `${key.toUpperCase()}-BB-COPY`] : [`${key.toUpperCase()}-BB`]) {
      const plan = await prisma.ratePlan.create({ data: { tenantId, contractId: contract.id, roomTypeId: room.id, boardBasisId, code, status: (o.plan ?? 'ACTIVE') as never, occupancy: 2, currency: 'AED', minStay: 1 } })
      plans.push(plan.id)
      await prisma.dailyRate.createMany({ data: range.map((offset) => ({ tenantId, ratePlanId: plan.id, stayDate: utc(offset), occupancy: 2, amountMinor: (o.zeroDays ?? []).includes(offset) ? 0n : o.amount ?? 45_000n, currency: o.currency ?? 'AED', amountBasis: o.basis === undefined ? 'SELL' as const : o.basis })) })
      await prisma.dailyAvailability.createMany({ data: Array.from({ length: 16 }, (_, i) => ({ tenantId, ratePlanId: plan.id, stayDate: utc(8 + i), allotment: 5, sold: 0 })) })
    }
    hotels[key] = { id: hotel.id, name: hotel.name, planId: plans[0], plan2Id: plans[1], contractId: contract.id, roomId: room.id }
  }

  async function user(label: string, tenantId: string, permissionKeys: string[], role = 'agent') {
    const email = `${suffix}-${label}@example.test`
    const u = await prisma.user.create({ data: { email, passwordHash: await hashPassword(password), status: 'ACTIVE' } })
    userIds.push(u.id)
    await prisma.membership.create({ data: { tenantId, userId: u.id, role } })
    if (permissionKeys.length) {
      const r = await prisma.role.create({ data: { tenantId, name: `${suffix}-${label}` } }); roleIds.push(r.id)
      for (const key of permissionKeys) {
        const p = await prisma.permission.upsert({ where: { key }, update: {}, create: { key, description: key } })
        await prisma.rolePermission.create({ data: { roleId: r.id, permissionId: p.id } })
      }
      await prisma.userRole.create({ data: { tenantId, userId: u.id, roleId: r.id } })
    }
    return { email, id: u.id }
  }
  async function login(email: string) {
    const response = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', 'http://localhost:3001').send({ email, password }).expect(200)
    return (response.headers['set-cookie'][0] as string).split(';')[0]
  }
  const url = (path: string) => `/api/v1/admin/rate-certification${path}`
  const get = (path: string, who = 'owner') => { const r = request(app.getHttpServer()).get(url(path)); return who === 'anon' ? r : r.set('Cookie', cookies[who]) }
  const post = (path: string, body: unknown, who = 'owner') => { const r = request(app.getHttpServer()).post(url(path)).set('Origin', 'http://localhost:3001').send(body as object); return who === 'anon' ? r : r.set('Cookie', cookies[who]) }
  const stripClock = <T extends { generatedAt?: string }>(value: T) => ({ ...value, generatedAt: undefined })
  const rule = (data: { scope: 'TENANT_DEFAULT' | 'HOTEL'; hotelId?: string; basisPoints: number }) => prisma.commercialMarkupRule.create({ data: { tenantId: tenantA, scope: data.scope, hotelId: data.hotelId ?? null, basisPoints: data.basisPoints, validFrom: utc(-30), status: 'ACTIVE', reason: 'rate certification fixture', createdById: ownerUserId, activatedAt: new Date() } })
  const snapshot = async () => ({
    rates: await prisma.dailyRate.findMany({ where: { tenantId: { in: [tenantA, tenantB] } }, orderBy: { id: 'asc' } }),
    plans: await prisma.ratePlan.findMany({ where: { tenantId: { in: [tenantA, tenantB] } }, orderBy: { id: 'asc' } }),
    contracts: await prisma.contract.findMany({ where: { tenantId: { in: [tenantA, tenantB] } }, orderBy: { id: 'asc' } }),
    rules: await prisma.commercialMarkupRule.findMany({ where: { tenantId: { in: [tenantA, tenantB] } }, orderBy: { id: 'asc' } }),
    availability: await prisma.dailyAvailability.count({ where: { tenantId: { in: [tenantA, tenantB] } } }),
    // TenantContextGuard records tenant.context.selected on every authenticated request and denials record permission.denied: both are
    // existing platform behaviour. No audit event of any other kind may appear, because this module performs no privileged or financial mutation.
    audit: await prisma.auditEvent.count({ where: { tenantId: { in: [tenantA, tenantB] }, action: { notIn: ['permission.denied', 'tenant.context.selected'] } } }),
  })

  beforeAll(async () => {
    await prisma.$connect()
    tenantA = (await prisma.tenant.create({ data: { name: `${suffix} A`, slug: `${suffix}-a` } })).id
    tenantB = (await prisma.tenant.create({ data: { name: `${suffix} B`, slug: `${suffix}-b` } })).id
    supplierA = (await prisma.supplier.create({ data: { tenantId: tenantA, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${suffix} sA`, displayName: 'Supplier Alpha', countryCode: 'AE', defaultCurrency: 'AED' } })).id
    supplierB = (await prisma.supplier.create({ data: { tenantId: tenantB, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${suffix} sB`, displayName: 'Supplier Beta', countryCode: 'AE', defaultCurrency: 'AED' } })).id
    boardA = (await prisma.boardBasis.create({ data: { tenantId: tenantA, code: 'BB', name: 'Bed and breakfast' } })).id
    boardB = (await prisma.boardBasis.create({ data: { tenantId: tenantB, code: 'BB', name: 'Bed and breakfast' } })).id

    await makeHotel('alpha')                                         // clean SELL            PASS      CERTIFIED
    await makeHotel('bravo', { zeroDays: [12, 13] })                 // two zero amounts       FAIL      NOT_READY
    await makeHotel('charlie', { basis: 'NET' })                     // NET, no markup rule    FAIL      NOT_READY (until a rule exists)
    await makeHotel('delta', { rateEnd: 12 })                        // rate gap (d+13, d+14)  WARN      READY_WITH_WARNINGS
    await makeHotel('echo', { plan: 'DRAFT' })                       // inactive plan          not live  NOT_READY (no live plan)
    await makeHotel('foxtrot', { duplicate: true })                  // logical duplicate      2 x FAIL  NOT_READY
    await makeHotel('golf', { basis: null })                         // unverified basis       FAIL      NOT_READY
    await makeHotel('hotel', { currency: 'USD' })                    // wrong-currency rows    FAIL      NOT_READY
    await makeHotel('oscar', { tenant: 'B', zeroDays: [10] })        // tenant B: one zero amount

    const owner = await user('owner', tenantA, ['supply.rates.read', 'supply.hotels.read'], 'owner'); ownerUserId = owner.id
    const viewer = await user('viewer', tenantA, ['supply.hotels.read'])
    const none = await user('none', tenantA, [])
    const bowner = await user('bowner', tenantB, ['supply.rates.read'], 'owner')

    const module = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = module.createNestApplication()
    app.use(cookieParser()); app.setGlobalPrefix('api/v1')
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
    app.useGlobalFilters(new HttpExceptionFilter()); app.useGlobalInterceptors(new ResponseInterceptor())
    await app.init()
    cookies.owner = await login(owner.email); cookies.viewer = await login(viewer.email); cookies.none = await login(none.email); cookies.bowner = await login(bowner.email)
  })

  afterAll(async () => {
    await app?.close()
    for (const tenantId of [tenantA, tenantB].filter(Boolean)) {
      await prisma.commercialMarkupRule.deleteMany({ where: { tenantId } })
      await prisma.auditEvent.deleteMany({ where: { tenantId } })
      await prisma.dailyRate.deleteMany({ where: { tenantId } })
      await prisma.dailyAvailability.deleteMany({ where: { tenantId } })
      await prisma.ratePlan.deleteMany({ where: { tenantId } })
      await prisma.contract.deleteMany({ where: { tenantId } })
      await prisma.supplierRoomMapping.deleteMany({ where: { tenantId } })
      await prisma.supplierHotelMapping.deleteMany({ where: { tenantId } })
      await prisma.boardBasis.deleteMany({ where: { tenantId } })
      await prisma.roomType.deleteMany({ where: { hotel: { tenantId } } })
      await prisma.hotel.deleteMany({ where: { tenantId } })
      await prisma.supplier.deleteMany({ where: { tenantId } })
      await prisma.userRole.deleteMany({ where: { tenantId } })
      await prisma.rolePermission.deleteMany({ where: { role: { tenantId } } })
      await prisma.role.deleteMany({ where: { tenantId } })
      await prisma.membership.deleteMany({ where: { tenantId } })
    }
    await prisma.session.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.user.deleteMany({ where: { id: { in: userIds } } })
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB].filter(Boolean) } } })
    await prisma.$disconnect()
  })

  const planRow = async (key: string, which: 'planId' | 'plan2Id' = 'planId') => (await get(`/plans/${hotels[key][which]}?${win}`).expect(200)).body.data
  const hotelStatus = async (key: string) => (await get(`/hotels?${win}&q=${encodeURIComponent(hotels[key].name)}`).expect(200)).body.data.items.find((h: { hotelId: string }) => h.hotelId === hotels[key].id)?.status

  it('RC-E-01 summary: exact plan, hotel, row-class and finding counts (NET rates have no markup rule yet)', async () => {
    const s = (await get(`/summary?${win}`).expect(200)).body.data
    expect(s.window).toEqual({ from: FROM, to: day(14), days: DAYS })
    expect(s.totals).toEqual({ hotels: 8, plans: 9, livePlans: 8 }) // tenant A only: oscar belongs to tenant B
    expect(s.plans).toEqual({ PASS: 1, WARN: 1, FAIL: 6 })
    expect(s.hotels).toEqual({ NOT_READY: 6, READY_WITH_WARNINGS: 1, CERTIFIED: 1 })
    expect(s.rowClasses).toEqual({ VALID: 26, QUARANTINED: 12, DEAD: 0, OUTSIDE_CONTRACT: 0, BLOCKED_NO_MARKUP: 5 })
    const by = Object.fromEntries(s.findings.map((f: { code: string }) => [f.code, f]))
    expect(by.RATE_AMOUNT_ZERO).toMatchObject({ severity: 'FAIL', plans: 1, count: 2 })
    expect(by.NET_MARKUP_MISSING).toMatchObject({ plans: 1, count: 5 })
    expect(by.RATE_BASIS_UNVERIFIED).toMatchObject({ plans: 1, count: 5 })
    expect(by.RATE_CURRENCY_MISMATCH).toMatchObject({ plans: 1, count: 5 })
    expect(by.DUPLICATE_LOGICAL_PLAN).toMatchObject({ plans: 2 })
    expect(by.RATE_GAPS).toMatchObject({ severity: 'WARN', plans: 1, count: 2 })
    expect(s.remediation.P0).toBeGreaterThan(0)
    expect(s.scanCapped).toBe(false)
  })

  it('RC-E-02 authentication and authorization: 401 anonymous, 403 without supply.rates.read (including hotel-read only), tenant B sees only tenant B', async () => {
    for (const path of ['/summary', '/plans', `/plans/${hotels.alpha.planId}`, '/hotels', '/markup-rules', '/remediation', '/report']) {
      await get(path, 'anon').expect(401)
      await get(path, 'none').expect(403)
      await get(path, 'viewer').expect(403)
      await get(path, 'owner').expect(200)
    }
    await post('/simulate', { ratePlanId: hotels.alpha.planId, checkIn: day(10), checkOut: day(12), adults: 2 }, 'anon').expect(401)
    await post('/simulate', { ratePlanId: hotels.alpha.planId, checkIn: day(10), checkOut: day(12), adults: 2 }, 'viewer').expect(403)
    const b = (await get(`/summary?${win}`, 'bowner').expect(200)).body.data
    expect(b.totals).toEqual({ hotels: 1, plans: 1, livePlans: 1 })
    expect(b.rowClasses.QUARANTINED).toBe(1)
    await get(`/plans/${hotels.alpha.planId}?${win}`, 'bowner').expect(404)                       // another tenant's plan
    await post('/simulate', { ratePlanId: hotels.alpha.planId, checkIn: day(10), checkOut: day(12), adults: 2 }, 'bowner').expect(404)
    await get(`/plans/${hotels.oscar.planId}?${win}`).expect(404)                                   // and the other way round
    await get('/plans/not an id!').expect(400)
  })

  it('RC-E-03 plan detail: a zero amount is quarantined night by night and the contract and calendar are explained', async () => {
    const d = await planRow('bravo')
    expect(d).toMatchObject({ code: 'BRAVO-BB', live: true, status: 'FAIL', occupancy: 2, currency: 'AED', rowClasses: { VALID: 3, QUARANTINED: 2, DEAD: 0, OUTSIDE_CONTRACT: 0, BLOCKED_NO_MARKUP: 0 } })
    expect(d.findings.find((f: { code: string }) => f.code === 'RATE_AMOUNT_ZERO')).toMatchObject({ severity: 'FAIL', count: 2, sample: [day(12), day(13)] })
    expect(d.calendar).toHaveLength(DAYS)
    expect(d.calendar.map((c: { rowClass: string }) => c.rowClass)).toEqual(['VALID', 'VALID', 'QUARANTINED', 'QUARANTINED', 'VALID'])
    expect(d.calendar[2]).toMatchObject({ date: day(12), rateMinor: '0', basis: 'SELL' })
    expect(d.contract).toMatchObject({ settlementCurrency: 'AED', salesMarkets: [], nationalities: [] })
    expect((await planRow('alpha')).findings).toEqual([])
    expect((await planRow('echo'))).toMatchObject({ live: false, status: 'PASS', findings: [{ code: 'PLAN_NOT_LIVE', severity: 'INFO' }] })
  })

  it('RC-E-04 hotel distribution status follows the plan results, and nothing is certified by default', async () => {
    expect(await hotelStatus('alpha')).toBe('CERTIFIED')
    expect(await hotelStatus('delta')).toBe('READY_WITH_WARNINGS')
    for (const key of ['bravo', 'charlie', 'echo', 'foxtrot', 'golf', 'hotel']) expect({ key, status: await hotelStatus(key) }).toEqual({ key, status: 'NOT_READY' })
    const echo = (await get(`/hotels?${win}&status=NOT_READY&q=${encodeURIComponent(hotels.echo.name)}`).expect(200)).body.data.items[0]
    expect(echo.blockers).toContain('No live rate plan')
    await get(`/hotels?${win}&status=NOPE`).expect(400)
  })

  it('RC-E-05 plan list: filters, search and pagination are exact; invalid input is 400', async () => {
    const all = (await get(`/plans?${win}&pageSize=100`).expect(200)).body.data
    expect(all.total).toBe(9)
    expect((await get(`/plans?${win}&status=FAIL`).expect(200)).body.data.total).toBe(6)
    expect((await get(`/plans?${win}&status=WARN`).expect(200)).body.data.items.map((p: { code: string }) => p.code)).toEqual(['DELTA-BB'])
    expect((await get(`/plans?${win}&live=false`).expect(200)).body.data.items.map((p: { code: string }) => p.code)).toEqual(['ECHO-BB'])
    expect((await get(`/plans?${win}&finding=DUPLICATE_LOGICAL_PLAN`).expect(200)).body.data.total).toBe(2)
    expect((await get(`/plans?${win}&hotelId=${hotels.foxtrot.id}`).expect(200)).body.data.total).toBe(2)
    expect((await get(`/plans?${win}&q=bravo`).expect(200)).body.data.total).toBe(1)
    const p1 = (await get(`/plans?${win}&pageSize=4&page=1`).expect(200)).body.data; const p3 = (await get(`/plans?${win}&pageSize=4&page=3`).expect(200)).body.data
    expect(p1.items).toHaveLength(4); expect(p3.items).toHaveLength(1); expect(p1.total).toBe(9)
    for (const bad of ['status=MAYBE', 'finding=lowercase', 'live=perhaps', 'pageSize=0', 'pageSize=101', 'page=0', 'days=0', 'days=366', 'from=tomorrow']) await get(`/plans?${bad}`).expect(400)
  })

  it('RC-E-06 remediation queue: ordered P0 then P1 then P2, filterable, deterministic ids, text only', async () => {
    const queue = (await get(`/remediation?${win}&pageSize=100`).expect(200)).body.data
    const order = queue.items.map((i: { priority: string }) => i.priority)
    expect(order).toEqual([...order].sort())
    expect(queue.counts.P0 + queue.counts.P1 + queue.counts.P2).toBe(queue.total)
    expect(new Set(queue.items.map((i: { id: string }) => i.id)).size).toBe(queue.items.length)
    const p0 = queue.items.filter((i: { priority: string }) => i.priority === 'P0')
    expect(p0.map((i: { code: string }) => i.code)).toEqual(expect.arrayContaining(['RATE_AMOUNT_ZERO', 'NET_MARKUP_MISSING', 'RATE_BASIS_UNVERIFIED', 'RATE_CURRENCY_MISMATCH']))
    expect(queue.items.every((i: { suggestedAction: string; ratePlanId: string | null }) => i.suggestedAction.length > 0 && typeof i.ratePlanId !== 'undefined')).toBe(true)
    expect((await get(`/remediation?${win}&priority=P0&hotelId=${hotels.bravo.id}`).expect(200)).body.data.items.map((i: { code: string }) => i.code)).toEqual(['RATE_AMOUNT_ZERO'])
    await get(`/remediation?${win}&priority=P9`).expect(400)
    const again = (await get(`/remediation?${win}&pageSize=100`).expect(200)).body.data
    expect(stripClock(again)).toEqual(stripClock(queue))
  })

  it('RC-E-07 simulator: the SELL total equals the Sellability Inspector total, rooms multiply, refusals carry evaluator reasons and no total', async () => {
    const sim = (await post('/simulate', { ratePlanId: hotels.alpha.planId, checkIn: day(10), checkOut: day(13), adults: 2 }).expect(200)).body.data
    expect(sim).toMatchObject({ eligible: true, currency: 'AED', totalMinor: '135000', netMinor: '135000', markupMinor: '0', recomputedTotalMinor: '135000', reconciles: true, rooms: 1 })
    expect(sim.nights.map((n: { sellMinor: string }) => n.sellMinor)).toEqual(['45000', '45000', '45000'])
    const two = (await post('/simulate', { ratePlanId: hotels.alpha.planId, checkIn: day(10), checkOut: day(13), adults: 2, rooms: 2 }).expect(200)).body.data
    expect(two).toMatchObject({ totalMinor: '270000', reconciles: true })
    // the existing Sellability Inspector (same evaluator) prices the same stay: the two answers must be identical
    const inspected = (await request(app.getHttpServer()).get(`/api/v1/admin/operations/hotels/${hotels.alpha.id}/sellability?checkIn=${day(10)}&checkOut=${day(13)}&adults=2`).set('Cookie', cookies.owner).expect(200)).body.data
    expect(inspected.plans.find((p: { ratePlanId: string }) => p.ratePlanId === hotels.alpha.planId)).toMatchObject({ sellable: true, totalMinor: sim.totalMinor, currency: sim.currency })
    const wrongParty = (await post('/simulate', { ratePlanId: hotels.alpha.planId, checkIn: day(10), checkOut: day(13), adults: 1 }).expect(200)).body.data
    expect(wrongParty).toMatchObject({ eligible: false, totalMinor: null, reasons: ['OCCUPANCY_UNSUPPORTED'] })
    const missing = (await post('/simulate', { ratePlanId: hotels.delta.planId, checkIn: day(12), checkOut: day(15), adults: 2 }).expect(200)).body.data
    expect(missing).toMatchObject({ eligible: false, totalMinor: null })
    expect(missing.reasons).toContain('DAILY_RATE_MISSING_OR_INVALID')
    const noRule = (await post('/simulate', { ratePlanId: hotels.charlie.planId, checkIn: day(10), checkOut: day(12), adults: 2 }).expect(200)).body.data
    expect(noRule).toMatchObject({ eligible: false, totalMinor: null, recomputedTotalMinor: null })
    expect(noRule.reasons).toContain('NET_RATE_MARKUP_UNAVAILABLE')
    for (const bad of [{}, { ratePlanId: hotels.alpha.planId }, { ratePlanId: hotels.alpha.planId, checkIn: day(10), checkOut: day(10), adults: 2 }, { ratePlanId: hotels.alpha.planId, checkIn: day(10), checkOut: day(60), adults: 2 }, { ratePlanId: hotels.alpha.planId, checkIn: day(10), checkOut: day(12), adults: 0 }, { ratePlanId: hotels.alpha.planId, checkIn: day(10), checkOut: day(12) }, { ratePlanId: hotels.alpha.planId, checkIn: 'soon', checkOut: day(12), adults: 2 }]) {
      await post('/simulate', bad).expect(400)
    }
  })

  it('RC-E-08 a NET plan becomes PASS once an ACTIVE markup rule exists; the simulator shows the half-up markup and reconciles', async () => {
    await rule({ scope: 'TENANT_DEFAULT', basisPoints: 1000 })
    const d = await planRow('charlie')
    expect(d).toMatchObject({ status: 'PASS', amountBasis: 'NET', findings: [], rowClasses: { VALID: 5, QUARANTINED: 0, DEAD: 0, OUTSIDE_CONTRACT: 0, BLOCKED_NO_MARKUP: 0 } })
    expect(await hotelStatus('charlie')).toBe('CERTIFIED')
    const sim = (await post('/simulate', { ratePlanId: hotels.charlie.planId, checkIn: day(10), checkOut: day(12), adults: 2 }).expect(200)).body.data
    // 45000 + half-up 10% (4500) = 49500 per night
    expect(sim.nights[0]).toMatchObject({ rateMinor: '45000', basis: 'NET', markupBasisPoints: 1000, markupMinor: '4500', sellMinor: '49500' })
    expect(sim).toMatchObject({ eligible: true, netMinor: '90000', markupMinor: '9000', totalMinor: '99000', recomputedTotalMinor: '99000', reconciles: true })
    const s = (await get(`/summary?${win}`).expect(200)).body.data
    expect(s.hotels).toEqual({ NOT_READY: 5, READY_WITH_WARNINGS: 1, CERTIFIED: 2 })
    expect(s.rowClasses).toMatchObject({ BLOCKED_NO_MARKUP: 0, VALID: 31 })
  })

  it('RC-E-09 markup rule audit: zero and very high ACTIVE rules warn; the tenant default is clean', async () => {
    await rule({ scope: 'HOTEL', hotelId: hotels.foxtrot.id, basisPoints: 0 })
    await rule({ scope: 'HOTEL', hotelId: hotels.echo.id, basisPoints: 6000 })
    const m = (await get('/markup-rules').expect(200)).body.data
    expect(m.counts).toEqual({ total: 3, active: 3, draft: 0, retired: 0, other: 0 })
    const codes = (id: string) => m.rules.find((r: { hotelId: string | null }) => r.hotelId === id).findings.map((f: { code: string }) => f.code)
    expect(codes(hotels.foxtrot.id)).toEqual(['MARKUP_ZERO_PERCENT'])
    expect(codes(hotels.echo.id)).toEqual(['MARKUP_VERY_HIGH'])
    expect(m.rules.find((r: { scope: string }) => r.scope === 'TENANT_DEFAULT').findings).toEqual([])
    expect(m.netPlansWithoutMarkup).toBe(0)
    expect((await get('/markup-rules', 'bowner').expect(200)).body.data.counts.total).toBe(0)
  })

  it('RC-E-10 the audit is strictly read-only: no row, timestamp or audit event changes across every route', async () => {
    const before = await snapshot()
    for (const path of ['/summary', '/plans', `/plans/${hotels.bravo.planId}`, '/hotels', '/markup-rules', '/remediation', '/report?format=markdown', '/report']) await get(`${path}${path.includes('?') ? '&' : '?'}${win}`).expect(200)
    await post('/simulate', { ratePlanId: hotels.charlie.planId, checkIn: day(10), checkOut: day(12), adults: 2 }).expect(200)
    await post('/simulate', { ratePlanId: hotels.bravo.planId, checkIn: day(10), checkOut: day(15), adults: 2, rooms: 3 }).expect(200)
    expect(await snapshot()).toEqual(before)
  })

  it('RC-E-11 report: JSON and Markdown agree with the summary, are deterministic, and carry the applicability notes and no secrets', async () => {
    const summary = (await get(`/summary?${win}`).expect(200)).body.data
    const json = (await get(`/report?${win}`).expect(200)).body.data
    expect(json).toMatchObject({ mediaType: 'application/json', filename: expect.stringMatching(/^rate-certification-\d{4}-\d{2}-\d{2}\.json$/) })
    const parsed = JSON.parse(json.content)
    expect(stripClock(parsed.summary)).toEqual(stripClock(summary))
    expect(parsed.plans).toHaveLength(9); expect(parsed.hotels).toHaveLength(8)
    const md = (await get(`/report?${win}&format=markdown`).expect(200)).body.data
    expect(md.mediaType).toBe('text/markdown')
    expect(md.content).toContain('# Rate plan audit and distribution certification')
    expect(md.content).toContain('## Not applicable to fBeds')
    expect(md.content).toContain('Pricing layers and promotions')
    expect(md.content).toContain(`| Plans PASS / WARN / FAIL | ${summary.plans.PASS} / ${summary.plans.WARN} / ${summary.plans.FAIL} |`)
    expect(md.content).toContain(`| VALID | ${summary.rowClasses.VALID} |`)
    expect(md.content).not.toMatch(/password|token|secret|credential/i)
    const again = (await get(`/report?${win}&format=markdown`).expect(200)).body.data
    expect(again.content.replace(/Generated \S+/, '')).toBe(md.content.replace(/Generated \S+/, ''))
    await get(`/report?${win}&format=pdf`).expect(400)
  })

  it('RC-E-12 the same request twice returns the same answer', async () => {
    const [a, b] = [(await get(`/plans?${win}&pageSize=100`).expect(200)).body.data, (await get(`/plans?${win}&pageSize=100`).expect(200)).body.data]
    expect(stripClock(a)).toEqual(stripClock(b))
  })

  it('RC-E-13 strict runtime role: every view reads on the non-bypass role, matches the owner-role result, and a denied markup read fails closed', async () => {
    const owner = new PrismaClient()
    const runtimePassword = randomBytes(24).toString('hex')
    const previous = process.env.DATABASE_URL
    let runtime: PrismaService | undefined
    try {
      await provisionApiRuntimeRole(owner, { password: runtimePassword })
      const u = new URL(previous as string); u.username = API_RUNTIME_LOGIN_ROLE; u.password = runtimePassword
      runtime = new PrismaService({ datasourceUrl: u.toString() } as never)
      await runtime.$connect()
      const [who] = await runtime.$queryRawUnsafe<Array<{ current_user: string; rolbypassrls: boolean; rolsuper: boolean }>>('SELECT current_user, (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS rolbypassrls, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS rolsuper')
      expect(who).toEqual({ current_user: API_RUNTIME_LOGIN_ROLE, rolbypassrls: false, rolsuper: false })
      const strict = new RateCertificationService(runtime); const open = new RateCertificationService(new PrismaService())
      const clock = new Date(base + 12 * 3_600_000); strict.clock = () => clock; open.clock = () => clock
      expect(stripClock(await strict.summary(tenantA, q))).toEqual(stripClock(await open.summary(tenantA, q)))
      expect((await strict.summary(tenantB, q)).totals).toEqual({ hotels: 1, plans: 1, livePlans: 1 })
      expect(stripClock(await strict.plan(tenantA, hotels.bravo.planId, q))).toEqual(stripClock(await open.plan(tenantA, hotels.bravo.planId, q)))
      await expect(strict.plan(tenantB, hotels.bravo.planId, q)).rejects.toMatchObject({ status: 404 })
      const sim = await strict.simulate(tenantA, { ratePlanId: hotels.charlie.planId, checkIn: day(10), checkOut: day(12), adults: 2 })
      expect(sim).toMatchObject({ eligible: true, totalMinor: '99000', reconciles: true })
      expect((await strict.report(tenantA, { ...q, format: 'markdown' })).content).toContain('Rate plan audit')
      expect((await strict.remediation(tenantA, q)).total).toBeGreaterThan(0)

      // bounded work: with a budget of one hotel's plan-nights only the first hotel by name is audited, and the response says so
      const bounded = new RateCertificationService(runtime); bounded.clock = () => clock; bounded.planNightBudget = DAYS
      const capped = await bounded.summary(tenantA, q)
      expect(capped).toMatchObject({ scanCapped: true, totals: { hotels: 1, plans: 1 } })
      expect(stripClock(await strict.summary(tenantA, q))).toMatchObject({ scanCapped: false, totals: { hotels: 8 } })

      // failure injection: without SELECT on the markup rules a NET plan must not be reported as unpriced, the view refuses instead
      await owner.$executeRawUnsafe('REVOKE SELECT ON "CommercialMarkupRule" FROM fbeds_api')
      try {
        await expect(strict.summary(tenantA, q)).rejects.toBeInstanceOf(CommercialControlUnavailableError)
        await expect(strict.simulate(tenantA, { ratePlanId: hotels.charlie.planId, checkIn: day(10), checkOut: day(12), adults: 2 })).rejects.toBeInstanceOf(CommercialControlUnavailableError)
      } finally {
        await provisionApiRuntimeRole(owner, { password: runtimePassword })
      }
      expect((await strict.summary(tenantA, q)).totals.plans).toBe(9)
    } finally {
      await runtime?.$disconnect(); await owner.$disconnect()
    }
  })
})
