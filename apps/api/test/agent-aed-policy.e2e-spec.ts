import './aed-policy.setup'
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

jest.setTimeout(180_000)

/** The production default: AED is the only enabled currency (ADR 0029). This suite sets SETTLEMENT_CURRENCIES=AED before the app loads. */
describe('AED-only launch currency policy (PostgreSQL, HTTP)', () => {
  const prisma = new PrismaClient()
  const suffix = `aed-${Date.now()}-${randomBytes(3).toString('hex')}`
  const password = 'aed-policy-password'
  const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z').getTime()
  const day = (o: number) => new Date(today + o * 86_400_000).toISOString().slice(0, 10)
  let app: INestApplication
  let tenantId = '', supplierId = '', hotelId = '', roomId = '', boardId = ''
  const userIds: string[] = []; const roleIds: string[] = []
  const cookies: Record<string, string> = {}

  async function user(label: string, keys: string[]) {
    const email = `${suffix}-${label}@example.test`
    const u = await prisma.user.create({ data: { email, name: label, passwordHash: await hashPassword(password), status: 'ACTIVE' } })
    userIds.push(u.id)
    await prisma.membership.create({ data: { tenantId, userId: u.id, role: 'agent' } })
    const r = await prisma.role.create({ data: { tenantId, name: `${suffix}-${label}` } }); roleIds.push(r.id)
    for (const k of keys) {
      const p = await prisma.permission.upsert({ where: { key: k }, update: {}, create: { key: k, description: k } })
      await prisma.rolePermission.create({ data: { roleId: r.id, permissionId: p.id } })
    }
    await prisma.userRole.create({ data: { tenantId, userId: u.id, roleId: r.id } })
    return email
  }
  async function login(email: string) {
    const response = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', 'http://localhost:3001').send({ email, password }).expect(200)
    return (response.headers['set-cookie'][0] as string).split(';')[0]
  }
  const call = (method: 'get' | 'post' | 'patch', path: string, who: string) => request(app.getHttpServer())[method](`/api/v1${path}`).set('Cookie', cookies[who])

  beforeAll(async () => {
    await prisma.$connect()
    tenantId = (await prisma.tenant.create({ data: { name: suffix, slug: suffix } })).id
    supplierId = (await prisma.supplier.create({ data: { tenantId, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${suffix} S`, displayName: 'S', countryCode: 'AE', defaultCurrency: 'AED' } as never })).id
    boardId = (await prisma.boardBasis.create({ data: { tenantId, code: 'BB', name: 'B&B' } })).id
    hotelId = (await prisma.hotel.create({ data: { tenantId, name: `${suffix} H`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', contentStatus: 'COMPLETE', starRating: 5 } })).id
    roomId = (await prisma.roomType.create({ data: { hotelId, name: 'Room', code: 'R1', maxAdults: 2, maxChildren: 0, maxOccupancy: 2 } })).id
    const staff = await user('staff', ['supply.contracts.read', 'supply.contracts.manage', 'supply.rates.read', 'supply.rates.manage'])
    const agent = await user('agent', ['hotel.search', 'booking.prebook'])
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = module.createNestApplication()
    app.use(cookieParser()); app.setGlobalPrefix('api/v1')
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
    app.useGlobalFilters(new HttpExceptionFilter()); app.useGlobalInterceptors(new ResponseInterceptor())
    await app.init()
    cookies.staff = await login(staff); cookies.agent = await login(agent)
  })

  afterAll(async () => {
    await app?.close()
    await prisma.auditEvent.deleteMany({ where: { tenantId } })
    await prisma.ratePlan.deleteMany({ where: { tenantId } })
    await prisma.contract.deleteMany({ where: { tenantId } })
    await prisma.boardBasis.deleteMany({ where: { tenantId } })
    await prisma.roomType.deleteMany({ where: { hotel: { tenantId } } })
    await prisma.hotel.deleteMany({ where: { tenantId } })
    await prisma.supplier.deleteMany({ where: { tenantId } })
    await prisma.userRole.deleteMany({ where: { tenantId } })
    await prisma.rolePermission.deleteMany({ where: { role: { tenantId } } })
    await prisma.role.deleteMany({ where: { tenantId } })
    await prisma.membership.deleteMany({ where: { tenantId } })
    await prisma.session.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.user.deleteMany({ where: { id: { in: userIds } } })
    await prisma.tenant.deleteMany({ where: { id: tenantId } })
    await prisma.$disconnect()
  })

  it('AED-01 contracts, rate plans and rates can only be written in AED', async () => {
    const body = (currency: string) => ({ supplierId, code: `C-${currency}-${randomBytes(2).toString('hex')}`, validFrom: day(-30), validTo: day(300), settlementCurrency: currency })
    const refused = await call('post', '/supply/contracts', 'staff').send(body('USD')).expect(400)
    expect(refused.body.error.code).toBe('CURRENCY_NOT_ENABLED'); expect(refused.body.error.message).toMatch(/Enabled: AED/)
    for (const bad of ['EUR', '', 'usdx']) await call('post', '/supply/contracts', 'staff').send(body(bad)).expect(400)
    const contract = (await call('post', '/supply/contracts', 'staff').send(body(' aed ')).expect(201)).body.data
    expect(contract.settlementCurrency).toBe('AED') // normalised
    await call('patch', `/supply/contracts/${contract.id}`, 'staff').send({ settlementCurrency: 'USD' }).expect(400)
    const plan = (b: object) => call('post', '/supply/rate-plans', 'staff').send({ contractId: contract.id, roomTypeId: roomId, boardBasisId: boardId, occupancy: 2, ...b })
    expect((await plan({ code: 'P-USD', currency: 'USD' }).expect(400)).body.error.code).toBe('CURRENCY_NOT_ENABLED')
    const ok = (await plan({ code: 'P-AED', currency: 'aed' }).expect(201)).body.data
    expect(ok.currency).toBe('AED')
    expect(await prisma.contract.count({ where: { tenantId, settlementCurrency: { not: 'AED' } } })).toBe(0)
    expect(await prisma.ratePlan.count({ where: { tenantId, currency: { not: 'AED' } } })).toBe(0)
  })

  it('AED-02 Agent search defaults to AED and refuses any other currency', async () => {
    const search = (extra: object) => call('post', '/agent/search', 'agent').send({ destination: 'Dubai', checkIn: day(10), checkOut: day(12), rooms: 1, adults: 2, children: 0, childAges: [], nationality: 'IN', limit: 10, ...extra })
    const res = await search({}).expect(201)
    expect(res.body.data.request.currency).toBe('AED') // the default is AED, not USD
    expect((await search({ currency: 'AED' }).expect(201)).body.data.request.currency).toBe('AED')
    for (const c of ['USD', 'EUR', 'aed']) await search({ currency: c }).expect(400)
  })

  it('AED-04 the Agent context tells the app which currencies are enabled', async () => {
    const ctx = (await call('get', '/agent/context', 'agent').expect(200)).body.data
    expect(ctx.settlementCurrencies).toEqual(['AED'])
  })

  it('AED-03 hold and recheck requests refuse a non-AED expected currency before any work is done', async () => {
    for (const path of ['/agent/offers/offer-1/hold']) {
      await call('post', path, 'agent').send({ searchId: 's', expectedCurrency: 'USD', expectedSellAmountMinor: 1000, idempotencyKey: 'idem-key-0001' }).expect(400)
    }
    await call('post', '/agent/rates/recheck', 'agent').send({ offerId: 'o', searchId: 's', expectedCurrency: 'EUR', expectedSellAmountMinor: 1000 }).expect(400)
  })
})
