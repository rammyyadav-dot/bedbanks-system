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
import { loadActiveMarkupRules, loadActiveMarkupRulesInTx } from '../src/supply/markup-rules.loader'

jest.setTimeout(180_000)

/**
 * NET-rate markup rules over HTTP against PostgreSQL, two tenants. The point of these tests is the price an Agent sees:
 * a NET rate is unsellable without an ACTIVE rule, sells at net plus an exact integer markup with one, and a rule only
 * becomes ACTIVE after a different person approves it. Dates are relative to today (UTC).
 */
describe('commercial markup rules (PostgreSQL, HTTP, two tenants)', () => {
  const prisma = new PrismaClient()
  const suffix = `mk-${Date.now()}-${randomBytes(3).toString('hex')}`
  const password = 'commercial-markup-password'
  const midnight = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z').getTime()
  const day = (offset: number) => new Date(midnight + offset * 86_400_000).toISOString().slice(0, 10)
  const utc = (offset: number) => new Date(midnight + offset * 86_400_000)
  const NIGHT = 10_005n // net per night, chosen so a 10% markup needs rounding
  let app: INestApplication
  let tenantA = '', tenantB = '', supplierA = '', supplierB = '', hotelA = '', hotelB = '', otherHotelA = ''
  const userIds: string[] = []; const roleIds: string[] = []
  const cookies: Record<string, string> = {}
  const ids: Record<string, string> = {}
  let seq = 0

  async function buildHotel(tenantId: string, supplierId: string, key: string, city: string) {
    const boardBasisId = (await prisma.boardBasis.upsert({ where: { tenantId_code: { tenantId, code: 'BB' } }, update: {}, create: { tenantId, code: 'BB', name: 'B&B' } })).id
    const hotel = await prisma.hotel.create({ data: { tenantId, name: `${suffix} ${key}`, externalRef: `${key}-${suffix.slice(-6)}`, propertyType: 'HOTEL', city, countryCode: 'AE', contentStatus: 'COMPLETE', starRating: 5 } })
    const room = await prisma.roomType.create({ data: { hotelId: hotel.id, name: 'Deluxe', code: `D-${key}`.slice(0, 40), maxAdults: 2, maxChildren: 0, maxOccupancy: 2 } })
    const mapping = await prisma.supplierHotelMapping.create({ data: { tenantId, supplierId, hotelId: hotel.id, supplierHotelId: `${suffix}-${key}`, status: 'MAPPED' } })
    await prisma.supplierRoomMapping.create({ data: { tenantId, supplierHotelMappingId: mapping.id, hotelId: hotel.id, supplierRoomId: `${suffix}-${key}-r`, roomTypeId: room.id, status: 'MAPPED' } })
    const contract = await prisma.contract.create({ data: { tenantId, supplierId, supplierHotelMappingId: mapping.id, code: `${suffix}-${key}`, status: 'ACTIVE', validFrom: utc(-400), validTo: utc(4000), settlementCurrency: 'AED' } as never })
    const plan = await prisma.ratePlan.create({ data: { tenantId, contractId: contract.id, roomTypeId: room.id, boardBasisId, code: `${key}-BB`.slice(0, 40), status: 'ACTIVE', occupancy: 2, currency: 'AED', minStay: 1 } })
    const range = Array.from({ length: 30 }, (_, i) => utc(i))
    await prisma.dailyRate.createMany({ data: range.map((stayDate) => ({ tenantId, ratePlanId: plan.id, stayDate, occupancy: 2, amountMinor: NIGHT, currency: 'AED', amountBasis: 'NET' as const })) })
    await prisma.dailyAvailability.createMany({ data: range.map((stayDate) => ({ tenantId, ratePlanId: plan.id, stayDate, allotment: 5, sold: 0, stopSell: false })) })
    return hotel.id
  }
  async function user(label: string, tenantId: string, keys: string[]) {
    const email = `${suffix}-${label}@example.test`
    const u = await prisma.user.create({ data: { email, passwordHash: await hashPassword(password), status: 'ACTIVE' } })
    userIds.push(u.id); ids[label] = u.id
    await prisma.membership.create({ data: { tenantId, userId: u.id, role: 'agent' } })
    if (keys.length) {
      const r = await prisma.role.create({ data: { tenantId, name: `${suffix}-${label}` } }); roleIds.push(r.id)
      for (const key of keys) {
        const p = await prisma.permission.upsert({ where: { key }, update: {}, create: { key, description: key } })
        await prisma.rolePermission.create({ data: { roleId: r.id, permissionId: p.id } })
      }
      await prisma.userRole.create({ data: { tenantId, userId: u.id, roleId: r.id } })
    }
    return email
  }
  async function login(email: string) {
    const response = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', 'http://localhost:3001').send({ email, password }).expect(200)
    return (response.headers['set-cookie'][0] as string).split(';')[0]
  }
  const base = '/api/v1/admin/commercial/markups'
  const call = (method: 'get' | 'post', path: string, who: string, body?: object) => { const r = request(app.getHttpServer())[method](`${base}${path}`); const c = who === 'anon' ? r : r.set('Cookie', cookies[who]); return body ? c.send(body) : c }
  const search = (who = 'maker') => request(app.getHttpServer()).post('/api/v1/agent/search').set('Cookie', cookies[who])
    .send({ destination: 'Dubai', checkIn: day(10), checkOut: day(12), rooms: 1, adults: 2, children: 0, childAges: [], nationality: 'IN', currency: 'AED', limit: 100 })
  const offerFor = (body: { data: { hotels: Array<{ hotelId: string; rooms: Array<{ rates: Array<Record<string, unknown>> }> }> } }, hotelId: string) => body.data.hotels.find((h) => h.hotelId === hotelId)?.rooms[0].rates[0]
  const draft = async (patch: object = {}, who = 'maker') => (await call('post', '', who, { scope: 'TENANT_DEFAULT', basisPoints: 1_000, validFrom: day(-30), reason: 'Standard margin on NET contracts', ...patch }).expect(201)).body.data
  const activate = async (rule: { id: string }, maker = 'maker', checker = 'checker') => {
    const requested = (await call('post', `/${rule.id}/request-activation`, maker, { requestId: `${suffix}-${++seq}`, reason: 'Approved commercial policy' }).expect(200)).body.data
    await call('post', `/approvals/${requested.approval.id}/approve`, checker, { reason: 'Matches the signed policy' }).expect(200)
    return (await call('post', `/approvals/${requested.approval.id}/execute`, maker).expect(200)).body.data
  }
  const clearRules = () => prisma.commercialMarkupRule.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } })

  beforeAll(async () => {
    await prisma.$connect()
    tenantA = (await prisma.tenant.create({ data: { name: `${suffix} A`, slug: `${suffix}-a` } })).id
    tenantB = (await prisma.tenant.create({ data: { name: `${suffix} B`, slug: `${suffix}-b` } })).id
    supplierA = (await prisma.supplier.create({ data: { tenantId: tenantA, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${suffix} sA`, displayName: 'Alpha', countryCode: 'AE', defaultCurrency: 'AED' } })).id
    supplierB = (await prisma.supplier.create({ data: { tenantId: tenantB, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${suffix} sB`, displayName: 'Beta', countryCode: 'AE', defaultCurrency: 'AED' } })).id
    hotelA = await buildHotel(tenantA, supplierA, 'alpha', 'Dubai')
    otherHotelA = await buildHotel(tenantA, supplierA, 'bravo', 'Dubai')
    hotelB = await buildHotel(tenantB, supplierB, 'oscar', 'Dubai')
    const manage = ['supply.rates.read', 'supply.rates.manage', 'supply.hotels.read', 'hotel.search']
    const maker = await user('maker', tenantA, manage); const checker = await user('checker', tenantA, manage)
    const viewer = await user('viewer', tenantA, ['supply.rates.read']); const none = await user('none', tenantA, [])
    const bmaker = await user('bmaker', tenantB, manage)
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = module.createNestApplication()
    app.use(cookieParser()); app.setGlobalPrefix('api/v1')
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
    app.useGlobalFilters(new HttpExceptionFilter()); app.useGlobalInterceptors(new ResponseInterceptor())
    await app.init()
    cookies.maker = await login(maker); cookies.checker = await login(checker); cookies.viewer = await login(viewer); cookies.none = await login(none); cookies.bmaker = await login(bmaker)
  })

  afterAll(async () => {
    await app?.close()
    for (const tenantId of [tenantA, tenantB].filter(Boolean)) {
      await prisma.auditEvent.deleteMany({ where: { tenantId } })
      await prisma.approvalRequest.deleteMany({ where: { tenantId } })
      await prisma.commercialMarkupRule.deleteMany({ where: { tenantId } })
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
  beforeEach(clearRules)

  it('CM-01 without an ACTIVE rule a NET rate is not sold, and the Admin inspector says exactly why', async () => {
    const found = (await search().expect(201)).body
    expect(offerFor(found, hotelA)).toBeUndefined()
    const inspect = (await request(app.getHttpServer()).get(`/api/v1/admin/operations/hotels/${hotelA}/sellability?checkIn=${day(10)}&checkOut=${day(12)}&adults=2&children=0`).set('Cookie', cookies.maker).expect(200)).body.data
    expect(inspect.sellable).toBe(false); expect(inspect.plans[0].reasons).toContain('NET_RATE_MARKUP_UNAVAILABLE')
  })

  it('CM-02 a DRAFT rule changes nothing: only an approved, activated rule affects price', async () => {
    const rule = await draft()
    expect(rule).toMatchObject({ status: 'DRAFT', basisPoints: 1_000, scope: 'TENANT_DEFAULT', canRequestActivation: true, approval: null })
    expect(offerFor((await search().expect(201)).body, hotelA)).toBeUndefined()
  })

  it('CM-03 activation needs a different person; then the Agent sees net plus an exact integer markup, rounded per night', async () => {
    const rule = await draft()
    const requested = (await call('post', `/${rule.id}/request-activation`, 'maker', { requestId: `${suffix}-${++seq}`, reason: 'Standard margin' }).expect(200)).body.data
    expect(requested.approval).toMatchObject({ status: 'PENDING', canDecide: false, canCancel: true })
    await call('post', `/approvals/${requested.approval.id}/approve`, 'maker', { reason: 'self' }).expect(403)
    await call('post', `/approvals/${requested.approval.id}/execute`, 'maker').expect(409) // not approved yet
    expect(offerFor((await search().expect(201)).body, hotelA)).toBeUndefined()
    await call('post', `/approvals/${requested.approval.id}/approve`, 'checker', { reason: 'ok' }).expect(200)
    const done = (await call('post', `/approvals/${requested.approval.id}/execute`, 'maker').expect(200)).body.data
    expect(done.rule).toMatchObject({ status: 'ACTIVE' }); expect(done.replacedRuleId).toBeNull()
    const offer = offerFor((await search().expect(201)).body, hotelA)!
    // 10005 per night, 10% = 1000.5 rounds half up to 1001 per night; two nights
    expect(offer).toMatchObject({ netAmountMinor: 20_010, markupAmountMinor: 2_002, sellAmountMinor: 22_012 })
    expect(offer.netAmountMinor as number + (offer.markupAmountMinor as number)).toBe(offer.sellAmountMinor)
    expect((offer.total as { amountMinor: number }).amountMinor).toBe(22_012)
    for (const k of ['netAmountMinor', 'markupAmountMinor', 'sellAmountMinor']) expect(Number.isInteger(offer[k])).toBe(true)
    const inspect = (await request(app.getHttpServer()).get(`/api/v1/admin/operations/hotels/${hotelA}/sellability?checkIn=${day(10)}&checkOut=${day(12)}&adults=2&children=0`).set('Cookie', cookies.maker).expect(200)).body.data
    expect(inspect.sellable).toBe(true)
  })

  it('CM-04 precedence and effective dates: hotel beats supplier beats default, and an ended hotel rule falls back', async () => {
    await activate(await draft({ basisPoints: 1_000 }))
    await activate(await draft({ scope: 'SUPPLIER', supplierId: supplierA, basisPoints: 1_500 }))
    expect((offerFor((await search().expect(201)).body, hotelA)!).markupAmountMinor).toBe(3_002) // 15%: 1501.. per night
    await activate(await draft({ scope: 'HOTEL', hotelId: hotelA, basisPoints: 2_000 }))
    const a = offerFor((await search().expect(201)).body, hotelA)!
    expect(a).toMatchObject({ markupAmountMinor: 4_002, sellAmountMinor: 24_012 }) // 20%: 2001 per night
    expect(offerFor((await search().expect(201)).body, otherHotelA)!.markupAmountMinor).toBe(3_002) // other hotel still on the supplier rule
    await clearRules()
    await activate(await draft({ basisPoints: 1_000 }))
    await activate(await draft({ scope: 'HOTEL', hotelId: hotelA, basisPoints: 2_000, validFrom: day(-30), validTo: day(-1) })) // already ended
    expect((offerFor((await search().expect(201)).body, hotelA)!).markupAmountMinor).toBe(2_002)
  })

  it('CM-05 activating a new rule for the same target retires the old one in the same step', async () => {
    const first = await activate(await draft({ basisPoints: 1_000 }))
    const second = await activate(await draft({ basisPoints: 1_200 }))
    expect(second.replacedRuleId).toBe(first.rule.id)
    const list = (await call('get', '?pageSize=50', 'maker').expect(200)).body.data.items
    expect(list.filter((r: { status: string }) => r.status === 'ACTIVE')).toHaveLength(1)
    expect(list.find((r: { id: string }) => r.id === first.rule.id).status).toBe('RETIRED')
    expect((offerFor((await search().expect(201)).body, hotelA)!).markupAmountMinor).toBe(2_402) // 12% of 10005 = 1200.6 -> 1201 per night
  })

  it('CM-06 retiring the ACTIVE rule makes NET unsellable again (fail closed), and the audit trail records each step', async () => {
    const live = await activate(await draft())
    expect(offerFor((await search().expect(201)).body, hotelA)).toBeDefined()
    expect((await call('post', `/${live.rule.id}/retire`, 'maker').expect(200)).body.data.status).toBe('RETIRED')
    expect(offerFor((await search().expect(201)).body, hotelA)).toBeUndefined()
    const actions = (await prisma.auditEvent.findMany({ where: { tenantId: tenantA, entityType: 'markup_rule', entityId: live.rule.id }, orderBy: { createdAt: 'asc' } })).map((e) => e.action)
    expect(actions).toEqual(['commercial.markup.created', 'commercial.markup.activated', 'commercial.markup.retired'])
    expect((await prisma.auditEvent.findMany({ where: { tenantId: tenantA, action: 'approval.executed' } })).length).toBeGreaterThanOrEqual(1)
  })

  it('CM-07 a rule change between search and recheck is price_changed, never a silent new price', async () => {
    await activate(await draft({ basisPoints: 1_000 }))
    const found = await search().expect(201)
    const offer = offerFor(found.body, hotelA)!
    await activate(await draft({ basisPoints: 2_000 }))
    const recheck = await request(app.getHttpServer()).post('/api/v1/agent/rates/recheck').set('Cookie', cookies.maker)
      .send({ offerId: offer.offerId, searchId: found.body.data.searchId, expectedCurrency: 'AED', expectedSellAmountMinor: offer.sellAmountMinor }).expect(409)
    expect(recheck.body.data).toMatchObject({ status: 'price_changed', currency: 'AED', sellAmountMinor: 24_012 })
  })

  it('CM-08 validation: integer basis points 0 to 10000, real dates, consistent scope and target, targets inside the tenant', async () => {
    for (const bp of [-1, 10_001, 12.5, '10']) await call('post', '', 'maker', { scope: 'TENANT_DEFAULT', basisPoints: bp, validFrom: day(0), reason: 'x' }).expect(400)
    const ok = { scope: 'TENANT_DEFAULT', basisPoints: 100, validFrom: day(0), reason: 'x' }
    await call('post', '', 'maker', { ...ok, validFrom: '2026-13-40' }).expect(400)
    await call('post', '', 'maker', { ...ok, validTo: day(-1) }).expect(400)
    await call('post', '', 'maker', { ...ok, reason: '   ' }).expect(400)
    await call('post', '', 'maker', { ...ok, scope: 'BOGUS' }).expect(400)
    await call('post', '', 'maker', { ...ok, supplierId: supplierA }).expect(400)          // default with a target
    await call('post', '', 'maker', { ...ok, scope: 'SUPPLIER' }).expect(400)               // supplier rule without a supplier
    await call('post', '', 'maker', { ...ok, scope: 'HOTEL', hotelId: hotelA, supplierId: supplierA }).expect(400)
    await call('post', '', 'maker', { ...ok, scope: 'SUPPLIER', supplierId: supplierB }).expect(404) // another tenant's supplier
    await call('post', '', 'maker', { ...ok, scope: 'HOTEL', hotelId: hotelB }).expect(404)
    expect(await prisma.commercialMarkupRule.count({ where: { tenantId: tenantA } })).toBe(0)
    expect((await call('post', '', 'maker', { ...ok, basisPoints: 0 }).expect(201)).body.data.basisPoints).toBe(0)
  })

  it('CM-09 RBAC: supply.rates.read reads, supply.rates.manage changes, nothing else does, and anonymous is refused', async () => {
    const rule = await draft()
    await call('get', '', 'viewer').expect(200)
    await call('post', '', 'viewer', { scope: 'TENANT_DEFAULT', basisPoints: 1, validFrom: day(0), reason: 'x' }).expect(403)
    await call('post', `/${rule.id}/retire`, 'viewer').expect(403)
    await call('post', `/${rule.id}/request-activation`, 'viewer', { requestId: 'x', reason: 'x' }).expect(403)
    await call('get', '', 'none').expect(403)
    await call('get', '', 'anon').expect(401)
    await call('post', '', 'anon', {}).expect(401)
  })

  it('CM-10 tenant isolation: tenant B cannot see, request, approve or execute against tenant A rules', async () => {
    const rule = await draft()
    const requested = (await call('post', `/${rule.id}/request-activation`, 'maker', { requestId: `${suffix}-${++seq}`, reason: 'ok' }).expect(200)).body.data
    expect((await call('get', '', 'bmaker').expect(200)).body.data.total).toBe(0)
    await call('post', `/${rule.id}/retire`, 'bmaker').expect(404)
    await call('post', `/${rule.id}/request-activation`, 'bmaker', { requestId: 'x', reason: 'x' }).expect(404)
    await call('post', `/approvals/${requested.approval.id}/approve`, 'bmaker', { reason: 'x' }).expect(404)
    await call('post', `/approvals/${requested.approval.id}/execute`, 'bmaker').expect(404)
    const bRule = (await call('post', '', 'bmaker', { scope: 'TENANT_DEFAULT', basisPoints: 5_000, validFrom: day(-1), reason: 'tenant B only' }).expect(201)).body.data
    expect(bRule.status).toBe('DRAFT')
    expect(offerFor((await search().expect(201)).body, hotelA)).toBeUndefined() // tenant B's rule never prices tenant A
  })

  it('CM-11 an approval cannot be reused or redirected: single use, one open request per rule, and the rule must be unchanged', async () => {
    const rule = await draft()
    const first = (await call('post', `/${rule.id}/request-activation`, 'maker', { requestId: `${suffix}-${++seq}`, reason: 'ok' }).expect(200)).body.data
    await call('post', `/${rule.id}/request-activation`, 'maker', { requestId: `${suffix}-${++seq}`, reason: 'second' }).expect(409)
    await call('post', `/approvals/${first.approval.id}/reject`, 'checker', { reason: 'not yet' }).expect(200)
    await call('post', `/approvals/${first.approval.id}/execute`, 'maker').expect(409)
    const again = (await call('post', `/${rule.id}/request-activation`, 'maker', { requestId: `${suffix}-${++seq}`, reason: 'again' }).expect(200)).body.data
    await call('post', `/approvals/${again.approval.id}/approve`, 'checker', { reason: 'ok' }).expect(200)
    await call('post', `/approvals/${again.approval.id}/execute`, 'maker').expect(200)
    await call('post', `/approvals/${again.approval.id}/execute`, 'checker').expect(409) // single use
    // a retired rule cannot be activated by an approval that was granted earlier
    const second = await draft({ basisPoints: 700 })
    const req = (await call('post', `/${second.id}/request-activation`, 'maker', { requestId: `${suffix}-${++seq}`, reason: 'ok' }).expect(200)).body.data
    await call('post', `/approvals/${req.approval.id}/approve`, 'checker', { reason: 'ok' }).expect(200)
    await call('post', `/${second.id}/retire`, 'maker').expect(200)
    await call('post', `/approvals/${req.approval.id}/execute`, 'maker').expect(409)
    expect((await prisma.approvalRequest.findUniqueOrThrow({ where: { id: req.approval.id } })).status).toBe('APPROVED') // released for the owner to deal with
  })

  it('CM-12 the database itself keeps one ACTIVE rule per target and rejects bad values', async () => {
    const insert = (patch: Record<string, unknown>) => prisma.commercialMarkupRule.create({ data: { tenantId: tenantA, scope: 'TENANT_DEFAULT', basisPoints: 500, validFrom: utc(0), status: 'ACTIVE', activatedAt: new Date(), reason: 'direct', createdById: ids.maker, ...patch } as never })
    await insert({})
    await expect(insert({})).rejects.toThrow(/one_active_per_target|Unique constraint/)
    await expect(insert({ scope: 'SUPPLIER', supplierId: supplierA })).resolves.toBeDefined()
    await expect(insert({ scope: 'SUPPLIER', supplierId: supplierA })).rejects.toThrow()
    await expect(insert({ basisPoints: 20_000, status: 'DRAFT', activatedAt: null })).rejects.toThrow(/basis_points_range/)
    await expect(insert({ scope: 'HOTEL', status: 'DRAFT', activatedAt: null })).rejects.toThrow(/scope_target/)
    await expect(insert({ status: 'DRAFT', activatedAt: null, validTo: utc(-5) })).rejects.toThrow(/validity_order/)
    await expect(insert({ status: 'ACTIVE', activatedAt: null, scope: 'SUPPLIER', supplierId: supplierA, basisPoints: 1 })).rejects.toThrow(/status_timestamps/)
  })

  it('CM-13 under the non-bypass API runtime role the provisioned read grant returns the tenant\'s own rules, and a denied read throws instead of meaning no markup', async () => {
    await activate(await draft())
    const owner = new PrismaClient()
    const runtimePassword = randomBytes(24).toString('hex')
    const previous = process.env.DATABASE_URL
    let runtime: PrismaService | undefined
    try {
      await provisionApiRuntimeRole(owner, { password: runtimePassword })
      const url = new URL(previous as string); url.username = API_RUNTIME_LOGIN_ROLE; url.password = runtimePassword
      runtime = new PrismaService({ datasourceUrl: url.toString() } as never)
      await runtime.$connect()
      const rules = await loadActiveMarkupRules(runtime, tenantA)
      expect(rules).toEqual([expect.objectContaining({ scope: 'TENANT_DEFAULT', basisPoints: 1_000 })])
      expect(await loadActiveMarkupRules(runtime, tenantB)).toEqual([])
      const inTx = await runtime.withTenant(tenantA, async (tx) => {
        const r = await loadActiveMarkupRulesInTx(tx, tenantA)
        const hotels = await tx.hotel.count({ where: { tenantId: tenantA } }) // the transaction is still usable
        return { r, hotels }
      })
      expect(inTx.hotels).toBe(2)
      expect(inTx.r.length).toBe(rules.length)
      // Failure injection: the owner revokes the read; the loader must refuse rather than return an empty list.
      await owner.$executeRawUnsafe('REVOKE SELECT ON "CommercialMarkupRule" FROM fbeds_api')
      await expect(loadActiveMarkupRules(runtime, tenantA)).rejects.toMatchObject({ name: 'CommercialControlUnavailableError', control: 'markup_rules', reason: 'denied' })
    } finally { await owner.$executeRawUnsafe('GRANT SELECT ON "CommercialMarkupRule" TO fbeds_api').catch(() => undefined); await runtime?.$disconnect(); await owner.$disconnect() }
  })

  it('CM-14 impact: counts priced, unpriced and stored-sell plan-nights exactly, per currency, scoped to the tenant', async () => {
    const impact = async (who = 'maker', qs = '') => (await request(app.getHttpServer()).get(`/api/v1/admin/operations/commercial/impact${qs}`).set('Cookie', cookies[who]).expect(200)).body.data
    // two hotels x 30 nights of NET rates, no rule yet
    let i = await impact()
    expect(i.planNights).toEqual({ sell: 0, netPriced: 0, netUnpriced: 60, basisUnverified: 0 })
    expect(i.affectedHotelCount).toBe(2); expect(i.affectedHotels).toHaveLength(2); expect(i.affectedHotels[0].unpricedNights).toBe(30); expect(i.currencies).toEqual([])
    // a default rule prices everything: 60 nights x net 10005, markup 1001 per night (ten percent, half up)
    await activate(await draft({ basisPoints: 1_000 }))
    i = await impact()
    expect(i.planNights).toEqual({ sell: 0, netPriced: 60, netUnpriced: 0, basisUnverified: 0 })
    expect(i.currencies).toEqual([{ currency: 'AED', netMinor: '600300', markupMinor: '60060' }])
    expect(i.affectedHotelCount).toBe(0)
    // a hotel rule overrides the default for that hotel only (twenty percent is 2001 per night)
    await activate(await draft({ scope: 'HOTEL', hotelId: hotelA, basisPoints: 2_000 }))
    expect((await impact()).currencies).toEqual([{ currency: 'AED', netMinor: '600300', markupMinor: '90060' }])
    // one stored SELL night is neither priced nor unpriced, and a rate with no basis is reported separately
    const plan = await prisma.ratePlan.findFirstOrThrow({ where: { tenantId: tenantA, roomType: { hotelId: otherHotelA } } })
    await prisma.dailyRate.updateMany({ where: { ratePlanId: plan.id, stayDate: utc(3) }, data: { amountBasis: 'SELL' } })
    await prisma.dailyRate.updateMany({ where: { ratePlanId: plan.id, stayDate: utc(4) }, data: { amountBasis: null } })
    i = await impact()
    expect(i.planNights).toEqual({ sell: 1, netPriced: 58, netUnpriced: 0, basisUnverified: 1 })
    // the same figure as the Admin hotel assessment: the unverified-basis hotel is blocked on that night
    expect(i.window.days).toBe(30)
    // tenant isolation: tenant B sees only its own hotel, and none of tenant A's rules
    const b = await impact('bmaker')
    expect(b.totalHotels).toBe(1); expect(b.planNights).toEqual({ sell: 0, netPriced: 0, netUnpriced: 30, basisUnverified: 0 }); expect(b.affectedHotels[0].hotelId).toBe(hotelB)
    // RBAC and validation
    await request(app.getHttpServer()).get('/api/v1/admin/operations/commercial/impact').set('Cookie', cookies.viewer).expect(200)
    await request(app.getHttpServer()).get('/api/v1/admin/operations/commercial/impact').set('Cookie', cookies.none).expect(403)
    await request(app.getHttpServer()).get('/api/v1/admin/operations/commercial/impact').expect(401)
    await request(app.getHttpServer()).get('/api/v1/admin/operations/commercial/impact?days=0').set('Cookie', cookies.maker).expect(400)
    await prisma.dailyRate.updateMany({ where: { ratePlanId: plan.id }, data: { amountBasis: 'NET' } })
  })
})
