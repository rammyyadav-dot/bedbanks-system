import { INestApplication, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import * as cookieParser from 'cookie-parser'
import * as request from 'supertest'
import { PrismaClient } from '@prisma/client'
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
  const dates = Array.from({ length: 7 }, (_, offset) => new Date(Date.UTC(2026, 10, 20 + offset)))
  let app: INestApplication
  let tenantId: string
  let userId: string
  let roleId: string
  let supplierId: string
  let boardId: string
  const contractIds: string[] = []
  const hotelMappingIds: string[] = []
  const roomMappingIds: string[] = []
  const offerAuthority = new Map<string, {
    supplierHotelId: string; supplierRoomId: string; canonicalHotelId: string; canonicalRoomTypeId: string
    ratePlanId: string; boardBasisId: string; checkIn: string; checkOut: string; sellAmountMinor: number
  }>()
  let canonicalOffers: SearchHotelOffer[] = []

  const ms = (started: bigint) => Number(process.hrtime.bigint() - started) / 1_000_000
  const metric = (name: string, value: number) => {
    console.info(`DUBAI_SCALE_METRIC ${name}=${value.toFixed(2)}ms`)
  }
  const count = (name: string, value: number) => console.info(`DUBAI_ACCEPTANCE_COUNT ${name}=${value}`)
  const day = (value: Date) => value.toISOString().slice(0, 10)
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
      'supply.contracts.read', 'supply.availability.read', 'hotel.search',
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

    await prisma.hotel.createMany({
      data: Array.from({ length: hotelCount }, (_, index) => ({
        tenantId, name: `Dubai Scale Hotel ${String(index + 1).padStart(3, '0')}`, propertyType: 'HOTEL',
        city: 'Dubai', countryCode: 'AE', contentStatus: 'COMPLETE', externalRef: `${suffix}-hotel-${index + 1}`,
      })),
    })
    const hotels = await prisma.hotel.findMany({ where: { tenantId, externalRef: { startsWith: `${suffix}-hotel-` } }, orderBy: { name: 'asc' } })
    await prisma.roomType.createMany({
      data: hotels.map((hotel, index) => ({
        hotelId: hotel.id, name: 'Deluxe Room', code: `${suffix}-DLX-${index + 1}`, maxAdults: 2, maxChildren: 1, maxOccupancy: 3,
      })),
    })
    const rooms = await prisma.roomType.findMany({ where: { hotelId: { in: hotels.map((hotel) => hotel.id) } }, orderBy: { code: 'asc' } })
    const roomByHotel = new Map(rooms.map((room) => [room.hotelId, room]))

    for (let index = 0; index < hotels.length; index += 1) {
      const hotel = hotels[index]
      const room = roomByHotel.get(hotel.id)
      if (!room) throw new Error('Dubai fixture room missing')
      const supplierHotelId = `${suffix}-supplier-hotel-${index + 1}`
      const supplierRoomId = `${suffix}-supplier-room-${index + 1}`
      const hotelMapping = await prisma.supplierHotelMapping.create({
        data: { tenantId, supplierId, hotelId: hotel.id, supplierHotelId, status: 'MAPPED' },
      })
      hotelMappingIds.push(hotelMapping.id)
      const roomMapping = await prisma.supplierRoomMapping.create({
        data: { tenantId, supplierHotelMappingId: hotelMapping.id, hotelId: hotel.id, supplierRoomId, roomTypeId: room.id, status: 'MAPPED' },
      })
      roomMappingIds.push(roomMapping.id)
      const contract = await prisma.contract.create({
        data: { tenantId, supplierId, supplierHotelMappingId: hotelMapping.id, code: `${suffix}-contract-${index + 1}`,
          status: 'ACTIVE', validFrom: new Date('2026-01-01T00:00:00.000Z'), validTo: new Date('2027-12-31T00:00:00.000Z'), settlementCurrency: 'AED' },
      })
      contractIds.push(contract.id)
      const plan = await prisma.ratePlan.create({
        data: { tenantId, contractId: contract.id, roomTypeId: room.id, boardBasisId: boardId, code: `${suffix}-FLEX-${index + 1}`,
          status: 'ACTIVE', refundable: true, occupancy: 2, currency: 'AED', minStay: 1, releaseDays: 0 },
      })
      canonicalOffers.push({
        hotelId: hotel.id, name: hotel.name, destination: 'Dubai', starRating: 5, supplierId, supplierHotelId,
        rooms: [{ roomTypeId: room.id, name: room.name, supplierRoomId, rates: [{
          offerId: `${hotel.id}:seed`, tenantId, providerId: 'dubai-disposable-fixture',
          hotelId: hotel.id, canonicalHotelId: hotel.id, roomTypeId: room.id, canonicalRoomTypeId: room.id,
          supplierId, supplierRoomId, ratePlanId: plan.id, ratePlanName: plan.code, boardBasisId: boardId,
          boardBasisName: 'Bed & Breakfast', supplierRateId: `${suffix}-rate-${index + 1}`,
          expiresAt: new Date(Date.now() + 300_000).toISOString(), occupancy: { rooms: 1, adults: 2, children: 0, childAges: [] },
          availability: 'available', available: true, cancellation: { refundable: true, summary: 'Refundable fixture rate' },
          total: { amountMinor: 29900, currency: 'AED' }, netAmountMinor: 29900, taxAmountMinor: 0, feeAmountMinor: 0,
          totalAmountMinor: 29900, markupAmountMinor: 0, sellAmountMinor: 29900, paymentType: 'credit', source: 'hotel_direct',
        }] }],
      })
    }

    const plans = await prisma.ratePlan.findMany({ where: { tenantId, contractId: { in: contractIds } } })
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
  }, 60000)

  afterAll(async () => {
    await app?.close()
    await prisma.auditEvent.deleteMany({ where: { tenantId } })
    const plans = await prisma.ratePlan.findMany({ where: { tenantId, contractId: { in: contractIds } }, select: { id: true } })
    const planIds = plans.map((plan) => plan.id)
    await prisma.dailyRate.deleteMany({ where: { ratePlanId: { in: planIds } } })
    await prisma.dailyAvailability.deleteMany({ where: { ratePlanId: { in: planIds } } })
    await prisma.ratePlan.deleteMany({ where: { id: { in: planIds } } })
    await prisma.contract.deleteMany({ where: { id: { in: contractIds } } })
    await prisma.supplierRoomMapping.deleteMany({ where: { id: { in: roomMappingIds } } })
    await prisma.supplierHotelMapping.deleteMany({ where: { id: { in: hotelMappingIds } } })
    await prisma.boardBasis.deleteMany({ where: { id: boardId } })
    const hotels = await prisma.hotel.findMany({ where: { tenantId, externalRef: { startsWith: `${suffix}-hotel-` } }, select: { id: true } })
    await prisma.roomType.deleteMany({ where: { hotelId: { in: hotels.map((hotel) => hotel.id) } } })
    await prisma.hotel.deleteMany({ where: { id: { in: hotels.map((hotel) => hotel.id) } })
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

  function api(cookie: string) {
    const configure = (test: request.Test) => test.set('Cookie', cookie).set('x-fbeds-tenant-id', tenantId)
    return {
      get: (path: string) => configure(request(app.getHttpServer()).get(path)),
      post: (path: string) => configure(request(app.getHttpServer()).post(path)),
    }
  }

  it('measures real API reads and sellability across 100 disposable Dubai hotels', async () => {
    const cookie = await login()
    const agent = api(cookie)

    let started = process.hrtime.bigint()
    const hotels = await agent.get('/api/v1/supply/hotels').expect(200)
    metric('hotel_listing', ms(started))
    const scaleHotels = hotels.body.data.filter((hotel: { externalRef?: string }) => hotel.externalRef?.startsWith(`${suffix}-hotel-`))
    expect(scaleHotels).toHaveLength(hotelCount)
    count('hotels', scaleHotels.length)

    started = process.hrtime.bigint()
    const roomResponses = []
    for (const hotel of scaleHotels) roomResponses.push(await agent.get(`/api/v1/supply/hotels/${hotel.id}/rooms`).expect(200))
    metric('room_listing_100_hotels', ms(started))
    const roomCount = roomResponses.reduce((total, response) => total + response.body.data.length, 0)
    expect(roomCount).toBe(hotelCount)
    count('rooms', roomCount)

    started = process.hrtime.bigint()
    const plans = await agent.get('/api/v1/supply/rate-plans').expect(200)
    metric('rate_plan_listing', ms(started))
    const scalePlans = plans.body.data.filter((plan: { code: string }) => plan.code.startsWith(`${suffix}-FLEX-`))
    expect(scalePlans).toHaveLength(hotelCount)

    started = process.hrtime.bigint()
    const rates = await agent.get('/api/v1/supply/daily-rates?from=2026-11-20&to=2026-11-26').expect(200)
    metric('seven_day_rate_read', ms(started))
    const scaleRates = rates.body.data.filter((row: { ratePlanId: string }) => scalePlans.some((plan: { id: string }) => plan.id === row.ratePlanId))
    expect(scaleRates).toHaveLength(hotelCount * 7)
    count('daily_rates', scaleRates.length)

    started = process.hrtime.bigint()
    const availability = await agent.get('/api/v1/supply/availability?from=2026-11-20&to=2026-11-26').expect(200)
    metric('seven_day_availability_read', ms(started))
    const scaleAvailability = availability.body.data.filter((row: { ratePlanId: string }) => scalePlans.some((plan: { id: string }) => plan.id === row.ratePlanId))
    expect(scaleAvailability).toHaveLength(hotelCount * 7)
    count('availability_rows', scaleAvailability.length)

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
    count('sellable_d0', sellability.filter((row) => row.eligible).length)
  }, 60000)

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
        expect(recheck.status).toBe(201)
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
