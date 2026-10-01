import { mkdirSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
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
jest.setTimeout(180000)

const HOTEL_COUNT = 100
const PLANS_PER_HOTEL = 3

describe('Authoritative Dubai 100-hotel agent search', () => {
  const suffix = `dubai-100-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const password = 'dubai-hundred-hotel-certification-password'
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
  const utc = (iso: string) => new Date(`${iso}T00:00:00.000Z`)
  const checkIn = day(14)
  const checkOut = day(17)
  const nights = [day(14), day(15), day(16)]
  const hotels = Array.from({ length: HOTEL_COUNT }, (_, index) => {
    const nightMinor = 20_000 + index * 100
    return {
      index,
      name: `${suffix} ${String(index).padStart(3, '0')} Dubai`,
      hotelId: randomUUID(),
      roomId: randomUUID(),
      mappingId: randomUUID(),
      roomMappingId: randomUUID(),
      contractId: randomUUID(),
      sellPlanId: randomUUID(),
      minPlanId: randomUUID(),
      stopPlanId: randomUUID(),
      nightMinor,
      totalMinor: nightMinor * nights.length,
    }
  })
  let app: INestApplication
  let tenantId = ''
  let otherTenantId = ''
  let emptyTenantId = ''
  let supplierId = ''
  let boardId = ''
  let ownerId = ''
  let agentId = ''
  let deniedId = ''
  let otherUserId = ''
  let emptyUserId = ''
  const roleIds: string[] = []
  const userIds: string[] = []
  let agentCookie = ''
  let ownerCookie = ''
  let deniedCookie = ''
  let otherCookie = ''
  let emptyCookie = ''

  const searchBody = (patch: Record<string, unknown> = {}) => ({
    destination: 'Dubai', checkIn, checkOut, rooms: 1, adults: 2, children: 0, childAges: [],
    nationality: 'IN', currency: 'AED', limit: 100, ...patch,
  })

  beforeAll(async () => {
    await prisma.$connect()
    const [tenant, other, empty] = await Promise.all([
      prisma.tenant.create({ data: { name: `${suffix} Agency`, slug: `${suffix}-a` } }),
      prisma.tenant.create({ data: { name: `${suffix} Other`, slug: `${suffix}-b` } }),
      prisma.tenant.create({ data: { name: `${suffix} Empty`, slug: `${suffix}-c` } }),
    ])
    tenantId = tenant.id
    otherTenantId = other.id
    emptyTenantId = empty.id
    const passwordHash = await hashPassword(password)
    const users = await Promise.all([
      prisma.user.create({ data: { email: `${suffix}-owner@example.test`, passwordHash } }),
      prisma.user.create({ data: { email: `${suffix}-agent@example.test`, passwordHash } }),
      prisma.user.create({ data: { email: `${suffix}-denied@example.test`, passwordHash } }),
      prisma.user.create({ data: { email: `${suffix}-other@example.test`, passwordHash } }),
      prisma.user.create({ data: { email: `${suffix}-empty@example.test`, passwordHash } }),
    ])
    ;[ownerId, agentId, deniedId, otherUserId, emptyUserId] = users.map((user) => user.id)
    userIds.push(...users.map((user) => user.id))
    const permissionKeys = ['hotel.search', 'booking.prebook', 'booking.create']
    const permissions = await Promise.all(permissionKeys.map((key) => prisma.permission.upsert({ where: { key }, update: {}, create: { key, description: `${suffix} ${key}` } })))
    const byKey = new Map(permissions.map((permission) => [permission.key, permission.id]))
    const ownerRole = await prisma.role.create({ data: { tenantId, name: `${suffix}-owner` } })
    const agentRole = await prisma.role.create({ data: { tenantId, name: `${suffix}-agent` } })
    const deniedRole = await prisma.role.create({ data: { tenantId, name: `${suffix}-denied` } })
    const otherRole = await prisma.role.create({ data: { tenantId: otherTenantId, name: `${suffix}-other` } })
    const emptyRole = await prisma.role.create({ data: { tenantId: emptyTenantId, name: `${suffix}-empty` } })
    roleIds.push(ownerRole.id, agentRole.id, deniedRole.id, otherRole.id, emptyRole.id)
    await prisma.rolePermission.createMany({ data: permissionKeys.map((key) => ({ roleId: ownerRole.id, permissionId: byKey.get(key)! })) })
    await prisma.rolePermission.createMany({ data: ['hotel.search', 'booking.prebook'].map((key) => ({ roleId: agentRole.id, permissionId: byKey.get(key)! })) })
    await prisma.rolePermission.create({ data: { roleId: otherRole.id, permissionId: byKey.get('hotel.search')! } })
    await prisma.rolePermission.create({ data: { roleId: emptyRole.id, permissionId: byKey.get('hotel.search')! } })
    await prisma.membership.createMany({ data: [
      { tenantId, userId: ownerId, role: 'owner' },
      { tenantId, userId: agentId, role: 'agent' },
      { tenantId, userId: deniedId, role: 'staff' },
      { tenantId: otherTenantId, userId: otherUserId, role: 'agent' },
      { tenantId: emptyTenantId, userId: emptyUserId, role: 'agent' },
    ] })
    await prisma.userRole.createMany({ data: [
      { tenantId, userId: ownerId, roleId: ownerRole.id },
      { tenantId, userId: agentId, roleId: agentRole.id },
      { tenantId, userId: deniedId, roleId: deniedRole.id },
      { tenantId: otherTenantId, userId: otherUserId, roleId: otherRole.id },
      { tenantId: emptyTenantId, userId: emptyUserId, roleId: emptyRole.id },
    ] })
    await seedInventory()
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = module.createNestApplication()
    app.use(cookieParser())
    app.setGlobalPrefix('api/v1')
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
    app.useGlobalFilters(new HttpExceptionFilter())
    app.useGlobalInterceptors(new ResponseInterceptor())
    await app.init()
    ownerCookie = await login(`${suffix}-owner@example.test`)
    agentCookie = await login(`${suffix}-agent@example.test`)
    deniedCookie = await login(`${suffix}-denied@example.test`)
    otherCookie = await login(`${suffix}-other@example.test`)
    emptyCookie = await login(`${suffix}-empty@example.test`)
  }, 180000)

  afterAll(async () => {
    await app?.close()
    const tenantIds = [tenantId, otherTenantId, emptyTenantId].filter(Boolean)
    if (tenantIds.length) {
      await prisma.auditEvent.deleteMany({ where: { tenantId: { in: tenantIds } } })
      await prisma.dailyRate.deleteMany({ where: { tenantId: { in: tenantIds } } })
      await prisma.dailyAvailability.deleteMany({ where: { tenantId: { in: tenantIds } } })
      await prisma.ratePlan.deleteMany({ where: { tenantId: { in: tenantIds } } })
      await prisma.contract.deleteMany({ where: { tenantId: { in: tenantIds } } })
      await prisma.supplierRoomMapping.deleteMany({ where: { tenantId: { in: tenantIds } } })
      await prisma.supplierHotelMapping.deleteMany({ where: { tenantId: { in: tenantIds } } })
      await prisma.boardBasis.deleteMany({ where: { tenantId: { in: tenantIds } } })
      await prisma.roomType.deleteMany({ where: { hotel: { tenantId: { in: tenantIds } } } })
      await prisma.hotel.deleteMany({ where: { tenantId: { in: tenantIds } } })
      await prisma.supplier.deleteMany({ where: { tenantId: { in: tenantIds } } })
    }
    if (userIds.length) {
      await prisma.userRole.deleteMany({ where: { userId: { in: userIds } } })
      await prisma.membership.deleteMany({ where: { userId: { in: userIds } } })
      await prisma.session.deleteMany({ where: { userId: { in: userIds } } })
      await prisma.user.deleteMany({ where: { id: { in: userIds } } })
    }
    if (roleIds.length) {
      await prisma.rolePermission.deleteMany({ where: { roleId: { in: roleIds } } })
      await prisma.role.deleteMany({ where: { id: { in: roleIds } } })
    }
    if (tenantIds.length) await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } })
    await prisma.$disconnect()
  }, 180000)

  async function seedInventory() {
    const supplier = await prisma.supplier.create({ data: {
      tenantId, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${suffix} Supplier`, displayName: 'Dubai Hundred Supply',
      countryCode: 'AE', defaultCurrency: 'AED',
    } })
    supplierId = supplier.id
    const board = await prisma.boardBasis.create({ data: { tenantId, code: 'BB', name: 'Bed & Breakfast', isActive: true } })
    boardId = board.id
    const otherSupplier = await prisma.supplier.create({ data: {
      tenantId: otherTenantId, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${suffix} Other Supplier`, displayName: 'Other Hundred Supply',
      countryCode: 'AE', defaultCurrency: 'AED',
    } })
    const otherBoard = await prisma.boardBasis.create({ data: { tenantId: otherTenantId, code: 'BB', name: 'Bed & Breakfast', isActive: true } })
    const otherHotelId = randomUUID()
    const otherRoomId = randomUUID()
    const otherMappingId = randomUUID()
    const otherContractId = randomUUID()
    const otherPlanId = randomUUID()
    await prisma.hotel.createMany({ data: [
      ...hotels.map((hotel) => ({
        id: hotel.hotelId, tenantId, name: hotel.name, propertyType: 'HOTEL', starRating: 4, city: 'Dubai', countryCode: 'AE', contentStatus: 'COMPLETE' as const,
      })),
      { id: otherHotelId, tenantId: otherTenantId, name: `${suffix} ZZZ Other Tenant`, propertyType: 'HOTEL', starRating: 4, city: 'Dubai', countryCode: 'AE', contentStatus: 'COMPLETE' as const },
    ] })
    await prisma.roomType.createMany({ data: [
      ...hotels.map((hotel) => ({ id: hotel.roomId, hotelId: hotel.hotelId, name: 'King Room', code: 'KG', maxAdults: 2, maxChildren: 0, maxOccupancy: 2, isActive: true })),
      { id: otherRoomId, hotelId: otherHotelId, name: 'Other Room', code: 'OR', maxAdults: 2, maxChildren: 0, maxOccupancy: 2, isActive: true },
    ] })
    await prisma.supplierHotelMapping.createMany({ data: [
      ...hotels.map((hotel) => ({
        id: hotel.mappingId, tenantId, supplierId, hotelId: hotel.hotelId, supplierHotelId: `${suffix}-${hotel.index}`, status: 'MAPPED' as const,
      })),
      { id: otherMappingId, tenantId: otherTenantId, supplierId: otherSupplier.id, hotelId: otherHotelId, supplierHotelId: `${suffix}-other`, status: 'MAPPED' as const },
    ] })
    await prisma.supplierRoomMapping.createMany({ data: [
      ...hotels.map((hotel) => ({
        id: hotel.roomMappingId, tenantId, supplierHotelMappingId: hotel.mappingId, hotelId: hotel.hotelId, supplierRoomId: `${suffix}-room-${hotel.index}`, roomTypeId: hotel.roomId, status: 'MAPPED' as const,
      })),
      { id: randomUUID(), tenantId: otherTenantId, supplierHotelMappingId: otherMappingId, hotelId: otherHotelId, supplierRoomId: `${suffix}-other-room`, roomTypeId: otherRoomId, status: 'MAPPED' as const },
    ] })
    await prisma.contract.createMany({ data: [
      ...hotels.map((hotel) => ({
        id: hotel.contractId, tenantId, supplierId, supplierHotelMappingId: hotel.mappingId, code: `${suffix}-C-${hotel.index}`, status: 'ACTIVE' as const,
        validFrom: utc(day(0)), validTo: utc(day(60)), settlementCurrency: 'AED',
      })),
      {
        id: otherContractId, tenantId: otherTenantId, supplierId: otherSupplier.id, supplierHotelMappingId: otherMappingId, code: `${suffix}-other-C`, status: 'ACTIVE' as const,
        validFrom: utc(day(0)), validTo: utc(day(60)), settlementCurrency: 'AED',
      },
    ] })
    await prisma.ratePlan.createMany({ data: [
      ...hotels.flatMap((hotel) => [
        plan(hotel.sellPlanId, hotel, 'FLEX', 1),
        plan(hotel.minPlanId, hotel, 'MIN', 5),
        plan(hotel.stopPlanId, hotel, 'STOP', 1),
      ]),
      {
        id: otherPlanId, tenantId: otherTenantId, contractId: otherContractId, roomTypeId: otherRoomId, boardBasisId: otherBoard.id,
        code: `${suffix}-other-FLEX`, status: 'ACTIVE' as const, occupancy: 2, currency: 'AED', refundable: true, minStay: 1, releaseDays: 0,
      },
    ] })
    const rateRows = hotels.flatMap((hotel) => nights.flatMap((stayDate) => [
      rate(hotel.sellPlanId, stayDate, hotel.nightMinor),
      rate(hotel.minPlanId, stayDate, hotel.nightMinor + 1),
      rate(hotel.stopPlanId, stayDate, hotel.nightMinor + 2),
    ]))
    rateRows.push(...nights.map((stayDate) => ({
      tenantId: otherTenantId, ratePlanId: otherPlanId, stayDate: utc(stayDate), occupancy: 2, amountMinor: 19_900n, amountBasis: 'SELL' as const, currency: 'AED',
    })))
    const availabilityRows = hotels.flatMap((hotel) => nights.flatMap((stayDate) => [
      availability(hotel.sellPlanId, stayDate, false),
      availability(hotel.minPlanId, stayDate, false),
      availability(hotel.stopPlanId, stayDate, true),
    ]))
    availabilityRows.push(...nights.map((stayDate) => ({
      tenantId: otherTenantId, ratePlanId: otherPlanId, stayDate: utc(stayDate), allotment: 4, sold: 0, held: 0, stopSell: false, minStay: 1,
    })))
    for (let offset = 0; offset < rateRows.length; offset += 250) await prisma.dailyRate.createMany({ data: rateRows.slice(offset, offset + 250) })
    for (let offset = 0; offset < availabilityRows.length; offset += 250) await prisma.dailyAvailability.createMany({ data: availabilityRows.slice(offset, offset + 250) })
  }

  function plan(id: string, hotel: typeof hotels[number], code: string, minStay: number) {
    return {
      id, tenantId, contractId: hotel.contractId, roomTypeId: hotel.roomId, boardBasisId: boardId, code: `${suffix}-${hotel.index}-${code}`,
      status: 'ACTIVE' as const, occupancy: 2, currency: 'AED', refundable: true, minStay, releaseDays: 0,
    }
  }

  function rate(ratePlanId: string, stayDate: string, amountMinor: number) {
    return { tenantId, ratePlanId, stayDate: utc(stayDate), occupancy: 2, amountMinor: BigInt(amountMinor), amountBasis: 'SELL' as const, currency: 'AED' }
  }

  function availability(ratePlanId: string, stayDate: string, stopSell: boolean) {
    return { tenantId, ratePlanId, stayDate: utc(stayDate), allotment: 4, sold: 0, held: 0, stopSell, minStay: 1 }
  }

  async function login(email: string) {
    const response = await request(app.getHttpServer()).post('/api/v1/auth/login')
      .set('Origin', 'http://localhost:3001').send({ email, password }).expect(200)
    return response.headers['set-cookie'][0].split(';')[0]
  }

  function api(cookie: string, tenant = tenantId) {
    const configure = (test: request.Test) => test.set('Cookie', cookie).set('x-fbeds-tenant-id', tenant)
    return { post: (path: string) => configure(request(app.getHttpServer()).post(path)) }
  }

  function search(cookie = agentCookie, patch: Record<string, unknown> = {}, tenant = tenantId) {
    return api(cookie, tenant).post('/api/v1/agent/search').send(searchBody(patch))
  }

  function commercialSignature(rows: Array<{ hotelId: string; name: string; supplierId: string; rooms: Array<{ roomTypeId: string; rates: Array<{ ratePlanId: string; contractId?: string; boardBasisId: string; sellAmountMinor: number; total: { currency: string } }> }> }>) {
    return rows.map((hotel) => ({
      hotelId: hotel.hotelId,
      name: hotel.name,
      supplierId: hotel.supplierId,
      rooms: hotel.rooms.map((room) => ({
        roomTypeId: room.roomTypeId,
        rates: room.rates.map((rate) => ({
          ratePlanId: rate.ratePlanId, contractId: rate.contractId, boardBasisId: rate.boardBasisId, sellAmountMinor: rate.sellAmountMinor, currency: rate.total.currency,
        })),
      })),
    }))
  }

  it('returns every sellable hotel when more than 200 rate plans match', async () => {
    const activePlans = await prisma.ratePlan.count({ where: { tenantId, status: 'ACTIVE' } })
    expect(activePlans).toBe(HOTEL_COUNT * PLANS_PER_HOTEL)
    const response = await search().expect(201)
    expect(response.body.data.status).toBe('available')
    const rows = response.body.data.hotels
    expect(rows).toHaveLength(HOTEL_COUNT)
    expect(rows.map((hotel: { name: string }) => hotel.name)).toEqual(hotels.map((hotel) => hotel.name))
    const offers = rows.flatMap((hotel: { rooms: Array<{ rates: Array<Record<string, unknown>> }> }) => hotel.rooms.flatMap((room) => room.rates))
    expect(offers).toHaveLength(HOTEL_COUNT)
    expect(new Set(offers.map((offer: { offerId: string }) => offer.offerId)).size).toBe(HOTEL_COUNT)
    expect(new Set(offers.map((offer: { ratePlanId: string }) => offer.ratePlanId)).size).toBe(HOTEL_COUNT)
    expect(offers.some((offer: { ratePlanId: string }) => hotels.some((hotel) => hotel.minPlanId === offer.ratePlanId || hotel.stopPlanId === offer.ratePlanId))).toBe(false)
    for (const sample of [hotels[0], hotels[24], hotels[25], hotels[99]]) {
      const hotel = rows.find((row: { hotelId: string }) => row.hotelId === sample.hotelId)
      const offer = hotel.rooms[0].rates[0]
      expect(hotel).toMatchObject({ name: sample.name, destination: 'Dubai', supplierId })
      expect(hotel.rooms[0]).toMatchObject({ roomTypeId: sample.roomId, name: 'King Room' })
      expect(offer).toMatchObject({
        tenantId, supplierId, hotelId: sample.hotelId, canonicalHotelId: sample.hotelId, roomTypeId: sample.roomId,
        boardBasisId: boardId, boardBasisName: 'Bed & Breakfast', ratePlanId: sample.sellPlanId, contractId: sample.contractId,
      })
      expect(offer.total).toEqual({ amountMinor: sample.totalMinor, currency: 'AED' })
      expect(offer.sellAmountMinor).toBe(sample.totalMinor)
      expect(Number.isSafeInteger(offer.sellAmountMinor)).toBe(true)
    }
  })

  it('repeats the same 100-hotel commercial result', async () => {
    const first = await search().expect(201)
    const signature = commercialSignature(first.body.data.hotels)
    const measured: number[] = []
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const started = process.hrtime.bigint()
      const again = await search().expect(201)
      measured.push(Number(process.hrtime.bigint() - started) / 1_000_000)
      expect(commercialSignature(again.body.data.hotels)).toEqual(signature)
    }
    mkdirSync('/opt/cursor/artifacts', { recursive: true })
    writeFileSync('/opt/cursor/artifacts/dubai-100-metrics.json', JSON.stringify({
      searchMs: measured, hotels: signature.length, offers: HOTEL_COUNT, activePlans: HOTEL_COUNT * PLANS_PER_HOTEL,
    }, null, 2))
  })

  it('rechecks the first, middle and last hotel without dropping the others', async () => {
    const found = await search().expect(201)
    const offerFor = (hotelId: string) => found.body.data.hotels.find((hotel: { hotelId: string }) => hotel.hotelId === hotelId).rooms[0].rates[0]
    const first = offerFor(hotels[0].hotelId)
    const middle = offerFor(hotels[50].hotelId)
    const last = offerFor(hotels[99].hotelId)
    const unchanged = await api(agentCookie).post('/api/v1/agent/rates/recheck').send({
      offerId: first.offerId, searchId: found.body.data.searchId, expectedCurrency: 'AED', expectedSellAmountMinor: first.sellAmountMinor,
    }).expect(200)
    expect(unchanged.body.data).toMatchObject({ offerId: first.offerId, status: 'rechecked', currency: 'AED', sellAmountMinor: hotels[0].totalMinor })

    await prisma.dailyRate.update({
      where: { ratePlanId_stayDate_occupancy: { ratePlanId: hotels[50].sellPlanId, stayDate: utc(nights[0]), occupancy: 2 } },
      data: { amountMinor: BigInt(hotels[50].nightMinor + 100) },
    })
    const changed = await api(agentCookie).post('/api/v1/agent/rates/recheck').send({
      offerId: middle.offerId, searchId: found.body.data.searchId, expectedCurrency: 'AED', expectedSellAmountMinor: middle.sellAmountMinor,
    }).expect(409)
    expect(changed.body.data).toMatchObject({ offerId: middle.offerId, status: 'price_changed', currency: 'AED', sellAmountMinor: hotels[50].totalMinor + 100 })
    expect(middle.sellAmountMinor).toBe(hotels[50].totalMinor)
    await prisma.dailyRate.update({
      where: { ratePlanId_stayDate_occupancy: { ratePlanId: hotels[50].sellPlanId, stayDate: utc(nights[0]), occupancy: 2 } },
      data: { amountMinor: BigInt(hotels[50].nightMinor) },
    })

    await prisma.dailyAvailability.update({
      where: { ratePlanId_stayDate: { ratePlanId: hotels[99].sellPlanId, stayDate: utc(nights[0]) } },
      data: { stopSell: true },
    })
    const stopped = await api(agentCookie).post('/api/v1/agent/rates/recheck').send({
      offerId: last.offerId, searchId: found.body.data.searchId, expectedCurrency: 'AED', expectedSellAmountMinor: last.sellAmountMinor,
    }).expect(409)
    expect(stopped.body.data.status).toBe('unavailable')
    const afterStop = await search().expect(201)
    expect(afterStop.body.data.hotels).toHaveLength(HOTEL_COUNT - 1)
    expect(afterStop.body.data.hotels.some((hotel: { hotelId: string }) => hotel.hotelId === hotels[99].hotelId)).toBe(false)
    expect(afterStop.body.data.hotels.some((hotel: { hotelId: string }) => hotel.hotelId === hotels[0].hotelId)).toBe(true)
    await prisma.dailyAvailability.update({
      where: { ratePlanId_stayDate: { ratePlanId: hotels[99].sellPlanId, stayDate: utc(nights[0]) } },
      data: { stopSell: false },
    })
    expect((await search()).body.data.hotels).toHaveLength(HOTEL_COUNT)
  })

  it('keeps tenant, permission and booking boundaries at this scale', async () => {
    const own = await search().expect(201)
    expect(own.body.data.hotels.some((hotel: { name: string }) => hotel.name.includes('Other Tenant'))).toBe(false)
    const other = await search(otherCookie, {}, otherTenantId).expect(201)
    expect(other.body.data.hotels.map((hotel: { name: string }) => hotel.name)).toEqual([`${suffix} ZZZ Other Tenant`])
    const offer = own.body.data.hotels[0].rooms[0].rates[0]
    const cross = await api(otherCookie, otherTenantId).post('/api/v1/agent/rates/recheck').send({
      offerId: offer.offerId, searchId: own.body.data.searchId, expectedCurrency: 'AED', expectedSellAmountMinor: offer.sellAmountMinor,
    }).expect(409)
    expect(cross.body.data.status).toBe('unavailable')
    await api(agentCookie, otherTenantId).post('/api/v1/agent/search').send(searchBody()).expect(403)
    await api(deniedCookie).post('/api/v1/agent/search').send(searchBody()).expect(403)
    await request(app.getHttpServer()).post('/api/v1/agent/search').set('x-fbeds-tenant-id', tenantId).send(searchBody()).expect(401)
    const empty = await search(emptyCookie, {}, emptyTenantId).expect(201)
    expect(empty.body.data).toMatchObject({ status: 'provider_unavailable', hotels: [] })
    const prebook = await api(ownerCookie).post('/api/v1/agent/prebook').send({
      inventoryHoldId: 'hold-not-used-while-disabled', idempotencyKey: `${suffix}-prebook`, adults: 2, children: 0, childAges: [], leadGuest: { firstName: 'Test', lastName: 'Guest' },
    }).expect(503)
    expect(prebook.body.data.status).toBe('booking_unavailable')
    const booking = await api(ownerCookie).post('/api/v1/agent/bookings').send({
      bookingId: 'booking-not-used-while-disabled',
    }).expect(503)
    expect(booking.body.data.status).toBe('booking_unavailable')
  })
})
