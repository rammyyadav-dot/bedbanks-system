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
import { STEP_UP_FIELD } from '@bedbanks/contracts'

jest.setTimeout(180_000)

/**
 * Controlled FX (ADR 0067, F-12) over HTTP against PostgreSQL, two tenants. An AED contract is offered in USD only at an ACTIVE controlled
 * rate that a second person approved; the price is converted exactly once in integer minor units with the buffer on top; a rate change between
 * search and recheck is price_changed; and without a rate the contract is simply not offered in USD.
 */
describe('controlled FX rates (PostgreSQL, HTTP, two tenants)', () => {
  const prisma = new PrismaClient()
  const suffix = `fx-${Date.now()}-${randomBytes(3).toString('hex')}`
  const password = 'controlled-fx-password'
  const midnight = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z').getTime()
  const day = (offset: number) => new Date(midnight + offset * 86_400_000).toISOString().slice(0, 10)
  const utc = (offset: number) => new Date(midnight + offset * 86_400_000)
  const NIGHT = 44_850n // AED 448.50 SELL per night; two nights AED 897.00
  const previousCurrencies = process.env.SETTLEMENT_CURRENCIES
  let app: INestApplication
  let tenantA = '', tenantB = '', hotelA = ''
  const userIds: string[] = []
  const cookies: Record<string, string> = {}
  let seq = 0

  async function buildHotel(tenantId: string, supplierId: string, key: string) {
    const boardBasisId = (await prisma.boardBasis.upsert({ where: { tenantId_code: { tenantId, code: 'BB' } }, update: {}, create: { tenantId, code: 'BB', name: 'B&B' } })).id
    const hotel = await prisma.hotel.create({ data: { tenantId, name: `${suffix} ${key}`, externalRef: `${key}-${suffix.slice(-6)}`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', contentStatus: 'COMPLETE', starRating: 5 } })
    const room = await prisma.roomType.create({ data: { hotelId: hotel.id, name: 'Deluxe', code: `D-${key}`.slice(0, 40), maxAdults: 2, maxChildren: 0, maxOccupancy: 2 } })
    const mapping = await prisma.supplierHotelMapping.create({ data: { tenantId, supplierId, hotelId: hotel.id, supplierHotelId: `${suffix}-${key}`, status: 'MAPPED' } })
    await prisma.supplierRoomMapping.create({ data: { tenantId, supplierHotelMappingId: mapping.id, hotelId: hotel.id, supplierRoomId: `${suffix}-${key}-r`, roomTypeId: room.id, status: 'MAPPED' } })
    const contract = await prisma.contract.create({ data: { tenantId, supplierId, supplierHotelMappingId: mapping.id, code: `${suffix}-${key}`, status: 'ACTIVE', validFrom: utc(-400), validTo: utc(4000), settlementCurrency: 'AED' } as never })
    const plan = await prisma.ratePlan.create({ data: { tenantId, contractId: contract.id, roomTypeId: room.id, boardBasisId, code: `${key}-BB`.slice(0, 40), status: 'ACTIVE', occupancy: 2, currency: 'AED', minStay: 1 } })
    const range = Array.from({ length: 30 }, (_, i) => utc(i))
    await prisma.dailyRate.createMany({ data: range.map((stayDate) => ({ tenantId, ratePlanId: plan.id, stayDate, occupancy: 2, amountMinor: NIGHT, currency: 'AED', amountBasis: 'SELL' as const })) })
    await prisma.dailyAvailability.createMany({ data: range.map((stayDate) => ({ tenantId, ratePlanId: plan.id, stayDate, allotment: 5, sold: 0, stopSell: false })) })
    return hotel.id
  }
  async function user(label: string, tenantId: string, keys: string[]) {
    const email = `${suffix}-${label}@example.test`
    const u = await prisma.user.create({ data: { email, passwordHash: await hashPassword(password), status: 'ACTIVE' } })
    userIds.push(u.id)
    await prisma.membership.create({ data: { tenantId, userId: u.id, role: 'agent' } })
    if (keys.length) {
      const r = await prisma.role.create({ data: { tenantId, name: `${suffix}-${label}` } })
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
  const base = '/api/v1/admin/commercial/fx-rates'
  const call = (method: 'get' | 'post', path: string, who: string, body?: object) => { const r = request(app.getHttpServer())[method](`${base}${path}`).set('Cookie', cookies[who]); return body ? r.send(body) : r }
  const search = (currency: string) => request(app.getHttpServer()).post('/api/v1/agent/search').set('Cookie', cookies.maker)
    .send({ destination: 'Dubai', checkIn: day(10), checkOut: day(12), rooms: 1, adults: 2, children: 0, childAges: [], nationality: 'IN', currency, limit: 100 })
  const offerFor = (body: { data: { hotels: Array<{ hotelId: string; rooms: Array<{ rates: Array<Record<string, unknown>> }> }> } }, hotelId: string) => {
    const rate = body.data.hotels.find((h) => h.hotelId === hotelId)?.rooms[0].rates[0]
    return rate ? ({ ...rate, currency: (rate.total as { currency: string }).currency } as Record<string, unknown>) : undefined
  }
  const draft = async (patch: object = {}, who = 'maker') => (await call('post', '', who, { baseCurrency: 'AED', quoteCurrency: 'USD', rate: '0.27229000', bufferBp: 100, reason: 'Treasury rate for the week', ...patch }).expect(201)).body.data
  const activate = async (rate: { id: string }) => {
    const requested = (await call('post', `/${rate.id}/request-activation`, 'maker', { requestId: `${suffix}-${++seq}`, reason: 'Weekly treasury rate' }).expect(200)).body.data
    await call('post', `/approvals/${requested.approval.id}/approve`, 'checker', { reason: 'Matches treasury', [STEP_UP_FIELD]: password }).expect(200)
    return (await call('post', `/approvals/${requested.approval.id}/execute`, 'maker').expect(200)).body.data
  }

  beforeAll(async () => {
    process.env.SETTLEMENT_CURRENCIES = 'AED,USD'
    await prisma.$connect()
    tenantA = (await prisma.tenant.create({ data: { name: `${suffix} A`, slug: `${suffix}-a` } })).id
    tenantB = (await prisma.tenant.create({ data: { name: `${suffix} B`, slug: `${suffix}-b` } })).id
    const supplierA = (await prisma.supplier.create({ data: { tenantId: tenantA, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${suffix} sA`, displayName: 'Alpha', countryCode: 'AE', defaultCurrency: 'AED' } })).id
    hotelA = await buildHotel(tenantA, supplierA, 'alpha')
    const manage = ['supply.rates.read', 'supply.rates.manage', 'supply.hotels.read', 'hotel.search']
    const maker = await user('maker', tenantA, manage); const checker = await user('checker', tenantA, manage)
    const viewer = await user('viewer', tenantA, ['supply.rates.read']); const bmaker = await user('bmaker', tenantB, manage)
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = module.createNestApplication()
    app.use(cookieParser()); app.setGlobalPrefix('api/v1')
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
    app.useGlobalFilters(new HttpExceptionFilter()); app.useGlobalInterceptors(new ResponseInterceptor())
    await app.init()
    cookies.maker = await login(maker); cookies.checker = await login(checker); cookies.viewer = await login(viewer); cookies.bmaker = await login(bmaker)
  })

  afterAll(async () => {
    await app?.close()
    for (const tenantId of [tenantA, tenantB].filter(Boolean)) {
      await prisma.auditEvent.deleteMany({ where: { tenantId } })
      await prisma.approvalRequest.deleteMany({ where: { tenantId } })
      await prisma.fxRate.deleteMany({ where: { tenantId } })
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
    if (previousCurrencies === undefined) delete process.env.SETTLEMENT_CURRENCIES; else process.env.SETTLEMENT_CURRENCIES = previousCurrencies
  })
  beforeEach(() => prisma.fxRate.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } }))

  it('FX-01 without an ACTIVE rate the AED contract is sold in AED and not offered in USD; a DRAFT changes nothing', async () => {
    expect(offerFor((await search('AED').expect(201)).body, hotelA)).toMatchObject({ currency: 'AED', sellAmountMinor: 89_700 })
    expect(offerFor((await search('USD').expect(201)).body, hotelA)).toBeUndefined()
    await draft()
    expect(offerFor((await search('USD').expect(201)).body, hotelA)).toBeUndefined()
  })

  it('FX-02 activation is maker-checker: the requester cannot approve, a viewer cannot change, another tenant cannot see it', async () => {
    const rate = await draft()
    expect(rate).toMatchObject({ status: 'DRAFT', rate: '0.27229000', bufferBp: 100, effectiveRate: '0.27501290', canRequestActivation: true })
    await call('post', '', 'viewer', { baseCurrency: 'AED', quoteCurrency: 'USD', rate: '1', reason: 'viewer' }).expect(403)
    const requested = (await call('post', `/${rate.id}/request-activation`, 'maker', { requestId: `${suffix}-${++seq}`, reason: 'Weekly rate' }).expect(200)).body.data
    await call('post', `/approvals/${requested.approval.id}/approve`, 'maker', { reason: 'self', [STEP_UP_FIELD]: password }).expect(403)
    await call('post', `/approvals/${requested.approval.id}/execute`, 'maker').expect(403) // not approved: refused by the direct-call guard before the service (ADR 0095)
    await call('post', `/approvals/${requested.approval.id}/approve`, 'bmaker', { reason: 'x', [STEP_UP_FIELD]: password }).expect(404)
    expect((await call('get', '', 'bmaker').expect(200)).body.data.total).toBe(0)
    await call('post', `/approvals/${requested.approval.id}/approve`, 'checker', { reason: 'ok', [STEP_UP_FIELD]: password }).expect(200)
    const done = (await call('post', `/approvals/${requested.approval.id}/execute`, 'maker').expect(200)).body.data
    expect(done.rate.status).toBe('ACTIVE')
    await call('post', `/approvals/${requested.approval.id}/execute`, 'maker').expect(403) // single use: an executed approval is no longer APPROVED, so the direct-call guard refuses it (ADR 0095)
  })

  it('FX-03 an ACTIVE rate converts the AED price once, in integer USD cents, with the buffer on top', async () => {
    await activate(await draft())
    const offer = offerFor((await search('USD').expect(201)).body, hotelA)!
    // 89700 fils * 0.27229 * 1.01 = 24668.6 cents -> 24669 (half up, once)
    expect(offer).toMatchObject({ currency: 'USD', sellAmountMinor: 24_669 })
    expect(Number.isInteger(offer.sellAmountMinor)).toBe(true)
    expect(offerFor((await search('AED').expect(201)).body, hotelA)).toMatchObject({ currency: 'AED', sellAmountMinor: 89_700 })
  })

  it('FX-04 a new rate between search and recheck is price_changed at the new rate; retiring it makes the offer unavailable', async () => {
    const first = await activate(await draft())
    const found = await search('USD').expect(201)
    const offer = offerFor(found.body, hotelA)!
    const second = await activate(await draft({ rate: '0.28000000', bufferBp: 0 }))
    expect(second.replacedRateId).toBe(first.rate.id)
    const recheck = (expected: number) => request(app.getHttpServer()).post('/api/v1/agent/rates/recheck').set('Cookie', cookies.maker)
      .send({ offerId: offer.offerId, searchId: found.body.data.searchId, expectedCurrency: 'USD', expectedSellAmountMinor: expected })
    expect((await recheck(offer.sellAmountMinor as number).expect(409)).body.data).toMatchObject({ status: 'price_changed', currency: 'USD', sellAmountMinor: 25_116 })
    await call('post', `/${second.rate.id}/retire`, 'maker').expect(200)
    expect((await recheck(25_116).expect(409)).body.data.status).toBe('unavailable')
    const actions = (await prisma.auditEvent.findMany({ where: { tenantId: tenantA, entityType: 'fx_rate' }, orderBy: { createdAt: 'asc' } })).map((e) => e.action)
    expect(actions).toEqual(expect.arrayContaining(['commercial.fx.created', 'commercial.fx.activated', 'commercial.fx.retired']))
    expect(await prisma.fxRate.count({ where: { tenantId: tenantA, status: 'ACTIVE' } })).toBe(0)
  })

  it('FX-05 validation: enabled, distinct currencies, a positive decimal string with at most eight places, a bounded buffer', async () => {
    const ok = { baseCurrency: 'AED', quoteCurrency: 'USD', rate: '0.27229', reason: 'Treasury' }
    for (const rate of ['0', '-1', '1.123456789', 0.27, '1e3', 'abc']) await call('post', '', 'maker', { ...ok, rate }).expect(400)
    for (const bufferBp of [-1, 2001, 1.5]) await call('post', '', 'maker', { ...ok, bufferBp }).expect(400)
    await call('post', '', 'maker', { ...ok, quoteCurrency: 'AED' }).expect(400)
    await call('post', '', 'maker', { ...ok, quoteCurrency: 'JPY' }).expect(400) // supported, not enabled here
    await call('post', '', 'maker', { ...ok, reason: '  ' }).expect(400)
    expect(await prisma.fxRate.count({ where: { tenantId: tenantA } })).toBe(0)
    expect((await call('post', '', 'maker', { ...ok, baseCurrency: 'aed' }).expect(201)).body.data).toMatchObject({ baseCurrency: 'AED', rate: '0.27229000', bufferBp: 0 })
  })
})
