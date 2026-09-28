import { INestApplication, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import * as cookieParser from 'cookie-parser'
import * as request from 'supertest'
import { Prisma, PrismaClient } from '@prisma/client'
import type { SearchCriteria, SearchHotelOffer } from '@bedbanks/domain'
import { AppModule } from '../src/app.module'
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor'
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter'
import { hashPassword } from '../src/auth/utils/password'
import { SUPPLIER_ADAPTER, type SupplierAdapter, type SupplierRecheckRequest, type SupplierRequestContext, type SupplierSearchContext } from '../src/agent/supplier.port'

const prisma = new PrismaClient()

describe('Dubai MVP 100-hotel commercial operations certification', () => {
  const suffix = `dubai-scale-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const password = 'dubai-scale-certification-password'
  const hotelCount = 100
  const startDate = process.env.DUBAI_ACCEPTANCE_START_DATE ?? '2026-11-20'
  const start = new Date(`${startDate}T00:00:00.000Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !Number.isFinite(start.getTime()) || start.toISOString().slice(0, 10) !== startDate) throw new Error('INVALID_ACCEPTANCE_DATE')
  const dates = Array.from({ length: 7 }, (_, offset) => new Date(start.getTime() + offset * 86400000))
  const dateKeys = dates.map(day => day.toISOString().slice(0, 10))
  const windowQuery = `from=${dateKeys[0]}&to=${dateKeys[6]}`
  let cookie: string
  let otherTenantId: string
  let planIds: string[] = []
  let app: INestApplication
  let tenantId: string
  let userId: string
  let roleId: string
  let supplierId: string
  let boardId: string
  let contractId: string
  const offerAuthority = new Map<string, {
    supplierHotelId: string; supplierRoomId: string; canonicalHotelId: string; canonicalRoomTypeId: string
    ratePlanId: string; boardBasisId: string; checkIn: string; checkOut: string; sellAmountMinor: number
  }>()
  let canonicalOffers: SearchHotelOffer[] = []

  const ms = (started: bigint) => Number(process.hrtime.bigint() - started) / 1_000_000
  const metric = (name: string, value: number) => {
    // Kept in CI logs as evidence; deliberately no brittle latency threshold on shared runners.
    console.info(`DUBAI_SCALE_METRIC ${name}=${value.toFixed(2)}ms`)
  }
  const count = (name: string, value: number) => console.info(`DUBAI_ACCEPTANCE_COUNT ${name}=${value}`)
  const plusOne = (value: string) => new Date(Date.parse(`${value}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10)

  const supplierAdapter: SupplierAdapter = {
    name: 'dubai-disposable-fixture',
    async search(criteria: SearchCriteria, _context: SupplierSearchContext) {
      const offers = canonicalOffers.map((hotel) => ({
        ...hotel,
        rooms: hotel.rooms.map((room) => ({
          ...room,
          rates: room.rates.map((rate) => {
            const offerId = `${rate.canonicalHotelId}:${criteria.checkIn}`
            offerAuthority.set(offerId, {
              supplierHotelId: hotel.supplierHotelId, supplierRoomId: room.supplierRoomId,
              canonicalHotelId: rate.canonicalHotelId, canonicalRoomTypeId: rate.canonicalRoomTypeId,
              ratePlanId: rate.ratePlanId, boardBasisId: rate.boardBasisId,
              checkIn: criteria.checkIn, checkOut: criteria.checkOut, sellAmountMinor: rate.sellAmountMinor,
            })
            return {
              ...rate, offerId, expiresAt: new Date(Date.now() + 300_000).toISOString(),
              occupancy: { rooms: criteria.rooms, adults: criteria.adults, children: criteria.children, childAges: [...criteria.childAges] },
            }
          }),
        })),
      }))
      return { offers, providerSummary: { queried: 1, succeeded: 1, failed: 0 } }
    },
    async recheck(input: SupplierRecheckRequest, _context: SupplierRequestContext) {
      const authority = offerAuthority.get(input.offerId)
      if (!authority) return { status: 'unavailable' as const }
      return {
        status: 'available' as const,
        offer: {
          offerId: input.offerId, searchId: input.searchId, supplierId,
          supplierHotelId: authority.supplierHotelId, supplierRoomId: authority.supplierRoomId,
          canonicalHotelId: authority.canonicalHotelId, canonicalRoomTypeId: authority.canonicalRoomTypeId,
          ratePlanId: authority.ratePlanId, boardBasisId: authority.boardBasisId,
          checkIn: authority.checkIn, checkOut: authority.checkOut, rooms: 1, adults: 2, children: 0, childAges: [],
          currency: 'AED', sellAmountMinor: authority.sellAmountMinor, expiresAt: new Date(Date.now() + 300_000).toISOString(),
        },
      }
    },
    async prebook() { throw new Error('Booking is disabled in Dubai disposable acceptance') },
    async cancel() { throw new Error('Booking is disabled in Dubai disposable acceptance') },
  }

  beforeAll(async () => {
    await prisma.$connect()
    const tenant = await prisma.tenant.create({ data: { name: `${suffix} Tenant`, slug: suffix } })
    tenantId = tenant.id
    const user = await prisma.user.create({ data: { email: `${suffix}@example.test`, passwordHash: await hashPassword(password) } })
    userId = user.id

    const permissionKeys = [
      'supply.hotels.read', 'supply.rooms.read', 'supply.rates.read',
      'supply.contracts.read', 'supply.availability.read', 'supply.contracts.manage',
      'supply.rates.manage', 'supply.availability.manage', 'supply.suppliers.manage', 'supply.mappings.read', 'supply.mappings.manage', 'hotel.search',
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
      data: { tenantId, supplierId, code: `${suffix}-contract`, status: 'ACTIVE', validFrom: dates[0], validTo: dates[6], settlementCurrency: 'AED' },
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

    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SUPPLIER_ADAPTER).useValue(supplierAdapter).compile()
    app = module.createNestApplication()
    app.use(cookieParser())
    app.setGlobalPrefix('api/v1')
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
    app.useGlobalFilters(new HttpExceptionFilter())
    app.useGlobalInterceptors(new ResponseInterceptor())
    await app.init()
    cookie = await login()
    otherTenantId = (await prisma.tenant.create({ data: { name: `${suffix} Isolation`, slug: `${suffix}-other` } })).id
    // Bulk scale seed above; governance and commercial bindings use the real HTTP operations.
    const agent = supply(cookie)
    for (const plan of plans) {
      const room = rooms.find(value => value.id === plan.roomTypeId)!
      const path = '/api/v1/supply/mappings/hotels'
      const mapping = await agent.post(path).send({ supplierId, hotelId: room.hotelId, supplierHotelId: `${suffix}-${room.hotelId}` }).expect(201)
      const mappingPath = `${path}/${mapping.body.data.id}`
      await agent.post(`${mappingPath}/approve`).expect(201)
      const mappedRoom = await agent.post(`${mappingPath}/rooms`).send({ supplierRoomId: `${suffix}-${room.id}`, roomTypeId: room.id }).expect(201)
      await agent.post(`${mappingPath}/rooms/${mappedRoom.body.data.id}/approve`).expect(201)
      const bound = await agent.post('/api/v1/supply/contracts').send({ supplierId, supplierHotelMappingId: mapping.body.data.id, code: `${suffix}-${room.id}`, validFrom: dateKeys[0], validTo: dateKeys[6], settlementCurrency: 'AED' }).expect(201)
      await agent.patch(`/api/v1/supply/contracts/${bound.body.data.id}`).send({ status: 'ACTIVE' }).expect(200)
      await agent.patch(`/api/v1/supply/rate-plans/${plan.id}`).send({ contractId: bound.body.data.id }).expect(200)
      canonicalOffers.push({
        hotelId: room.hotelId, name: hotels.find(value => value.id === room.hotelId)!.name, destination: 'Dubai', starRating: 5,
        supplierId, supplierHotelId: `${suffix}-${room.hotelId}`,
        rooms: [{ roomTypeId: room.id, name: room.name, supplierRoomId: `${suffix}-${room.id}`, rates: [{
          offerId: `${room.hotelId}:seed`, tenantId, providerId: 'dubai-disposable-fixture',
          hotelId: room.hotelId, canonicalHotelId: room.hotelId, roomTypeId: room.id, canonicalRoomTypeId: room.id,
          supplierId, supplierRoomId: `${suffix}-${room.id}`, ratePlanId: plan.id, ratePlanName: plan.code, boardBasisId: boardId,
          boardBasisName: 'Bed & Breakfast', supplierRateId: `${suffix}-rate-${plan.id}`,
          expiresAt: new Date(Date.now() + 300_000).toISOString(), occupancy: { rooms: 1, adults: 2, children: 0, childAges: [] },
          availability: 'available', available: true, cancellation: { refundable: true, summary: 'Refundable fixture rate' },
          total: { amountMinor: 29900, currency: 'AED' }, netAmountMinor: 29900, taxAmountMinor: 0, feeAmountMinor: 0,
          totalAmountMinor: 29900, markupAmountMinor: 0, sellAmountMinor: 29900, paymentType: 'credit', source: 'hotel_direct',
        }] }],
      })
    }
    planIds = plans.map(plan => plan.id)
    console.info(`DUBAI_SCALE_DATA hotels=100 rooms=100 hotelMappings=100 roomMappings=100 rates=700 availability=700 timezone=Asia/Dubai start=${dateKeys[0]} end=${dateKeys[6]}`)
  }, 180000)

  afterAll(async () => {
    await app?.close()
    if (!tenantId) { await prisma.$disconnect(); return }
    await prisma.auditEvent.deleteMany({ where: { tenantId } })
    const plans = await prisma.ratePlan.findMany({ where: { tenantId }, select: { id: true } })
    const planIds = plans.map((plan) => plan.id)
    await prisma.dailyRate.deleteMany({ where: { ratePlanId: { in: planIds } } })
    await prisma.dailyAvailability.deleteMany({ where: { ratePlanId: { in: planIds } } })
    await prisma.ratePlan.deleteMany({ where: { id: { in: planIds } } })
    await prisma.contract.deleteMany({ where: { tenantId } })
    await prisma.supplierRoomMapping.deleteMany({ where: { tenantId } })
    await prisma.supplierHotelMapping.deleteMany({ where: { tenantId } })
    if (boardId) await prisma.boardBasis.deleteMany({ where: { id: boardId } })
    const hotels = await prisma.hotel.findMany({ where: { tenantId, externalRef: { startsWith: `${suffix}-hotel-` } }, select: { id: true } })
    await prisma.roomType.deleteMany({ where: { hotelId: { in: hotels.map((hotel) => hotel.id) } } })
    await prisma.hotel.deleteMany({ where: { id: { in: hotels.map((hotel) => hotel.id) } } })
    if (supplierId) await prisma.supplier.deleteMany({ where: { id: supplierId } })
    if (userId) await prisma.userRole.deleteMany({ where: { userId } })
    if (roleId) await prisma.rolePermission.deleteMany({ where: { roleId } })
    if (roleId) await prisma.role.deleteMany({ where: { id: roleId } })
    if (userId) await prisma.membership.deleteMany({ where: { userId } })
    if (userId) await prisma.session.deleteMany({ where: { userId } })
    if (userId) await prisma.user.deleteMany({ where: { id: userId } })
    await prisma.tenant.deleteMany({ where: { id: tenantId } })
    if (otherTenantId) await prisma.tenant.deleteMany({ where: { id: otherTenantId } })
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
      patch: (path: string) => configure(request(app.getHttpServer()).patch(path)),
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
    const rates = await agent.get(`/api/v1/supply/daily-rates?${windowQuery}`).expect(200)
    metric('seven_day_rate_read', ms(started))
    expect(rates.body.data.filter((row: { ratePlanId: string }) => scalePlans.some((plan: { id: string }) => plan.id === row.ratePlanId))).toHaveLength(hotelCount * 7)

    started = process.hrtime.bigint()
    const availability = await agent.get(`/api/v1/supply/availability?${windowQuery}`).expect(200)
    metric('seven_day_availability_read', ms(started))
    expect(availability.body.data.filter((row: { ratePlanId: string }) => scalePlans.some((plan: { id: string }) => plan.id === row.ratePlanId))).toHaveLength(hotelCount * 7)

    for (const stayDate of dateKeys) {
      started = process.hrtime.bigint()
      const results = await matrix(agent, stayDate)
      metric('sellability_100_hotels_one_night', ms(started))
      expect(results).toHaveLength(100)
      expect(results.filter(row => row.eligible)).toHaveLength(100)
    }
  }, 180000)

  async function matrix(agent: ReturnType<typeof supply>, stayDate: string) {
    const rows: Array<{ eligible: boolean; reasons: string[] }> = []
    for (let offset = 0; offset < planIds.length; offset += 10) {
      rows.push(...await Promise.all(planIds.slice(offset, offset + 10).map(async ratePlanId => {
        const response = await agent.post('/api/v1/supply/sellability').send({ ratePlanId, stayDate, occupancy: 2 }).expect(201)
        return response.body.data
      })))
    }
    return rows
  }

  it('excludes exactly ten stop-sell hotels on the middle day and restores all 100 through HTTP', async () => {
    const agent = supply(cookie)
    const rows = planIds.slice(0, 10).map(ratePlanId => ({ ratePlanId, stayDate: dateKeys[3], allotment: 5, stopSell: true, minStay: 1 }))
    try {
      await agent.post('/api/v1/supply/availability/bulk').send({ rows }).expect(201)
      const closed = await matrix(agent, dateKeys[3])
      expect(closed.filter(row => row.eligible)).toHaveLength(90)
      expect(closed.slice(0, 10).every(row => row.reasons.includes('STOP_SELL'))).toBe(true)
      expect((await matrix(agent, dateKeys[2])).filter(row => row.eligible)).toHaveLength(100)
    } finally {
      await agent.post('/api/v1/supply/availability/bulk').send({ rows: rows.map(row => ({ ...row, stopSell: false })) }).expect(201)
    }
    expect((await matrix(agent, dateKeys[3])).filter(row => row.eligible)).toHaveLength(100)
  }, 90000)

  it('rejects an inactive supplier for all 100 hotels and immediately reflects reopening', async () => {
    const agent = supply(cookie)
    try {
      await agent.patch(`/api/v1/supply/suppliers/${supplierId}`).send({ status: 'SUSPENDED' }).expect(200)
      const rows = await matrix(agent, dateKeys[0])
      expect(rows.filter(row => row.eligible)).toHaveLength(0)
      expect(rows.every(row => row.reasons.includes('SUPPLIER_INACTIVE'))).toBe(true)
    } finally {
      await agent.patch(`/api/v1/supply/suppliers/${supplierId}`).send({ status: 'ACTIVE' }).expect(200)
    }
    expect((await matrix(agent, dateKeys[0])).filter(row => row.eligible)).toHaveLength(100)
  }, 90000)

  it('fails closed for legacy basis, currency mismatch, missing nights and fully committed inventory', async () => {
    const agent = supply(cookie)
    const ratePlanId = planIds[0], stayDate = dates[3]
    const rate = await prisma.dailyRate.findFirstOrThrow({ where: { ratePlanId, stayDate } })
    const availability = await prisma.dailyAvailability.findFirstOrThrow({ where: { ratePlanId, stayDate } })
    const rateData = { ...rate, taxMetadata: rate.taxMetadata === null ? Prisma.JsonNull : rate.taxMetadata, feeMetadata: rate.feeMetadata === null ? Prisma.JsonNull : rate.feeMetadata }
    async function reason(expected: string) {
      const response = await agent.post('/api/v1/supply/sellability').send({ ratePlanId, stayDate: dateKeys[3], occupancy: 2 }).expect(201)
      expect(response.body.data.eligible).toBe(false)
      expect(response.body.data.reasons).toContain(expected)
    }
    try {
      await prisma.dailyRate.update({ where: { id: rate.id }, data: { amountBasis: null } })
      await reason('RATE_AMOUNT_BASIS_UNVERIFIED')
      await prisma.dailyRate.update({ where: { id: rate.id }, data: { amountBasis: 'SELL', currency: 'USD' } })
      await reason('RATE_CURRENCY_MISMATCH')
      await prisma.dailyRate.delete({ where: { id: rate.id } })
      await reason('DAILY_RATE_MISSING_OR_INVALID')
      await prisma.dailyRate.create({ data: rateData })
      await prisma.dailyAvailability.delete({ where: { id: availability.id } })
      await reason('AVAILABILITY_MISSING')
      await prisma.dailyAvailability.create({ data: { ...availability, sold: 2, held: 3 } })
      await reason('NO_INVENTORY')
      await agent.post('/api/v1/supply/availability').send({ ratePlanId, stayDate: dateKeys[3], allotment: 4 }).expect(400)
      await agent.post('/api/v1/supply/availability').send({ ratePlanId, stayDate: dateKeys[3], allotment: 6, sold: 0 }).expect(201)
      const preserved = await prisma.dailyAvailability.findUniqueOrThrow({ where: { id: availability.id } })
      expect([preserved.sold, preserved.held]).toEqual([2, 3])
    } finally {
      await prisma.dailyRate.upsert({ where: { id: rate.id }, create: rateData, update: rateData })
      await prisma.dailyAvailability.upsert({ where: { id: availability.id }, create: availability, update: availability })
    }
  })

  it('enforces tenant, mapping and inclusive contract boundaries without disclosing other inventory', async () => {
    const agent = supply(cookie), ratePlanId = planIds[0]
    await request(app.getHttpServer()).post('/api/v1/supply/sellability').send({ ratePlanId, stayDate: dateKeys[0], occupancy: 2 }).expect(401)
    await request(app.getHttpServer()).get('/api/v1/supply/hotels').set('Cookie', cookie).set('x-fbeds-tenant-id', otherTenantId).expect(403)
    const foreign = await prisma.hotel.create({ data: { tenantId: otherTenantId, name: `${suffix} Foreign`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE' } })
    try {
      await agent.get(`/api/v1/supply/hotels/${foreign.id}`).expect(404)
      const list = await agent.get('/api/v1/supply/hotels').expect(200)
      expect(list.body.data.map((row: { id: string }) => row.id)).not.toContain(foreign.id)
    } finally { await prisma.hotel.delete({ where: { id: foreign.id } }) }
    const plan = await prisma.ratePlan.findUniqueOrThrow({ where: { id: ratePlanId }, include: { contract: true } })
    const mappingPath = `/api/v1/supply/mappings/hotels/${plan.contract.supplierHotelMappingId}`
    const roomMapping = await prisma.supplierRoomMapping.findFirstOrThrow({ where: { supplierHotelMappingId: plan.contract.supplierHotelMappingId!, roomTypeId: plan.roomTypeId } })
    const roomMappingPath = `${mappingPath}/rooms/${roomMapping.id}`
    await agent.post(`${mappingPath}/reopen`).expect(400)
    await agent.post(`${roomMappingPath}/reopen`).expect(201)
    let hotelReopened = false
    try {
      await agent.post(`${mappingPath}/reopen`).expect(201)
      hotelReopened = true
      const result = await agent.post('/api/v1/supply/sellability').send({ ratePlanId, stayDate: dateKeys[0], occupancy: 2 }).expect(201)
      expect(result.body.data.reasons).toContain('SUPPLIER_MAPPING_INVALID')
    } finally {
      if (hotelReopened) await agent.post(`${mappingPath}/approve`).expect(201)
      await agent.post(`${roomMappingPath}/approve`).expect(201)
    }
    for (const stayDate of [dateKeys[0], dateKeys[6]]) {
      const response = await agent.post('/api/v1/supply/sellability').send({ ratePlanId, stayDate, occupancy: 2 }).expect(201)
      expect(response.body.data.eligible).toBe(true)
    }
    for (const offset of [-1, 7]) {
      const stayDate = new Date(start.getTime() + offset * 86400000).toISOString().slice(0, 10)
      const response = await agent.post('/api/v1/supply/sellability').send({ ratePlanId, stayDate, occupancy: 2 }).expect(201)
      expect(response.body.data.reasons).toContain('OUTSIDE_CONTRACT_VALIDITY')
    }
    const occupancy = await agent.post('/api/v1/supply/sellability').send({ ratePlanId, stayDate: dateKeys[0], occupancy: 4 }).expect(201)
    expect(occupancy.body.data.reasons).toContain('OCCUPANCY_UNSUPPORTED')
  })

  it('certifies D0 through D+6 SEARCH -> OFFER -> REVALIDATE across the approved disposable fixture', async () => {
    const cookie = await login()
    const agent = api(cookie)
    let searches = 0
    let offers = 0
    let revalidated = 0
    let rejected = 0
    let priceChanged = 0
    let unavailable = 0

    for (let offset = 0; offset < dates.length; offset += 1) {
      const checkIn = day(dates[offset])
      const checkOut = plusOne(checkIn)
      const response = await agent.post('/api/v1/agent/search').send({
        destination: 'Dubai', checkIn, checkOut, rooms: 1, adults: 2, children: 0, childAges: [],
        nationality: 'AE', currency: 'AED', limit: 100,
      }).expect(201)
      searches += 1
      expect(response.body.data.status).toBe('available')
      expect(response.body.data.hotels).toHaveLength(hotelCount)
      const dayOffers = response.body.data.hotels.flatMap((hotel: { rooms: Array<{ rates: unknown[] }> }) =>
        hotel.rooms.flatMap((room) => room.rates)) as Array<{ offerId: string; sellAmountMinor: number; total: { currency: string } }>
      expect(dayOffers).toHaveLength(hotelCount)
      offers += dayOffers.length

      for (const offer of dayOffers) {
        const recheck = await agent.post('/api/v1/agent/rates/recheck').send({
          offerId: offer.offerId, searchId: response.body.data.searchId,
          expectedCurrency: offer.total.currency, expectedSellAmountMinor: offer.sellAmountMinor,
        })
        const status = recheck.body.data?.status
        if (status === 'rechecked') revalidated += 1
        else if (status === 'price_changed') priceChanged += 1
        else if (status === 'unavailable') unavailable += 1
        else rejected += 1
        expect(recheck.status).toBe(200)
        expect(status).toBe('rechecked')
      }
      count(`d${offset}_offers`, dayOffers.length)
      count(`d${offset}_revalidated`, revalidated - (offset * hotelCount))
    }

    count('searches', searches)
    count('offers', offers)
    count('revalidated', revalidated)
    count('rejected', rejected)
    count('price_changed', priceChanged)
    count('unavailable', unavailable)
    expect(searches).toBe(7)
    expect(offers).toBe(700)
    expect(revalidated).toBe(700)
    expect(rejected).toBe(0)
    expect(priceChanged).toBe(0)
    expect(unavailable).toBe(0)
  }, 120000)
})
