import { INestApplication, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import * as cookieParser from 'cookie-parser'
import * as request from 'supertest'
import { PrismaClient } from '@prisma/client'
import { AppModule } from '../src/app.module'
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor'
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter'
import { hashPassword } from '../src/auth/utils/password'

const prisma = new PrismaClient()

describe('Dubai MVP 100-hotel commercial operations certification', () => {
  const suffix = `dubai-scale-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const password = 'dubai-scale-certification-password'
  const hotelCount = 100
  const dates = Array.from({ length: 7 }, (_, offset) => new Date(Date.UTC(2026, 10, 20 + offset)))
  let app: INestApplication
  let tenantId: string
  let userId: string
  let roleId: string
  let supplierId: string
  let boardId: string
  let contractId: string

  const ms = (started: bigint) => Number(process.hrtime.bigint() - started) / 1_000_000
  const metric = (name: string, value: number) => {
    // Kept in CI logs as evidence; deliberately no brittle latency threshold on shared runners.
    console.info(`DUBAI_SCALE_METRIC ${name}=${value.toFixed(2)}ms`)
  }

  beforeAll(async () => {
    await prisma.$connect()
    const tenant = await prisma.tenant.create({ data: { name: `${suffix} Tenant`, slug: suffix } })
    tenantId = tenant.id
    const user = await prisma.user.create({ data: { email: `${suffix}@example.test`, passwordHash: await hashPassword(password) } })
    userId = user.id

    const permissionKeys = [
      'supply.hotels.read', 'supply.rooms.read', 'supply.rates.read',
      'supply.contracts.read', 'supply.availability.read',
    ]
    const permissions = await Promise.all(permissionKeys.map((key) =>
      prisma.permission.upsert({ where: { key }, update: {}, create: { key, description: `${suffix} ${key}` } }),
    ))
    const role = await prisma.role.create({ data: { tenantId, name: `${suffix}-operator` } })
    roleId = role.id
    await prisma.rolePermission.createMany({ data: permissions.map((permission) => ({ roleId, permissionId: permission.id })) })
    await prisma.membership.create({ data: { tenantId, userId, role: 'owner' } })
    await prisma.userRole.create({ data: { tenantId, userId, roleId } })

    const supplier = await prisma.supplier.create({
      data: { tenantId, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${suffix} Supplier`, displayName: 'Dubai Internal Supply', countryCode: 'AE', defaultCurrency: 'AED' },
    })
    supplierId = supplier.id
    const board = await prisma.boardBasis.create({ data: { tenantId, code: 'BB', name: 'Bed & Breakfast' } })
    boardId = board.id
    const contract = await prisma.contract.create({
      data: { tenantId, supplierId, code: `${suffix}-contract`, status: 'ACTIVE', validFrom: new Date('2026-01-01T00:00:00.000Z'), validTo: new Date('2027-12-31T00:00:00.000Z'), settlementCurrency: 'AED' },
    })
    contractId = contract.id

    await prisma.hotel.createMany({
      data: Array.from({ length: hotelCount }, (_, index) => ({
        tenantId, name: `Dubai Scale Hotel ${String(index + 1).padStart(3, '0')}`, propertyType: 'HOTEL',
        city: 'Dubai', countryCode: 'AE', externalRef: `${suffix}-hotel-${index + 1}`,
      })),
    })
    const hotels = await prisma.hotel.findMany({ where: { tenantId, externalRef: { startsWith: `${suffix}-hotel-` } }, orderBy: { name: 'asc' } })
    await prisma.roomType.createMany({
      data: hotels.map((hotel, index) => ({
        hotelId: hotel.id, name: 'Deluxe Room', code: `${suffix}-DLX-${index + 1}`, maxAdults: 2, maxChildren: 1, maxOccupancy: 3,
      })),
    })
    const rooms = await prisma.roomType.findMany({ where: { hotelId: { in: hotels.map((hotel) => hotel.id) } }, orderBy: { code: 'asc' } })
    await prisma.ratePlan.createMany({
      data: rooms.map((room, index) => ({
        tenantId, contractId, roomTypeId: room.id, boardBasisId: boardId, code: `${suffix}-FLEX-${index + 1}`,
        status: 'ACTIVE', refundable: true, occupancy: 2, currency: 'AED', minStay: 1, releaseDays: 0,
      })),
    })
    const plans = await prisma.ratePlan.findMany({ where: { tenantId, contractId } })
    await prisma.dailyRate.createMany({
      data: plans.flatMap((plan) => dates.map((stayDate) => ({
        tenantId, ratePlanId: plan.id, stayDate, occupancy: 2, amountMinor: BigInt(29900), amountBasis: 'SELL' as const, currency: 'AED',
      }))),
    })
    await prisma.dailyAvailability.createMany({
      data: plans.flatMap((plan) => dates.map((stayDate) => ({
        tenantId, ratePlanId: plan.id, stayDate, allotment: 5, sold: 0, held: 0, stopSell: false, minStay: 1,
      }))),
    })

    const module = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = module.createNestApplication()
    app.use(cookieParser())
    app.setGlobalPrefix('api/v1')
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
    app.useGlobalFilters(new HttpExceptionFilter())
    app.useGlobalInterceptors(new ResponseInterceptor())
    await app.init()
  }, 60000)

  afterAll(async () => {
    await app?.close()
    await prisma.auditEvent.deleteMany({ where: { tenantId } })
    const plans = await prisma.ratePlan.findMany({ where: { tenantId, contractId }, select: { id: true } })
    const planIds = plans.map((plan) => plan.id)
    await prisma.dailyRate.deleteMany({ where: { ratePlanId: { in: planIds } } })
    await prisma.dailyAvailability.deleteMany({ where: { ratePlanId: { in: planIds } } })
    await prisma.ratePlan.deleteMany({ where: { id: { in: planIds } } })
    await prisma.contract.deleteMany({ where: { id: contractId } })
    await prisma.boardBasis.deleteMany({ where: { id: boardId } })
    const hotels = await prisma.hotel.findMany({ where: { tenantId, externalRef: { startsWith: `${suffix}-hotel-` } }, select: { id: true } })
    await prisma.roomType.deleteMany({ where: { hotelId: { in: hotels.map((hotel) => hotel.id) } } })
    await prisma.hotel.deleteMany({ where: { id: { in: hotels.map((hotel) => hotel.id) } } })
    await prisma.supplier.deleteMany({ where: { id: supplierId } })
    await prisma.userRole.deleteMany({ where: { userId } })
    await prisma.rolePermission.deleteMany({ where: { roleId } })
    await prisma.role.deleteMany({ where: { id: roleId } })
    await prisma.membership.deleteMany({ where: { userId } })
    await prisma.session.deleteMany({ where: { userId } })
    await prisma.user.deleteMany({ where: { id: userId } })
    await prisma.tenant.deleteMany({ where: { id: tenantId } })
    await prisma.$disconnect()
  }, 60000)

  async function login() {
    const response = await request(app.getHttpServer()).post('/api/v1/auth/login')
      .set('Origin', 'http://localhost:3001').send({ email: `${suffix}@example.test`, password }).expect(200)
    return response.headers['set-cookie'][0].split(';')[0]
  }

  function supply(cookie: string) {
    const configure = (test: request.Test) => test.set('Cookie', cookie).set('x-fbeds-tenant-id', tenantId)
    return {
      get: (path: string) => configure(request(app.getHttpServer()).get(path)),
      post: (path: string) => configure(request(app.getHttpServer()).post(path)),
    }
  }

  it('measures real API reads and sellability across 100 disposable Dubai hotels', async () => {
    const cookie = await login()
    const agent = supply(cookie)

    let started = process.hrtime.bigint()
    const hotels = await agent.get('/api/v1/supply/hotels').expect(200)
    metric('hotel_listing', ms(started))
    const scaleHotels = hotels.body.data.filter((hotel: { externalRef?: string }) => hotel.externalRef?.startsWith(`${suffix}-hotel-`))
    expect(scaleHotels).toHaveLength(hotelCount)

    started = process.hrtime.bigint()
    const roomResponses = []
    for (const hotel of scaleHotels) roomResponses.push(await agent.get(`/api/v1/supply/hotels/${hotel.id}/rooms`).expect(200))
    metric('room_listing_100_hotels', ms(started))
    expect(roomResponses.reduce((total, response) => total + response.body.data.length, 0)).toBe(hotelCount)

    started = process.hrtime.bigint()
    const plans = await agent.get('/api/v1/supply/rate-plans').expect(200)
    metric('rate_plan_listing', ms(started))
    const scalePlans = plans.body.data.filter((plan: { code: string }) => plan.code.startsWith(`${suffix}-FLEX-`))
    expect(scalePlans).toHaveLength(hotelCount)

    started = process.hrtime.bigint()
    const rates = await agent.get('/api/v1/supply/daily-rates?from=2026-11-20&to=2026-11-26').expect(200)
    metric('seven_day_rate_read', ms(started))
    expect(rates.body.data.filter((row: { ratePlanId: string }) => scalePlans.some((plan: { id: string }) => plan.id === row.ratePlanId))).toHaveLength(hotelCount * 7)

    started = process.hrtime.bigint()
    const availability = await agent.get('/api/v1/supply/availability?from=2026-11-20&to=2026-11-26').expect(200)
    metric('seven_day_availability_read', ms(started))
    expect(availability.body.data.filter((row: { ratePlanId: string }) => scalePlans.some((plan: { id: string }) => plan.id === row.ratePlanId))).toHaveLength(hotelCount * 7)

    started = process.hrtime.bigint()
    const sellability: Array<{ eligible: boolean }> = []
    for (let offset = 0; offset < scalePlans.length; offset += 10) {
      const batch = scalePlans.slice(offset, offset + 10)
      sellability.push(...await Promise.all(batch.map(async (plan: { id: string; occupancy: number }) => {
        const response = await agent.post('/api/v1/supply/sellability').send({ ratePlanId: plan.id, stayDate: '2026-11-20', occupancy: plan.occupancy }).expect(201)
        return response.body.data as { eligible: boolean }
      })))
    }
    metric('sellability_100_hotels', ms(started))
    expect(sellability).toHaveLength(hotelCount)
    expect(sellability.every((row) => row.eligible)).toBe(true)
  }, 60000)
})
