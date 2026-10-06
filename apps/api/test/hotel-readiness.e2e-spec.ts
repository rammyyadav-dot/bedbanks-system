import { randomBytes } from 'crypto'
import { INestApplication, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { PrismaClient } from '@prisma/client'
import * as cookieParser from 'cookie-parser'
import * as request from 'supertest'
import type { SearchCriteria } from '@bedbanks/domain'
import type { HotelReadinessAssessment } from '@bedbanks/contracts'
import { AppModule } from '../src/app.module'
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter'
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor'
import { hashPassword } from '../src/auth/utils/password'
import { PrismaService } from '../src/database/prisma.service'
import { ContractedInventoryAdapter } from '../src/agent/contracted-inventory.adapter'
import { provisionApiRuntimeRole, API_RUNTIME_LOGIN_ROLE } from '../src/database/api-runtime-role'

jest.setTimeout(180_000)

/**
 * Unified hotel readiness over HTTP, against the real AppModule and PostgreSQL, running as the NON-owner, NON-BYPASSRLS API runtime role.
 * Data is created through the owner connection; every request under test goes through the application. Dates are relative to today (UTC).
 */
describe('hotel readiness (PostgreSQL, HTTP, runtime role, two tenants)', () => {
  const owner = new PrismaClient()
  const suffix = `hr-${Date.now()}-${randomBytes(3).toString('hex')}`
  const password = 'hotel-readiness-certification-password'
  const runtimePassword = `rt-${randomBytes(20).toString('hex')}`
  const origin = 'http://localhost:3001'
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
  const CHECK_IN = day(20); const CHECK_OUT = day(22)
  let app: INestApplication; let previousUrl: string | undefined; let probe: PrismaClient
  let tenantA = '', tenantB = '', supplierA = '', supplierB = '', boardA = '', boardB = ''
  const userIds: string[] = []; const cookies: Record<string, string> = {}
  const hotels: Record<string, string> = {}; const agencies: Record<string, string> = {}

  async function makeHotel(key: string, o: { content?: string; profile?: boolean; mapping?: string; rates?: boolean; availability?: boolean; salesMarkets?: string[]; nationalities?: string[]; tenant?: 'A' | 'B' } = {}) {
    const tenantId = o.tenant === 'B' ? tenantB : tenantA; const supplierId = o.tenant === 'B' ? supplierB : supplierA
    const h = await owner.hotel.create({ data: { tenantId, name: `${suffix} ${key}`, externalRef: `${key}-${suffix.slice(-6)}`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', address: '1 Sheikh Zayed Rd', latitude: '25.2', longitude: '55.27', timeZone: 'Asia/Dubai', contentStatus: (o.content ?? 'COMPLETE') as never, starRating: 5 } })
    const room = await owner.roomType.create({ data: { hotelId: h.id, name: 'Deluxe', code: `D-${key}`.slice(0, 40), maxAdults: 2, maxChildren: 0, maxOccupancy: 2 } })
    if (o.profile !== false) {
      const admin = userIds[0]
      await owner.hotelProfile.create({ data: { tenantId, hotelId: h.id, shortDescription: 'A hotel', checkInTime: '14:00', checkOutTime: '12:00', contacts: { reservations: { name: 'Front desk', email: 'res@example.test' } }, starVerifiedAt: new Date(), starVerifiedById: admin, updatedById: admin } as never })
    }
    const m = await owner.supplierHotelMapping.create({ data: { tenantId, supplierId, hotelId: h.id, supplierHotelId: `${suffix}-${key}`, status: (o.mapping ?? 'MAPPED') as never } })
    await owner.supplierRoomMapping.create({ data: { tenantId, supplierHotelMappingId: m.id, hotelId: h.id, supplierRoomId: `${suffix}-${key}-r`, roomTypeId: room.id, status: 'MAPPED' } })
    const c = await owner.contract.create({ data: { tenantId, supplierId, supplierHotelMappingId: m.id, code: `${suffix}-${key}`, status: 'ACTIVE', validFrom: new Date(Date.now() - 400 * 86_400_000), validTo: new Date(Date.now() + 4000 * 86_400_000), settlementCurrency: 'AED', ...(o.salesMarkets ? { salesMarkets: o.salesMarkets as never } : {}), ...(o.nationalities ? { nationalities: o.nationalities as never } : {}) } })
    const plan = await owner.ratePlan.create({ data: { tenantId, contractId: c.id, roomTypeId: room.id, boardBasisId: o.tenant === 'B' ? boardB : boardA, code: `${key}-BB`.slice(0, 40), status: 'ACTIVE', occupancy: 2, currency: 'AED', minStay: 1 } })
    const nights = [CHECK_IN, day(21)]
    if (o.rates !== false) await owner.dailyRate.createMany({ data: nights.map((d) => ({ tenantId, ratePlanId: plan.id, stayDate: new Date(d), occupancy: 2, amountMinor: 50_000n, amountBasis: 'SELL' as const, currency: 'AED' })) })
    if (o.availability !== false) await owner.dailyAvailability.createMany({ data: [...nights, CHECK_OUT].map((d) => ({ tenantId, ratePlanId: plan.id, stayDate: new Date(d), allotment: 5 })) })
    hotels[key] = h.id
  }
  async function user(label: string, tenantId: string, keys: string[]) {
    const email = `${suffix}-${label}@example.test`
    const u = await owner.user.create({ data: { email, passwordHash: await hashPassword(password), status: 'ACTIVE' } }); userIds.push(u.id)
    await owner.membership.create({ data: { tenantId, userId: u.id, role: 'agent' } })
    if (keys.length) {
      const r = await owner.role.create({ data: { tenantId, name: `${suffix}-${label}` } })
      for (const key of keys) { const p = await owner.permission.upsert({ where: { key }, update: {}, create: { key, description: key } }); await owner.rolePermission.create({ data: { roleId: r.id, permissionId: p.id } }) }
      await owner.userRole.create({ data: { tenantId, userId: u.id, roleId: r.id } })
    }
    return u.id
  }
  async function agency(label: string, country: string | null, status: 'ACTIVE' | 'SUSPENDED' = 'ACTIVE', tenantId = tenantA) {
    const u = await owner.user.create({ data: { email: `${suffix}-ag-${label}@example.test` } }); userIds.push(u.id)
    const a = await owner.agency.create({ data: { tenantId, code: `${label}-${suffix.slice(-6)}`.toUpperCase(), name: label, countryCode: country, status, createdById: u.id } })
    await owner.agencyMember.create({ data: { tenantId, agencyId: a.id, userId: u.id } })
    agencies[label] = a.id
    return { agencyId: a.id, userId: u.id }
  }
  const agents: Record<string, string> = {}
  const get = (hotel: string, qs: string, who = 'owner') => { const r = request(app.getHttpServer()).get(`/api/v1/admin/operations/hotels/${hotels[hotel] ?? hotel}/readiness?${qs}`); return who === 'anon' ? r : r.set('Cookie', cookies[who]) }
  const base = `checkIn=${CHECK_IN}&checkOut=${CHECK_OUT}&adults=2&nationality=IN`
  const gateOf = (a: HotelReadinessAssessment, id: string) => a.gates.find((g) => g.gate === id)!
  const ok = async (hotel: string, qs = base, who = 'owner') => (await get(hotel, qs, who).expect(200)).body.data as HotelReadinessAssessment

  beforeAll(async () => {
    await owner.$connect()
    tenantA = (await owner.tenant.create({ data: { name: suffix, slug: suffix } })).id
    tenantB = (await owner.tenant.create({ data: { name: `${suffix}-b`, slug: `${suffix}-b` } })).id
    supplierA = (await owner.supplier.create({ data: { tenantId: tenantA, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${suffix} a`, displayName: 'Alpha', countryCode: 'AE', defaultCurrency: 'AED' } })).id
    supplierB = (await owner.supplier.create({ data: { tenantId: tenantB, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${suffix} b`, displayName: 'Beta', countryCode: 'AE', defaultCurrency: 'AED' } })).id
    boardA = (await owner.boardBasis.create({ data: { tenantId: tenantA, code: 'BB', name: 'B&B' } })).id
    boardB = (await owner.boardBasis.create({ data: { tenantId: tenantB, code: 'BB', name: 'B&B' } })).id
    const keys = ['supply.hotels.read', 'supply.rates.read', 'supply.contracts.read', 'supply.mappings.read']
    await user('owner', tenantA, keys); await user('viewer', tenantA, ['supply.hotels.read']); await user('none', tenantA, []); await user('bowner', tenantB, keys)
    await makeHotel('ready'); await makeHotel('draft', { content: 'DRAFT', profile: false }); await makeHotel('pending', { mapping: 'PENDING' })
    await makeHotel('norate', { rates: false }); await makeHotel('nostock', { availability: false })
    await makeHotel('indian', { nationalities: ['IN'] }); await makeHotel('gbmarket', { salesMarkets: ['GB'] }); await makeHotel('beta', { tenant: 'B' })
    const gb = await agency('gb', 'GB'); const ae = await agency('ae', 'AE'); const susp = await agency('susp', 'AE', 'SUSPENDED'); const bAgency = await agency('bag', 'AE', 'ACTIVE', tenantB)
    agents.gb = gb.userId; agents.ae = ae.userId; agents.susp = susp.userId; agents.bag = bAgency.userId
    await owner.distributionRestriction.create({ data: { tenantId: tenantA, agencyId: ae.agencyId, scope: 'HOTEL', hotelId: hotels.indian, status: 'ACTIVE', reason: 'readiness certification', createdById: userIds[0] } as never })

    await provisionApiRuntimeRole(owner, { password: runtimePassword })
    previousUrl = process.env.DATABASE_URL
    const u = new URL(previousUrl as string); u.username = API_RUNTIME_LOGIN_ROLE; u.password = runtimePassword
    process.env.DATABASE_URL = u.toString(); process.env.ADMIN_ORIGIN = origin
    probe = new PrismaClient({ datasourceUrl: `${u.toString()}${u.search ? '&' : '?'}connection_limit=1` })
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication(); app.use(cookieParser()); app.setGlobalPrefix('api/v1')
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
    app.useGlobalFilters(new HttpExceptionFilter()); app.useGlobalInterceptors(new ResponseInterceptor())
    await app.init()
    for (const label of ['owner', 'viewer', 'none', 'bowner']) {
      const r = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', origin).send({ email: `${suffix}-${label}@example.test`, password }).expect(200)
      cookies[label] = (r.headers['set-cookie'][0] as string).split(';')[0]
    }
  })

  afterAll(async () => {
    await probe?.$disconnect(); await app?.close()
    if (previousUrl) process.env.DATABASE_URL = previousUrl
    for (const t of [tenantA, tenantB].filter(Boolean)) {
      for (const q of [`DELETE FROM "AuditEvent" WHERE tenant_id = '${t}'`, `DELETE FROM "DistributionRestriction" WHERE tenant_id = '${t}'`, `DELETE FROM "AgencyMember" WHERE tenant_id = '${t}'`, `DELETE FROM "Agency" WHERE tenant_id = '${t}'`,
        `DELETE FROM "DailyRate" WHERE tenant_id = '${t}'`, `DELETE FROM "DailyAvailability" WHERE tenant_id = '${t}'`, `DELETE FROM "RatePlan" WHERE tenant_id = '${t}'`, `DELETE FROM "Contract" WHERE tenant_id = '${t}'`,
        `DELETE FROM "SupplierRoomMapping" WHERE tenant_id = '${t}'`, `DELETE FROM "SupplierHotelMapping" WHERE tenant_id = '${t}'`, `DELETE FROM "BoardBasis" WHERE tenant_id = '${t}'`,
        `DELETE FROM "HotelProfile" WHERE tenant_id = '${t}'`, `DELETE FROM "RoomType" WHERE hotel_id IN (SELECT id FROM "Hotel" WHERE tenant_id = '${t}')`, `DELETE FROM "Hotel" WHERE tenant_id = '${t}'`, `DELETE FROM "Supplier" WHERE tenant_id = '${t}'`,
        `DELETE FROM "UserRole" WHERE tenant_id = '${t}'`, `DELETE FROM "RolePermission" WHERE role_id IN (SELECT id FROM "Role" WHERE tenant_id = '${t}')`, `DELETE FROM "Role" WHERE tenant_id = '${t}'`, `DELETE FROM memberships WHERE tenant_id = '${t}'`]) await owner.$executeRawUnsafe(q).catch(() => undefined)
    }
    await owner.session.deleteMany({ where: { userId: { in: userIds } } }); await owner.user.deleteMany({ where: { id: { in: userIds } } }); await owner.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB].filter(Boolean) } } })
    await owner.$disconnect()
  })

  it('HR-E01: the application under test is the non-owner, non-superuser, non-BYPASSRLS runtime role', async () => {
    const who = await probe.$queryRawUnsafe<Array<{ current_user: string; rolbypassrls: boolean; rolsuper: boolean }>>('SELECT current_user, r.rolbypassrls, r.rolsuper FROM pg_roles r WHERE r.rolname = current_user')
    expect(who).toEqual([{ current_user: API_RUNTIME_LOGIN_ROLE, rolbypassrls: false, rolsuper: false }])
  })

  it('HR-E02: authentication, authorization and tenant isolation', async () => {
    await get('ready', base, 'anon').expect(401)
    await get('ready', base, 'none').expect(403)
    await get('ready', base, 'viewer').expect(403) // supply.hotels.read alone does not grant rate-level evaluation
    await get('beta', base, 'owner').expect(404)    // tenant B's hotel through tenant A
    await get('ready', base, 'bowner').expect(404)  // tenant A's hotel through tenant B
    await get('ready', `${base}&agencyId=${agencies.bag}`).expect(404) // tenant B's agency through tenant A
    expect((await ok('beta', base, 'bowner')).hotelName).toContain('beta')
  })

  it('HR-E03: criteria are validated and unsupported criteria are rejected, not guessed', async () => {
    await get('ready', `checkOut=${CHECK_OUT}&adults=2`).expect(400)
    await get('ready', `checkIn=${day(-3)}&checkOut=${day(-1)}&adults=2`).expect(400)
    await get('ready', `checkIn=${CHECK_OUT}&checkOut=${CHECK_IN}&adults=2`).expect(400)
    await get('ready', `${base}&children=1`).expect(400)                  // a child needs an age
    await get('ready', `${base}&children=1&childAges=18`).expect(400)
    await get('ready', `${base}&children=1&childAges=5,6`).expect(400)
    await get('ready', `checkIn=${CHECK_IN}&checkOut=${CHECK_OUT}&adults=2&nationality=INDIA`).expect(400)
    await get('ready', `${base}&currency=XXX`).expect(400)                // not a supported settlement currency
    await get('ready', `${base}&agencyId=not-an-id!`).expect(400)
  })

  it('HR-E04: a fully configured hotel passes every commercial gate; evidence stays UNKNOWN; the verdict is scoped', async () => {
    const a = await ok('ready')
    expect(a.gates.map((g) => g.gate)).toEqual(['CONTENT', 'MAPPING', 'CONTRACT', 'RATE', 'INVENTORY', 'DISTRIBUTION', 'SEARCH_RECHECK_EVIDENCE'])
    expect(a.gates.filter((g) => g.gate !== 'SEARCH_RECHECK_EVIDENCE').map((g) => g.outcome)).toEqual(Array(6).fill('PASS'))
    expect(gateOf(a, 'SEARCH_RECHECK_EVIDENCE').outcome).toBe('UNKNOWN')
    expect(a.commercialVerdict).toBe('PASS'); expect(a.predictedOffers).toBe(1)
    expect(a.criteria).toMatchObject({ checkIn: CHECK_IN, checkOut: CHECK_OUT, nights: 2, adults: 2, nationality: 'IN', currency: 'AED', agencyId: null, market: null })
    expect(a.scope).toMatch(/at the evaluation time only/)
    expect(JSON.stringify(a)).not.toMatch(/res@example\.test|Front desk/) // private contacts never leave the API
  })

  it('HR-E05: content readiness is separate from sellability and publication', async () => {
    const a = await ok('draft')
    expect(gateOf(a, 'CONTENT').outcome).toBe('FAIL')
    expect(gateOf(a, 'CONTENT').blockers.map((b) => b.code)).toEqual(expect.arrayContaining(['SHORT_DESCRIPTION', 'CHECK_IN_OUT', 'RESERVATIONS_CONTACT', 'STAR_CATEGORY']))
    expect(gateOf(a, 'CONTENT').action).toMatchObject({ tab: 'setup' })
    expect(gateOf(a, 'DISTRIBUTION').blockers.map((b) => b.code)).toEqual(['HOTEL_INACTIVE'])
    expect(a.predictedOffers).toBe(0); expect(a.commercialVerdict).toBe('FAIL')
  })

  it('HR-E06: mapping, rate and inventory gaps are named by their own gate; a missing rate or stock is never zero', async () => {
    const pending = await ok('pending'); expect(gateOf(pending, 'MAPPING')).toMatchObject({ outcome: 'FAIL', action: { tab: 'mappings' } })
    const norate = await ok('norate'); expect(gateOf(norate, 'RATE').blockers.map((b) => b.code)).toEqual(['DAILY_RATE_MISSING_OR_INVALID']); expect(gateOf(norate, 'INVENTORY').outcome).toBe('PASS')
    const nostock = await ok('nostock'); expect(gateOf(nostock, 'INVENTORY').blockers.map((b) => b.code)).toEqual(['AVAILABILITY_MISSING']); expect(gateOf(nostock, 'RATE').outcome).toBe('PASS')
  })

  it('HR-E07: nationality, market, agency suspension and restriction are evaluated for the stated buyer, and agree with Agent search', async () => {
    const adapter = new ContractedInventoryAdapter(new PrismaService())
    const offers = async (userId: string, nationality: string) => {
      const c: SearchCriteria = { destination: 'Dubai', checkIn: CHECK_IN, checkOut: CHECK_OUT, rooms: 1, adults: 2, children: 0, childAges: [], nationality, currency: 'AED' }
      const r = await adapter.search(c, { tenantId: tenantA, requestId: 'r', userId })
      return new Set(r.offers.filter((h) => h.hotelId).map((h) => h.hotelId))
    }
    const cases: Array<{ hotel: string; qs: string; agent: string; nationality: string }> = [
      { hotel: 'indian', qs: `${base}&agencyId=${agencies.gb}`, agent: 'gb', nationality: 'IN' },
      { hotel: 'indian', qs: `checkIn=${CHECK_IN}&checkOut=${CHECK_OUT}&adults=2&nationality=GB&agencyId=${agencies.gb}`, agent: 'gb', nationality: 'GB' },
      { hotel: 'gbmarket', qs: `${base}&agencyId=${agencies.gb}`, agent: 'gb', nationality: 'IN' },
      { hotel: 'gbmarket', qs: `${base}&agencyId=${agencies.ae}`, agent: 'ae', nationality: 'IN' },
      { hotel: 'indian', qs: `${base}&agencyId=${agencies.ae}`, agent: 'ae', nationality: 'IN' }, // agency restricted from this hotel
    ]
    for (const c of cases) {
      const a = await ok(c.hotel, c.qs)
      const listed = (await offers(agents[c.agent], c.nationality)).has(hotels[c.hotel])
      expect({ case: c, predicted: a.predictedOffers > 0 }).toEqual({ case: c, predicted: listed })
    }
    const gbMarket = await ok('gbmarket', `${base}&agencyId=${agencies.ae}`)
    expect(gateOf(gbMarket, 'CONTRACT').blockers.map((b) => b.code)).toEqual(['SOURCE_MARKET_NOT_ALLOWED']); expect(gbMarket.criteria.market).toBe('AE')
    const restricted = await ok('indian', `${base}&agencyId=${agencies.ae}`)
    expect(gateOf(restricted, 'DISTRIBUTION').blockers.map((b) => b.code)).toEqual(['DISTRIBUTION_RESTRICTED_HOTEL'])
    expect(gateOf(restricted, 'DISTRIBUTION').blockers[0].refs.map((r) => r.type)).toEqual(['AGENCY', 'HOTEL'])
    const nonMatching = await ok('indian', `checkIn=${CHECK_IN}&checkOut=${CHECK_OUT}&adults=2&nationality=GB`)
    expect(gateOf(nonMatching, 'CONTRACT').blockers.map((b) => b.code)).toEqual(['NATIONALITY_NOT_ALLOWED'])
    const noNationality = await ok('indian', `checkIn=${CHECK_IN}&checkOut=${CHECK_OUT}&adults=2`)
    expect(gateOf(noNationality, 'CONTRACT').blockers.map((b) => b.code)).toEqual(['NATIONALITY_NOT_ALLOWED']) // unknown nationality fails closed
    const suspended = await ok('ready', `${base}&agencyId=${agencies.susp}`)
    expect(gateOf(suspended, 'DISTRIBUTION').blockers.map((b) => b.code)).toEqual(['AGENCY_SUSPENDED']); expect(suspended.predictedOffers).toBe(0)
  })

  it('HR-E08: assessment is read-only and tenant-safe across reused connections (no audit, no allocation, no leakage)', async () => {
    const before = await owner.dailyAvailability.aggregate({ _sum: { sold: true, held: true } })
    // The platform audits tenant context selection on every authenticated request (pre-existing); the assessment itself must add nothing else.
    const business = () => owner.auditEvent.count({ where: { tenantId: tenantA, action: { not: 'tenant.context.selected' } } })
    const auditBefore = await business()
    for (let i = 0; i < 4; i++) { await ok('ready'); await get('beta', base, 'owner').expect(404); expect((await ok('beta', base, 'bowner')).hotelName).toContain('beta') }
    expect(await owner.dailyAvailability.aggregate({ _sum: { sold: true, held: true } })).toEqual(before)
    expect(await business()).toBe(auditBefore)
  })
  it('HR-E09: an unreadable profile or agency restriction table is UNKNOWN, never FAIL, zero or "unrestricted"; the rest of the assessment still answers', async () => {
    try {
      await owner.$executeRawUnsafe('REVOKE SELECT ON "HotelProfile", "DistributionRestriction" FROM fbeds_api')
      const a = await ok('ready', `${base}&agencyId=${agencies.ae}`)
      expect(gateOf(a, 'CONTENT')).toMatchObject({ outcome: 'UNKNOWN', blockers: [] }); expect(gateOf(a, 'CONTENT').reason).toMatch(/cannot read the hotel profile/)
      expect(gateOf(a, 'DISTRIBUTION')).toMatchObject({ outcome: 'UNKNOWN', blockers: [] })
      expect(a.predictedOffers).toBe(0)                 // unreadable agency controls never mean "show everything"
      expect(a.commercialVerdict).toBe('UNKNOWN')
      expect(['MAPPING', 'CONTRACT', 'RATE', 'INVENTORY'].map((g) => gateOf(a, g).outcome)).toEqual(Array(4).fill('PASS'))
    } finally {
      await provisionApiRuntimeRole(owner, { password: runtimePassword })
    }
    expect(gateOf(await ok('ready', `${base}&agencyId=${agencies.ae}`), 'CONTENT').outcome).toBe('PASS')
  })
})
