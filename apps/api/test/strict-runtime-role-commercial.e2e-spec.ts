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
import { API_RUNTIME_GROUP_ROLE, API_RUNTIME_LOGIN_ROLE, provisionApiRuntimeRole, verifyApiRuntimeRole } from '../src/database/api-runtime-role'

const ownerUrl = process.env.DATABASE_URL
if (!ownerUrl) throw new Error('DATABASE_URL (the disposable owner connection) is required')

/**
 * ADR 0031. The whole HTTP application runs on the provisioned, non-superuser, non-BYPASSRLS API runtime role.
 *  - Mandatory commercial controls (agency suspension, distribution restrictions, markup rules): a legitimately empty configuration follows
 *    the documented default; a control whose read grant is removed makes search, recheck and the guard refuse, with no side effects;
 *    restoring the grant restores the valid flow.
 *  - Admin mutations: 401 unauthenticated, 403 without permission, 404 for another tenant's resource, and a sanitized 503 DATABASE_ROLE_NOT_PERMITTED
 *    for an authorized caller whose runtime role has no write grant. In every case nothing is written and no audit event is created.
 */
describe('strict runtime role: commercial read safety and Admin authorization (PostgreSQL)', () => {
  const owner = new PrismaClient({ datasourceUrl: ownerUrl })
  const suffix = `sc-${Date.now()}-${randomBytes(3).toString('hex')}`
  const password = 'strict-role-password'
  const runtimePassword = randomBytes(24).toString('hex')
  const origin = 'http://localhost:3001'
  const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)
  let app: INestApplication; let previousUrl: string | undefined
  let tenantA = '', tenantB = '', supplierId = '', sellHotelId = '', netHotelId = '', agencyId = '', otherAgencyId = '', sellPlanId = ''
  const userIds: string[] = []; const cookies: Record<string, string> = {}; const hotelIds: string[] = []

  const ADMIN_KEYS = ['supply.hotels.read', 'supply.hotels.manage', 'supply.rates.read', 'supply.rates.manage', 'supply.availability.read', 'supply.availability.manage', 'supply.suppliers.manage',
    'agency.read', 'agency.manage', 'distribution.read', 'distribution.manage', 'case.read', 'case.manage']
  const READ_KEYS = ['supply.hotels.read', 'supply.rates.read', 'supply.availability.read', 'agency.read', 'distribution.read', 'case.read']

  async function user(label: string, tenantId: string, keys: string[]) {
    const email = `${suffix}-${label}@example.test`
    const u = await owner.user.create({ data: { email, name: label, passwordHash: await hashPassword(password), status: 'ACTIVE' } }); userIds.push(u.id)
    await owner.membership.create({ data: { tenantId, userId: u.id, role: 'agent' } })
    const r = await owner.role.create({ data: { tenantId, name: `${suffix}-${label}` } })
    for (const key of keys) { const p = await owner.permission.upsert({ where: { key }, update: {}, create: { key, description: key } }); await owner.rolePermission.create({ data: { roleId: r.id, permissionId: p.id } }) }
    await owner.userRole.create({ data: { tenantId, userId: u.id, roleId: r.id } })
    return { id: u.id, email }
  }
  const call = (method: 'get' | 'post' | 'patch' | 'put', path: string, who: string, body?: object) => {
    const r = request(app.getHttpServer())[method](`/api/v1${path}`).set('Origin', origin)
    const c = who === 'anon' ? r : r.set('Cookie', cookies[who]); return body ? c.send(body) : c
  }
  const searchBody = (destination: string) => ({ destination, checkIn: day(20), checkOut: day(22), rooms: 1, adults: 2, children: 0, childAges: [], nationality: 'IN', currency: 'AED', limit: 100 })
  type Rate = { ratePlanId: string; offerId: string; availability: string; available: boolean; sellAmountMinor: number }
  const ratesOf = (body: { data: { hotels: Array<{ rooms: Array<{ rates: Rate[] }> }> } }): Rate[] => body.data.hotels.flatMap((h) => h.rooms.flatMap((r) => r.rates))
  const search = (who: string, destination: string) => call('post', '/agent/search', who, searchBody(destination))
  const grant = (table: string) => owner.$executeRawUnsafe(`GRANT SELECT ON "${table}" TO ${API_RUNTIME_GROUP_ROLE}`)
  const revoke = (table: string) => owner.$executeRawUnsafe(`REVOKE SELECT ON "${table}" FROM ${API_RUNTIME_GROUP_ROLE}`)
  async function sideEffects() {
    return {
      holds: await owner.inventoryHold.count({ where: { tenantId: tenantA } }), bookings: await owner.booking.count({ where: { tenantId: tenantA } }),
      supplierMutations: await owner.supplierMutation.count({ where: { tenantId: tenantA } }),
      stock: await owner.dailyAvailability.findMany({ where: { tenantId: tenantA }, select: { ratePlanId: true, stayDate: true, sold: true, held: true }, orderBy: [{ ratePlanId: 'asc' }, { stayDate: 'asc' }] }),
    }
  }

  async function hotel(label: string, city: string, basis: 'SELL' | 'NET') {
    const boardId = (await owner.boardBasis.findFirstOrThrow({ where: { tenantId: tenantA } })).id
    const hotelId = (await owner.hotel.create({ data: { tenantId: tenantA, name: `${suffix} ${label}`, propertyType: 'HOTEL', city, countryCode: 'AE', contentStatus: 'COMPLETE', starRating: 5 } })).id; hotelIds.push(hotelId)
    const roomId = (await owner.roomType.create({ data: { hotelId, name: 'Deluxe', code: `${suffix}-${label}`, maxAdults: 2, maxOccupancy: 2 } })).id
    const mapping = await owner.supplierHotelMapping.create({ data: { tenantId: tenantA, supplierId, hotelId, supplierHotelId: `${suffix}-${label}-h`, status: 'MAPPED' } })
    await owner.supplierRoomMapping.create({ data: { tenantId: tenantA, supplierHotelMappingId: mapping.id, hotelId, supplierRoomId: `${suffix}-${label}-r`, roomTypeId: roomId, status: 'MAPPED' } })
    const contractId = (await owner.contract.create({ data: { tenantId: tenantA, supplierId, supplierHotelMappingId: mapping.id, code: `${suffix}-${label}`, status: 'ACTIVE', validFrom: new Date('2026-01-01'), validTo: new Date('2099-12-31'), settlementCurrency: 'AED' } as never })).id
    const planId = (await owner.ratePlan.create({ data: { tenantId: tenantA, contractId, roomTypeId: roomId, boardBasisId: boardId, code: `P-${label}`, status: 'ACTIVE', occupancy: 2, currency: 'AED' } })).id
    const nights = [day(20), day(21)].map((d) => new Date(d))
    await owner.dailyRate.createMany({ data: nights.map((stayDate) => ({ tenantId: tenantA, ratePlanId: planId, stayDate, occupancy: 2, amountMinor: 50_000n, currency: 'AED', amountBasis: basis })) })
    await owner.dailyAvailability.createMany({ data: nights.map((stayDate) => ({ tenantId: tenantA, ratePlanId: planId, stayDate, allotment: 9 })) })
    return { hotelId, planId }
  }

  beforeAll(async () => {
    await owner.$connect()
    tenantA = (await owner.tenant.create({ data: { name: `${suffix}a`, slug: `${suffix}a` } })).id
    tenantB = (await owner.tenant.create({ data: { name: `${suffix}b`, slug: `${suffix}b` } })).id
    supplierId = (await owner.supplier.create({ data: { tenantId: tenantA, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: suffix, displayName: 'S', countryCode: 'AE', defaultCurrency: 'AED' } })).id
    await owner.boardBasis.create({ data: { tenantId: tenantA, code: 'BB', name: 'B&B' } })
    const sell = await hotel('sell', 'Dubai', 'SELL'); sellHotelId = sell.hotelId; sellPlanId = sell.planId
    netHotelId = (await hotel('net', 'Sharjah', 'NET')).hotelId
    const creator = await user('creator', tenantA, [])
    agencyId = (await owner.agency.create({ data: { tenantId: tenantA, code: `AG-${suffix.slice(-6).toUpperCase()}`, name: 'Member agency', createdById: creator.id } })).id
    otherAgencyId = (await owner.agency.create({ data: { tenantId: tenantA, code: `AX-${suffix.slice(-6).toUpperCase()}`, name: 'Other agency', createdById: creator.id } })).id
    const member = await user('member', tenantA, ['hotel.search']); await owner.agencyMember.create({ data: { tenantId: tenantA, agencyId, userId: member.id } })
    await user('plain', tenantA, ['hotel.search'])
    await user('admin', tenantA, ADMIN_KEYS); await user('reader', tenantA, READ_KEYS); await user('none', tenantA, [])
    await user('otheradmin', tenantB, ADMIN_KEYS)
    await owner.commercialMarkupRule.create({ data: { tenantId: tenantA, scope: 'TENANT_DEFAULT', basisPoints: 1_000, validFrom: new Date(day(-30)), status: 'ACTIVE', activatedAt: new Date(), reason: 'Standard margin', createdById: creator.id } })

    await provisionApiRuntimeRole(owner, { password: runtimePassword })
    previousUrl = process.env.DATABASE_URL
    const u = new URL(ownerUrl!); u.username = API_RUNTIME_LOGIN_ROLE; u.password = runtimePassword
    process.env.DATABASE_URL = u.toString(); process.env.ADMIN_ORIGIN = origin
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication()
    app.use(cookieParser()); app.setGlobalPrefix('api/v1')
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
    app.useGlobalFilters(new HttpExceptionFilter()); app.useGlobalInterceptors(new ResponseInterceptor())
    await app.init()
    for (const label of ['member', 'plain', 'admin', 'reader', 'none', 'otheradmin']) {
      const r = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', origin).send({ email: `${suffix}-${label}@example.test`, password }).expect(200)
      cookies[label] = (r.headers['set-cookie'][0] as string).split(';')[0]
    }
  }, 180_000)

  afterAll(async () => {
    await app?.close()
    if (previousUrl) process.env.DATABASE_URL = previousUrl
    for (const table of ['Agency', 'AgencyMember', 'DistributionRestriction', 'CommercialMarkupRule']) await grant(table).catch(() => undefined)
    for (const t of [tenantA, tenantB].filter(Boolean)) {
      await owner.auditEvent.deleteMany({ where: { tenantId: t } }); await owner.distributionRestriction.deleteMany({ where: { tenantId: t } }); await owner.agencyMember.deleteMany({ where: { tenantId: t } })
      await owner.agency.deleteMany({ where: { tenantId: t } }); await owner.commercialMarkupRule.deleteMany({ where: { tenantId: t } }); await owner.serviceCaseNote.deleteMany({ where: { tenantId: t } }); await owner.serviceCase.deleteMany({ where: { tenantId: t } })
      await owner.dailyRate.deleteMany({ where: { tenantId: t } }); await owner.dailyAvailability.deleteMany({ where: { tenantId: t } }); await owner.ratePlan.deleteMany({ where: { tenantId: t } }); await owner.contract.deleteMany({ where: { tenantId: t } })
      await owner.supplierRoomMapping.deleteMany({ where: { tenantId: t } }); await owner.supplierHotelMapping.deleteMany({ where: { tenantId: t } }); await owner.boardBasis.deleteMany({ where: { tenantId: t } })
      await owner.roomType.deleteMany({ where: { hotel: { tenantId: t } } }); await owner.hotel.deleteMany({ where: { tenantId: t } }); await owner.supplier.deleteMany({ where: { tenantId: t } })
      await owner.userRole.deleteMany({ where: { tenantId: t } }); await owner.rolePermission.deleteMany({ where: { role: { tenantId: t } } }); await owner.role.deleteMany({ where: { tenantId: t } }); await owner.membership.deleteMany({ where: { tenantId: t } })
    }
    await owner.session.deleteMany({ where: { userId: { in: userIds } } }); await owner.user.deleteMany({ where: { id: { in: userIds } } }); await owner.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB].filter(Boolean) } } })
    await owner.$disconnect()
  }, 60_000)

  // ---- the runtime principal -----------------------------------------------------------------------------------------------------------
  it('SC-01 the app is connected as the strict API login role, which is non-superuser, non-BYPASSRLS, owns nothing, and verifies clean', async () => {
    const [who] = await owner.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM pg_stat_activity WHERE usename = '${API_RUNTIME_LOGIN_ROLE}' AND datname = current_database()`)
    expect(Number(who.n)).toBeGreaterThan(0)
    const probe = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL })
    try {
      expect(await verifyApiRuntimeRole(probe)).toEqual({ ok: true, failures: [] })
      const [attrs] = await probe.$queryRawUnsafe<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user')
      expect(attrs).toEqual({ rolsuper: false, rolbypassrls: false })
    } finally { await probe.$disconnect() }
  })

  // ---- valid flow and legitimate empty configuration -----------------------------------------------------------------------------------
  it('SC-02 a valid search and recheck succeed: SELL as stored, NET with the active markup; no agency, no restrictions', async () => {
    const sell = await search('plain', 'Dubai').expect(201)
    expect(sell.body.data.status).toBe('available')
    const sellRate = ratesOf(sell.body).find((r) => r.ratePlanId === sellPlanId)!
    expect(sellRate).toMatchObject({ available: true, sellAmountMinor: 100_000 })
    const net = await search('plain', 'Sharjah').expect(201)
    const netRates = ratesOf(net.body)
    expect(netRates).toHaveLength(1)
    expect(netRates[0].sellAmountMinor).toBe(110_000) // two nights of 500.00 plus ten percent, integer minor units
    const rc = await call('post', '/agent/rates/recheck', 'plain', { offerId: sellRate.offerId, searchId: sell.body.data.searchId, expectedCurrency: 'AED', expectedSellAmountMinor: sellRate.sellAmountMinor })
    expect(rc.status).toBe(200); expect(rc.body.data.status).toBe('rechecked')
  })

  it('SC-03 legitimately empty configuration follows the documented defaults: an agency member with no restriction searches normally; no markup rule means NET is not sellable, not zero-markup', async () => {
    const asMember = await search('member', 'Dubai').expect(201)
    expect(asMember.body.data.status).toBe('available')
    await owner.commercialMarkupRule.updateMany({ where: { tenantId: tenantA }, data: { status: 'RETIRED', retiredAt: new Date() } })
    try {
      const net = await search('plain', 'Sharjah').expect(201)
      expect(net.body.data.status).not.toBe('provider_unavailable') // the read succeeded; the rule is simply absent
      expect(ratesOf(net.body).filter((r) => r.available && r.sellAmountMinor > 0)).toHaveLength(0)
      const sell = await search('plain', 'Dubai').expect(201)
      expect(ratesOf(sell.body).filter((r) => r.available)).toHaveLength(1)
    } finally { await owner.commercialMarkupRule.updateMany({ where: { tenantId: tenantA }, data: { status: 'ACTIVE', retiredAt: null } }) }
  })

  // ---- failure injection --------------------------------------------------------------------------------------------------------------
  it('SC-04 markup rules unreadable: a NET search and recheck fail closed (no offer, no price), a SELL-only search is unaffected, nothing is consumed; restoring the grant restores NET', async () => {
    const before = await search('plain', 'Sharjah').expect(201)
    const offer = ratesOf(before.body)[0]
    const sideBefore = await sideEffects()
    await revoke('CommercialMarkupRule')
    try {
      const net = await search('plain', 'Sharjah').expect(201)
      expect(net.body.data.status).toBe('provider_unavailable')
      expect(net.body.data.hotels).toEqual([]); expect(net.body.data.total).toBe(0)
      const rc = await call('post', '/agent/rates/recheck', 'plain', { offerId: offer.offerId, searchId: before.body.data.searchId, expectedCurrency: 'AED', expectedSellAmountMinor: offer.sellAmountMinor })
      expect(rc.status).toBe(503); expect(rc.body.data.status).toBe('provider_unavailable')
      expect(JSON.stringify(net.body) + JSON.stringify(rc.body)).not.toMatch(/CommercialMarkupRule|permission denied|42501/)
      const sellOnly = await search('plain', 'Dubai').expect(201)
      expect(ratesOf(sellOnly.body).filter((r) => r.available)).toHaveLength(1)
    } finally { await grant('CommercialMarkupRule') }
    expect(await sideEffects()).toEqual(sideBefore)
    const restored = await search('plain', 'Sharjah').expect(201)
    expect(ratesOf(restored.body)[0].sellAmountMinor).toBe(110_000)
  })

  it('SC-05 distribution restrictions unreadable: search and recheck fail closed even though this user has none; a restricted hotel never appears after the grant returns', async () => {
    const sellOffer = ratesOf((await search('member', 'Dubai').expect(201)).body)[0]
    const searchId = (await search('member', 'Dubai').expect(201)).body.data.searchId
    const sideBefore = await sideEffects()
    await revoke('DistributionRestriction')
    try {
      const s = await search('member', 'Dubai').expect(201)
      expect(s.body.data.status).toBe('provider_unavailable'); expect(s.body.data.hotels).toEqual([])
      const rc = await call('post', '/agent/rates/recheck', 'member', { offerId: sellOffer.offerId, searchId, expectedCurrency: 'AED', expectedSellAmountMinor: sellOffer.sellAmountMinor })
      expect(rc.status).toBe(503); expect(rc.body.data.status).toBe('provider_unavailable')
      expect(JSON.stringify(s.body) + JSON.stringify(rc.body)).not.toMatch(/DistributionRestriction|permission denied|42501/)
    } finally { await grant('DistributionRestriction') }
    expect(await sideEffects()).toEqual(sideBefore)
    await owner.distributionRestriction.create({ data: { tenantId: tenantA, agencyId, scope: 'HOTEL', hotelId: sellHotelId, reason: 'test', createdById: userIds[0] } })
    const restricted = await search('member', 'Dubai').expect(201)
    expect(ratesOf(restricted.body).filter((r) => r.available)).toHaveLength(0)
    const unaffected = await search('plain', 'Dubai').expect(201)
    expect(ratesOf(unaffected.body).filter((r) => r.available)).toHaveLength(1) // another agency's restriction never leaks to a user with none
    await owner.distributionRestriction.deleteMany({ where: { tenantId: tenantA } })
    expect(ratesOf((await search('member', 'Dubai').expect(201)).body).filter((r) => r.available)).toHaveLength(1)
  })

  it('SC-06 agency tables unreadable: the suspension guard answers 503 COMMERCIAL_CONTROL_UNAVAILABLE whenever it must read them; a user it never needs them for still cannot get an unrestricted search', async () => {
    const sideBefore = await sideEffects()
    const refused = (res: request.Response) => {
      expect(res.status).toBe(503)
      expect(res.body.error).toMatchObject({ code: 'COMMERCIAL_CONTROL_UNAVAILABLE' })
      expect(JSON.stringify(res.body)).not.toMatch(/Agency|permission denied|42501|prisma/i)
      expect(res.body.meta.requestId).toBeTruthy()
    }
    // Membership unreadable: nobody can be classified, so everybody is refused.
    await revoke('AgencyMember')
    try { for (const who of ['member', 'plain']) refused(await search(who, 'Dubai')) } finally { await grant('AgencyMember') }
    // Agency unreadable: a member's agency status cannot be known, so the member is refused. A user with no membership has no status to read,
    // but the restriction lookup joins the agency table, so that search fails closed too, as a provider_unavailable search with no offers.
    await revoke('Agency')
    try {
      refused(await search('member', 'Dubai'))
      const plain = await search('plain', 'Dubai').expect(201)
      expect(plain.body.data.status).toBe('provider_unavailable'); expect(plain.body.data.hotels).toEqual([])
    } finally { await grant('Agency') }
    expect(await sideEffects()).toEqual(sideBefore)
    expect((await search('member', 'Dubai').expect(201)).body.data.status).toBe('available')
  })

  it('SC-07 a SUSPENDED agency is still blocked on the strict role (the valid control path is unchanged)', async () => {
    await owner.agency.update({ where: { id: agencyId }, data: { status: 'SUSPENDED' } })
    try {
      const res = await search('member', 'Dubai')
      expect(res.status).toBe(403); expect(res.body.error.code).toBe('AGENCY_SUSPENDED')
      expect((await search('plain', 'Dubai').expect(201)).body.data.status).toBe('available')
    } finally { await owner.agency.update({ where: { id: agencyId }, data: { status: 'ACTIVE' } }) }
  })

  // ---- Admin authorization ------------------------------------------------------------------------------------------------------------
  const MUTATIONS: Array<{ name: string; method: 'post' | 'patch'; path: () => string; body: () => object; table: string; crossTenant404: boolean }> = [
    { name: 'markup rule create', method: 'post', path: () => '/admin/commercial/markups', body: () => ({ scope: 'TENANT_DEFAULT', basisPoints: 500, validFrom: day(-1), reason: 'Strict role probe' }), table: 'commercialMarkupRule', crossTenant404: false },
    { name: 'agency create', method: 'post', path: () => '/admin/clients/agencies', body: () => ({ code: `PR-${randomBytes(3).toString('hex')}`.toUpperCase(), name: 'Probe agency', countryCode: 'AE' }), table: 'agency', crossTenant404: false },
    { name: 'agency update', method: 'patch', path: () => `/admin/clients/agencies/${agencyId}`, body: () => ({ name: 'Renamed by probe' }), table: 'agency', crossTenant404: true },
    { name: 'distribution restriction create', method: 'post', path: () => '/admin/distribution/restrictions', body: () => ({ agencyId: otherAgencyId, scope: 'HOTEL', hotelId: netHotelId, reason: 'Strict role probe' }), table: 'distributionRestriction', crossTenant404: true },
    { name: 'service case create', method: 'post', path: () => '/admin/service/cases', body: () => ({ subject: 'Voucher not received', description: 'Probe case: the voucher email did not arrive for the booking.', category: 'BOOKING' }), table: 'serviceCase', crossTenant404: false },
    { name: 'supply hotel update', method: 'patch', path: () => `/supply/hotels/${sellHotelId}`, body: () => ({ name: 'Renamed by probe' }), table: 'hotel', crossTenant404: true },
    { name: 'inventory pool create', method: 'post', path: () => `/admin/hotels/${sellHotelId}/inventory/pools`, body: () => ({ name: 'Probe pool', supplierId, ratePlanIds: [], idempotencyKey: `${suffix}-${randomBytes(4).toString('hex')}` }), table: 'inventoryPool', crossTenant404: true },
  ]
  const tableCount = (table: string) => (owner as unknown as Record<string, { count(args: object): Promise<number> }>)[table].count({})

  it.each(MUTATIONS.map((m) => [m.name, m] as const))('SC-08 %s: unauthenticated 401, no permission 403, read-only 403, other tenant 404 or 403; nothing written, no audit event', async (_name, m) => {
    const rowsBefore = await tableCount(m.table); const auditBefore = await owner.auditEvent.count()
    const expectDenied = async (who: string, statuses: number[]) => {
      const res = await call(m.method, m.path(), who, m.body())
      expect({ who, allowed: statuses.includes(res.status), status: res.status }).toEqual({ who, allowed: true, status: res.status })
      expect(JSON.stringify(res.body)).not.toMatch(/permission denied|42501|prisma|SELECT|INSERT/i)
      return res
    }
    expect((await call(m.method, m.path(), 'anon', m.body())).status).toBe(401)
    const none = await expectDenied('none', [403]); expect(none.body.error.code).toBe('FORBIDDEN')
    const reader = await expectDenied('reader', [403]); expect(reader.body.error.code).toBe('FORBIDDEN')
    if (m.crossTenant404) await expectDenied('otheradmin', [404, 403])
    expect(await tableCount(m.table)).toBe(rowsBefore)
    const created = (await owner.auditEvent.findMany({ orderBy: { createdAt: 'desc' }, take: (await owner.auditEvent.count()) - auditBefore, select: { action: true } })).map((e) => e.action)
    expect(created.filter((a) => !['permission.denied', 'tenant.context.selected'].includes(a))).toEqual([]) // no mutation or success audit; the denial audit is the intended one
  })

  // Privileged paths: the contract never gives the runtime role these writes, so an authorized caller gets a typed 403, audited, with nothing written.
  const PRIVILEGED: Array<{ name: string; method: 'post' | 'patch'; path: () => string; body: () => object; table: string }> = [
    { name: 'supply hotel external_ref (column outside the Hotel write set)', method: 'patch', path: () => `/supply/hotels/${sellHotelId}`, body: () => ({ externalRef: 'probe' }), table: 'hotel' },
    { name: 'inventory pool create', method: 'post', path: () => `/admin/hotels/${sellHotelId}/inventory/pools`, body: () => ({ name: 'Probe pool', supplierId, ratePlanIds: [], idempotencyKey: `${suffix}-${randomBytes(4).toString('hex')}` }), table: 'inventoryPool' },
    { name: 'board basis create (supply authoring)', method: 'post', path: () => '/supply/board-bases', body: () => ({ code: 'PRB', name: 'Probe board' }), table: 'boardBasis' },
  ]
  it.each(PRIVILEGED.map((m) => [m.name, m] as const))('SC-09 privileged path %s: authorized caller gets a typed 403 RUNTIME_ROLE_OPERATION_PROHIBITED, an audit event, nothing written, no raw database text', async (_name, m) => {
    const rowsBefore = await tableCount(m.table)
    const auditBefore = await owner.auditEvent.count()
    const res = await call(m.method, m.path(), 'admin', m.body())
    expect(res.status).toBe(403)
    expect(res.body.error).toMatchObject({ code: 'RUNTIME_ROLE_OPERATION_PROHIBITED' })
    expect(JSON.stringify(res.body)).not.toMatch(/permission denied|42501|prisma|"public"|relation|SELECT|INSERT|UPDATE|Hotel|BoardBasis|InventoryPool/)
    expect(res.body.meta.requestId).toBeTruthy()
    expect(await tableCount(m.table)).toBe(rowsBefore)
    const created = (await owner.auditEvent.findMany({ orderBy: { createdAt: 'desc' }, take: (await owner.auditEvent.count()) - auditBefore, select: { action: true } })).map((e) => e.action).sort()
    expect(created).toEqual(['runtime_role.operation_prohibited', 'tenant.context.selected'])
  })

  it('SC-09b a hotel external_ref change is refused whole: the name sent with it is not applied either (no partial execution)', async () => {
    const before = await owner.hotel.findUniqueOrThrow({ where: { id: sellHotelId } })
    const res = await call('patch', `/supply/hotels/${sellHotelId}`, 'admin', { name: 'Partially applied?', externalRef: 'probe' })
    expect(res.status).toBe(403)
    const after = await owner.hotel.findUniqueOrThrow({ where: { id: sellHotelId } })
    expect({ name: after.name, ref: after.externalRef }).toEqual({ name: before.name, ref: before.externalRef })
  })

  it('SC-13 grant drift: an authorized workflow whose contract grant was removed answers a sanitized 503 (configuration), never 403, and writes nothing; restoring the grant restores it', async () => {
    await owner.$executeRawUnsafe(`REVOKE INSERT ON "Agency" FROM ${API_RUNTIME_GROUP_ROLE}`)
    const rowsBefore = await owner.agency.count()
    try {
      const res = await call('post', '/admin/clients/agencies', 'admin', { code: `DR-${randomBytes(3).toString('hex')}`.toUpperCase(), name: 'Drift probe', countryCode: 'AE' })
      expect(res.status).toBe(503)
      expect(res.body.error).toMatchObject({ code: 'DATABASE_ROLE_NOT_PERMITTED' })
      expect(JSON.stringify(res.body)).not.toMatch(/permission denied|42501|prisma|Agency/)
      expect(await owner.agency.count()).toBe(rowsBefore)
      const probe = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL })
      try { expect((await verifyApiRuntimeRole(probe)).failures.join(' ')).toMatch(/role lacks contract write INSERT on Agency/) } finally { await probe.$disconnect() }
    } finally { await owner.$executeRawUnsafe(`GRANT INSERT ON "Agency" TO ${API_RUNTIME_GROUP_ROLE}`) }
    const ok = await call('post', '/admin/clients/agencies', 'admin', { code: `DR-${randomBytes(3).toString('hex')}`.toUpperCase(), name: 'Drift probe restored', countryCode: 'AE' })
    expect(ok.status).toBe(201)
  })

  it('SC-10 the database refuses privileged-path writes at the grant layer, independent of the API (and accepts the granted columns)', async () => {
    const probe = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL })
    const inTenant = (statement: string) => probe.$transaction(async (tx) => { await tx.$executeRawUnsafe(`SELECT set_config('app.current_tenant_id', '${tenantA}', true)`); return tx.$executeRawUnsafe(statement) })
    try {
      const refused: string[] = [
        `UPDATE "InventoryPoolDay" SET sold = 0`, `UPDATE "InventoryPoolDay" SET held = 0`, `UPDATE "InventoryPoolDay" SET tenant_id = tenant_id`, `INSERT INTO "InventoryPoolDay" (id) VALUES ('x')`, `DELETE FROM "InventoryPoolDay"`, `UPDATE "InventoryPool" SET name = name`, `DELETE FROM "SupplierMutation"`, `UPDATE "RoomType" SET hotel_id = hotel_id`,
        `UPDATE "Hotel" SET external_ref = 'x'`, `UPDATE "Hotel" SET tenant_id = tenant_id`, `DELETE FROM "Hotel"`, `UPDATE "DailyRate" SET amount_minor = 0`, `UPDATE "RatePlan" SET code = code`,
        `UPDATE "AuditEvent" SET action = 'x'`, `DELETE FROM "AuditEvent"`, `DELETE FROM "CommercialMarkupRule"`, `DELETE FROM "Agency"`, `UPDATE "AgencyMember" SET user_id = user_id`,
        `UPDATE "HotelExternalIdentifier" SET value = value`, `TRUNCATE "HotelImage"`,
      ]
      for (const statement of refused) await expect(inTenant(statement)).rejects.toThrow(/permission denied/)
      for (const statement of [`UPDATE "Hotel" SET name = name WHERE false`, `UPDATE "InventoryPoolDay" SET capacity = capacity, updated_at = updated_at WHERE false`, `UPDATE "Hotel" SET content_status = content_status, updated_at = updated_at WHERE false`, `UPDATE "CommercialMarkupRule" SET status = status WHERE false`, `UPDATE "Agency" SET status = status WHERE false`]) await inTenant(statement)
    } finally { await probe.$disconnect() }
    expect(await owner.commercialMarkupRule.count({ where: { basisPoints: 0 } })).toBe(0)
  })

  it('SC-11 tenant isolation holds on the new reads: the runtime role sees only the transaction tenant\'s controls, and none without tenant context', async () => {
    const probe = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL })
    try {
      const count = (tenant: string | null, table: string) => probe.$transaction(async (tx) => {
        if (tenant) await tx.$executeRawUnsafe(`SELECT set_config('app.current_tenant_id', '${tenant}', true)`)
        const [row] = await tx.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM "${table}"`); return Number(row.n)
      })
      for (const table of ['Agency', 'AgencyMember', 'CommercialMarkupRule']) {
        expect({ table, a: await count(tenantA, table) > 0, b: await count(tenantB, table), none: await count(null, table) }).toEqual({ table, a: true, b: 0, none: 0 })
      }
      // The setting is transaction-local: a reused pooled connection sees no tenant afterwards.
      await count(tenantA, 'Agency')
      expect(await count(null, 'Agency')).toBe(0)
    } finally { await probe.$disconnect() }
  })

  it('SC-12 the Agent hotel-image route reads HotelImage on the strict role (granted for the images workflow): an unknown image is a clean 404, not a 503 or 500', async () => {
    const res = await call('get', `/agent/hotels/${sellHotelId}/images/${randomBytes(8).toString('hex')}/content`, 'plain')
    expect(res.status).toBe(404)
  })
})
