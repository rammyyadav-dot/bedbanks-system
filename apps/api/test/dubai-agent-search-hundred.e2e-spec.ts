import { mkdirSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { INestApplication, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import * as cookieParser from 'cookie-parser'
import * as request from 'supertest'
import { PrismaClient, type Prisma } from '@prisma/client'
import { AppModule } from '../src/app.module'
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor'
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter'
import { hashPassword } from '../src/auth/utils/password'

const prisma = new PrismaClient()
jest.setTimeout(180000)

async function withTenant<T>(tenantId: string, work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`
    return work(tx)
  }, { timeout: 120_000 })
}

const measured: { adminReadinessMs?: number; adminHotelPagesMs?: number; firstSearchMs?: number; repeatSearchMs?: number[]; priceChangedRecheckMs?: number; stopSellRecheckMs?: number } = {}

const HOTEL_COUNT = 100
const PLANS_PER_HOTEL = 3

describe('Authoritative Dubai 100-hotel agent search', () => {
  const suffix = `dubai-100-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const password = 'dubai-hundred-hotel-certification-password'
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
  const utc = (iso: string) => new Date(`${iso}T00:00:00.000Z`)
  const windowStart = 14
  const sellableNights = Array.from({ length: 7 }, (_, index) => day(windowStart + index))
  const checkIn = sellableNights[0]
  const checkOut = day(windowStart + 3)
  const nights = sellableNights.slice(0, 3)
  const shiftedCheckIn = sellableNights[3]
  const shiftedNights = sellableNights.slice(3)
  const shiftedCheckOut = day(windowStart + 7)
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
    const permissionKeys = ['hotel.search', 'booking.prebook', 'booking.create', 'supply.hotels.read', 'supply.suppliers.read', 'supply.contracts.read', 'supply.mappings.read', 'supply.rates.read', 'booking.read', 'audit.read']
    const permissions = await Promise.all(permissionKeys.map((key) => prisma.permission.upsert({ where: { key }, update: {}, create: { key, description: `${suffix} ${key}` } })))
    const byKey = new Map(permissions.map((permission) => [permission.key, permission.id]))
    const [ownerRole, agentRole, deniedRole] = await withTenant(tenantId, (tx) => Promise.all([
      tx.role.create({ data: { tenantId, name: `${suffix}-owner` } }),
      tx.role.create({ data: { tenantId, name: `${suffix}-agent` } }),
      tx.role.create({ data: { tenantId, name: `${suffix}-denied` } }),
    ]))
    const otherRole = await withTenant(otherTenantId, (tx) => tx.role.create({ data: { tenantId: otherTenantId, name: `${suffix}-other` } }))
    const emptyRole = await withTenant(emptyTenantId, (tx) => tx.role.create({ data: { tenantId: emptyTenantId, name: `${suffix}-empty` } }))
    roleIds.push(ownerRole.id, agentRole.id, deniedRole.id, otherRole.id, emptyRole.id)
    await prisma.rolePermission.createMany({ data: permissionKeys.map((key) => ({ roleId: ownerRole.id, permissionId: byKey.get(key)! })) })
    await prisma.rolePermission.createMany({ data: ['hotel.search', 'booking.prebook'].map((key) => ({ roleId: agentRole.id, permissionId: byKey.get(key)! })) })
    await prisma.rolePermission.create({ data: { roleId: otherRole.id, permissionId: byKey.get('hotel.search')! } })
    await prisma.rolePermission.create({ data: { roleId: emptyRole.id, permissionId: byKey.get('hotel.search')! } })
    await withTenant(tenantId, (tx) => tx.membership.createMany({ data: [
      { tenantId, userId: ownerId, role: 'owner' },
      { tenantId, userId: agentId, role: 'agent' },
      { tenantId, userId: deniedId, role: 'staff' },
    ] }))
    await withTenant(otherTenantId, (tx) => tx.membership.create({ data: { tenantId: otherTenantId, userId: otherUserId, role: 'agent' } }))
    await withTenant(emptyTenantId, (tx) => tx.membership.create({ data: { tenantId: emptyTenantId, userId: emptyUserId, role: 'agent' } }))
    await withTenant(tenantId, (tx) => tx.userRole.createMany({ data: [
      { tenantId, userId: ownerId, roleId: ownerRole.id },
      { tenantId, userId: agentId, roleId: agentRole.id },
      { tenantId, userId: deniedId, roleId: deniedRole.id },
    ] }))
    await withTenant(otherTenantId, (tx) => tx.userRole.create({ data: { tenantId: otherTenantId, userId: otherUserId, roleId: otherRole.id } }))
    await withTenant(emptyTenantId, (tx) => tx.userRole.create({ data: { tenantId: emptyTenantId, userId: emptyUserId, roleId: emptyRole.id } }))
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
    mkdirSync('/opt/cursor/artifacts', { recursive: true })
    writeFileSync('/opt/cursor/artifacts/dubai-100-metrics.json', JSON.stringify({
      ...measured, hotels: HOTEL_COUNT, offers: HOTEL_COUNT, activePlans: HOTEL_COUNT * PLANS_PER_HOTEL,
      sellableNights: sellableNights.length, cachePolicy: 'contracted-inventory-uncached',
    }, null, 2))
    await app?.close()
    const tenantIds = [tenantId, otherTenantId, emptyTenantId].filter(Boolean)
    if (roleIds.length) await prisma.rolePermission.deleteMany({ where: { roleId: { in: roleIds } } })
    for (const id of tenantIds) {
      await withTenant(id, async (tx) => {
        await tx.auditEvent.deleteMany({ where: { tenantId: id } })
        await tx.inventoryHoldNight.deleteMany({ where: { tenantId: id } })
        await tx.inventoryHold.deleteMany({ where: { tenantId: id } })
        await tx.dailyRate.deleteMany({ where: { tenantId: id } })
        await tx.dailyAvailability.deleteMany({ where: { tenantId: id } })
        await tx.ratePlan.deleteMany({ where: { tenantId: id } })
        await tx.contract.deleteMany({ where: { tenantId: id } })
        await tx.supplierRoomMapping.deleteMany({ where: { tenantId: id } })
        await tx.supplierHotelMapping.deleteMany({ where: { tenantId: id } })
        await tx.boardBasis.deleteMany({ where: { tenantId: id } })
        await tx.roomType.deleteMany({ where: { hotel: { tenantId: id } } })
        await tx.hotel.deleteMany({ where: { tenantId: id } })
        await tx.supplier.deleteMany({ where: { tenantId: id } })
        await tx.userRole.deleteMany({ where: { tenantId: id } })
        await tx.membership.deleteMany({ where: { tenantId: id } })
        await tx.role.deleteMany({ where: { tenantId: id } })
      })
    }
    if (userIds.length) {
      await prisma.session.deleteMany({ where: { userId: { in: userIds } } })
      await prisma.user.deleteMany({ where: { id: { in: userIds } } })
    }
    if (tenantIds.length) await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } })
    await prisma.$disconnect()
  }, 180000)

  async function seedInventory() {
    const supplier = await withTenant(tenantId, (tx) => tx.supplier.create({ data: {
      tenantId, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${suffix} Supplier`, displayName: 'Dubai Hundred Supply',
      countryCode: 'AE', defaultCurrency: 'AED',
    } }))
    supplierId = supplier.id
    const board = await withTenant(tenantId, (tx) => tx.boardBasis.create({ data: { tenantId, code: 'BB', name: 'Bed & Breakfast', isActive: true } }))
    boardId = board.id
    const otherSupplier = await withTenant(otherTenantId, (tx) => tx.supplier.create({ data: {
      tenantId: otherTenantId, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${suffix} Other Supplier`, displayName: 'Other Hundred Supply',
      countryCode: 'AE', defaultCurrency: 'AED',
    } }))
    const otherBoard = await withTenant(otherTenantId, (tx) => tx.boardBasis.create({ data: { tenantId: otherTenantId, code: 'BB', name: 'Bed & Breakfast', isActive: true } }))
    const otherHotelId = randomUUID()
    const otherRoomId = randomUUID()
    const otherMappingId = randomUUID()
    const otherContractId = randomUUID()
    const otherPlanId = randomUUID()
    await withTenant(tenantId, (tx) => tx.hotel.createMany({ data: hotels.map((hotel) => ({
      id: hotel.hotelId, tenantId, name: hotel.name, propertyType: 'HOTEL', starRating: 4, city: 'Dubai', countryCode: 'AE', contentStatus: 'COMPLETE' as const,
    })) }))
    await withTenant(otherTenantId, (tx) => tx.hotel.create({ data: {
      id: otherHotelId, tenantId: otherTenantId, name: `${suffix} ZZZ Other Tenant`, propertyType: 'HOTEL', starRating: 4, city: 'Dubai', countryCode: 'AE', contentStatus: 'COMPLETE',
    } }))
    await withTenant(tenantId, (tx) => tx.roomType.createMany({ data: hotels.map((hotel) => ({
      id: hotel.roomId, hotelId: hotel.hotelId, name: 'King Room', code: 'KG', maxAdults: 2, maxChildren: 0, maxOccupancy: 2, isActive: true,
    })) }))
    await withTenant(otherTenantId, (tx) => tx.roomType.create({ data: {
      id: otherRoomId, hotelId: otherHotelId, name: 'Other Room', code: 'OR', maxAdults: 2, maxChildren: 0, maxOccupancy: 2, isActive: true,
    } }))
    await withTenant(tenantId, (tx) => tx.supplierHotelMapping.createMany({ data: hotels.map((hotel) => ({
      id: hotel.mappingId, tenantId, supplierId, hotelId: hotel.hotelId, supplierHotelId: `${suffix}-${hotel.index}`, status: 'MAPPED' as const,
    })) }))
    await withTenant(otherTenantId, (tx) => tx.supplierHotelMapping.create({ data: {
      id: otherMappingId, tenantId: otherTenantId, supplierId: otherSupplier.id, hotelId: otherHotelId, supplierHotelId: `${suffix}-other`, status: 'MAPPED',
    } }))
    await withTenant(tenantId, (tx) => tx.supplierRoomMapping.createMany({ data: hotels.map((hotel) => ({
      id: hotel.roomMappingId, tenantId, supplierHotelMappingId: hotel.mappingId, hotelId: hotel.hotelId, supplierRoomId: `${suffix}-room-${hotel.index}`, roomTypeId: hotel.roomId, status: 'MAPPED' as const,
    })) }))
    await withTenant(otherTenantId, (tx) => tx.supplierRoomMapping.create({ data: {
      id: randomUUID(), tenantId: otherTenantId, supplierHotelMappingId: otherMappingId, hotelId: otherHotelId, supplierRoomId: `${suffix}-other-room`, roomTypeId: otherRoomId, status: 'MAPPED',
    } }))
    await withTenant(tenantId, (tx) => tx.contract.createMany({ data: hotels.map((hotel) => ({
      id: hotel.contractId, tenantId, supplierId, supplierHotelMappingId: hotel.mappingId, code: `${suffix}-C-${hotel.index}`, status: 'ACTIVE' as const,
      validFrom: utc(day(0)), validTo: utc(day(60)), settlementCurrency: 'AED',
    })) }))
    await withTenant(otherTenantId, (tx) => tx.contract.create({ data: {
      id: otherContractId, tenantId: otherTenantId, supplierId: otherSupplier.id, supplierHotelMappingId: otherMappingId, code: `${suffix}-other-C`, status: 'ACTIVE',
      validFrom: utc(day(0)), validTo: utc(day(60)), settlementCurrency: 'AED',
    } }))
    await withTenant(tenantId, (tx) => tx.ratePlan.createMany({ data: hotels.flatMap((hotel) => [
      plan(hotel.sellPlanId, hotel, 'FLEX', 1),
      plan(hotel.minPlanId, hotel, 'MIN', 5),
      plan(hotel.stopPlanId, hotel, 'STOP', 1),
    ]) }))
    await withTenant(otherTenantId, (tx) => tx.ratePlan.create({ data: {
      id: otherPlanId, tenantId: otherTenantId, contractId: otherContractId, roomTypeId: otherRoomId, boardBasisId: otherBoard.id,
      code: `${suffix}-other-FLEX`, status: 'ACTIVE', occupancy: 2, currency: 'AED', refundable: true, minStay: 1, releaseDays: 0,
    } }))
    const rateRows = hotels.flatMap((hotel) => sellableNights.flatMap((stayDate) => [
      rate(hotel.sellPlanId, stayDate, hotel.nightMinor),
      rate(hotel.minPlanId, stayDate, hotel.nightMinor + 1),
      rate(hotel.stopPlanId, stayDate, hotel.nightMinor + 2),
    ]))
    const otherRateRows = sellableNights.map((stayDate) => ({
      tenantId: otherTenantId, ratePlanId: otherPlanId, stayDate: utc(stayDate), occupancy: 2, amountMinor: 19_900n, amountBasis: 'SELL' as const, currency: 'AED',
    }))
    const availabilityRows = hotels.flatMap((hotel) => sellableNights.flatMap((stayDate) => [
      availability(hotel.sellPlanId, stayDate, false),
      availability(hotel.minPlanId, stayDate, false),
      availability(hotel.stopPlanId, stayDate, true),
    ]))
    const otherAvailabilityRows = sellableNights.map((stayDate) => ({
      tenantId: otherTenantId, ratePlanId: otherPlanId, stayDate: utc(stayDate), allotment: 4, sold: 0, held: 0, stopSell: false, minStay: 1,
    }))
    await withTenant(tenantId, async (tx) => {
      for (let offset = 0; offset < rateRows.length; offset += 250) await tx.dailyRate.createMany({ data: rateRows.slice(offset, offset + 250) })
      for (let offset = 0; offset < availabilityRows.length; offset += 250) await tx.dailyAvailability.createMany({ data: availabilityRows.slice(offset, offset + 250) })
    })
    await withTenant(otherTenantId, async (tx) => {
      await tx.dailyRate.createMany({ data: otherRateRows })
      await tx.dailyAvailability.createMany({ data: otherAvailabilityRows })
    })
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
    const activePlans = await withTenant(tenantId, (tx) => tx.ratePlan.count({ where: { tenantId, status: 'ACTIVE' } }))
    expect(activePlans).toBe(HOTEL_COUNT * PLANS_PER_HOTEL)
    const started = process.hrtime.bigint()
    const response = await search().expect(201)
    measured.firstSearchMs = Number(process.hrtime.bigint() - started) / 1_000_000
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
    const repeats: number[] = []
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const started = process.hrtime.bigint()
      const again = await search().expect(201)
      repeats.push(Number(process.hrtime.bigint() - started) / 1_000_000)
      expect(commercialSignature(again.body.data.hotels)).toEqual(signature)
    }
    measured.repeatSearchMs = repeats
  })

  // Admin hotel-contracting acceptance over the SAME 100-hotel fixture (read-only calls; each failure scenario perturbs one hotel and restores it).
  it('Admin hotel contracting: DUBAI-01..16 over all 100 hotels, from the API', async () => {
    const get = (path: string, cookie = ownerCookie, tenant = tenantId) => request(app.getHttpServer()).get(`/api/v1/admin/operations${path}`).set('Cookie', cookie).set('x-fbeds-tenant-id', tenant)
    const window = `from=${checkIn}&days=7`
    const hotelRow = async (index: number) => (await get(`/hotels?${window}&search=${encodeURIComponent(hotels[index].name)}&pageSize=5`).expect(200)).body.data.items[0]
    const hotelDetail = async (index: number) => (await get(`/hotels/${hotels[index].hotelId}?${window}`).expect(200)).body.data

    // Every fixture hotel carries a sell plan, a min-stay plan and a stop-sell plan: PARTIAL, with the stop-sell plan explained.
    const startedSummary = process.hrtime.bigint()
    const summary = (await get(`/hotels/summary?${window}`).expect(200)).body.data
    measured.adminReadinessMs = Number(process.hrtime.bigint() - startedSummary) / 1_000_000
    expect(summary).toMatchObject({ totalHotels: HOTEL_COUNT, scanCapped: false, readiness: { ready: 0, partial: HOTEL_COUNT, blocked: 0 }, stopSellHotels: HOTEL_COUNT, mappingIssueHotels: 0, rateGapHotels: 0, availabilityGapHotels: 0 })
    const readiness = (await get(`/readiness?${window}`).expect(200)).body.data
    expect(readiness.supply).toMatchObject({ state: 'available', data: { hotels: { total: HOTEL_COUNT, ready: 0, partial: HOTEL_COUNT, blocked: 0 }, hotelMappings: { mapped: HOTEL_COUNT, pending: 0, rejected: 0 }, roomMappings: { mapped: HOTEL_COUNT, pending: 0, rejected: 0 }, suppliers: { total: 1, active: 1 } } })

    // DUBAI-01/02/03: hotels 1, 51+ and 100 are reachable by search and by page position, never by loading everything.
    const started = process.hrtime.bigint()
    const seen = new Set<string>()
    for (let page = 1; page <= 4; page += 1) {
      const body = (await get(`/hotels?${window}&page=${page}&pageSize=25`).expect(200)).body.data
      expect(body).toMatchObject({ page, pageSize: 25, total: HOTEL_COUNT }); expect(body.items).toHaveLength(25)
      for (const hotel of body.items) { expect(hotel).toMatchObject({ rooms: { total: 1, active: 1, mapped: 1 }, ratePlans: { total: PLANS_PER_HOTEL, active: PLANS_PER_HOTEL }, readiness: 'PARTIAL', hotelMapping: 'MAPPED', contractState: 'ACTIVE', inventory: 'STOP_SELL' }); seen.add(hotel.id) }
    }
    measured.adminHotelPagesMs = Number(process.hrtime.bigint() - started) / 1_000_000
    expect(seen).toEqual(new Set(hotels.map((hotel) => hotel.hotelId)))
    for (const index of [0, 50, 51, 99]) expect((await hotelRow(index))).toMatchObject({ id: hotels[index].hotelId, name: hotels[index].name })
    // DUBAI-04: pagination reaches the final page; the next page is a real, successful empty page.
    expect((await get(`/hotels?${window}&page=4&pageSize=25`).expect(200)).body.data.items.at(-1).id).toBe(hotels[99].hotelId)
    expect((await get(`/hotels?${window}&page=5&pageSize=25`).expect(200)).body.data).toMatchObject({ total: HOTEL_COUNT, items: [] })
    expect((await get(`/hotels?${window}&page=1&pageSize=10`).expect(200)).body.data.items).toHaveLength(10)
    // DUBAI-05/06: search beyond page 1, and the destination filter, combined with pagination.
    const deep = (await get(`/hotels?${window}&search=${encodeURIComponent(hotels[77].name)}`).expect(200)).body.data
    expect(deep.total).toBe(1); expect(deep.items[0].id).toBe(hotels[77].hotelId)
    expect((await get(`/hotels?${window}&destination=Dubai&page=3&pageSize=40`).expect(200)).body.data).toMatchObject({ total: HOTEL_COUNT, page: 3 })
    expect((await get(`/hotels?${window}&destination=Nowhere`).expect(200)).body.data).toMatchObject({ total: 0, items: [] })
    // DUBAI-13: stop sell is identified on every hotel, with the affected range.
    const stop = (await hotelDetail(13)).issues.find((i: { category: string }) => i.category === 'STOP_SELL')
    expect(stop).toMatchObject({ reason: 'STOP_SELL', from: sellableNights[0], to: sellableNights[6], nights: 7, severity: 'HIGH', section: 'rates' })
    expect((await get(`/hotels?${window}&issue=STOP_SELL&pageSize=100`).expect(200)).body.data.total).toBe(HOTEL_COUNT)

    // Failure scenarios: one hotel at a time, restored in `finally`.
    const prismaTx = prisma
    async function scenario<T>(_index: number, perturb: () => Promise<() => Promise<void>>, check: () => Promise<T>) {
      const restore = await perturb()
      try { return await check() } finally { await restore() }
    }
    const planIds = (i: number) => [hotels[i].sellPlanId, hotels[i].minPlanId, hotels[i].stopPlanId]
    // DUBAI-07: a READY hotel, explained gate by gate (stop-sell plan lifted).
    await scenario(7, async () => { await prismaTx.dailyAvailability.updateMany({ where: { ratePlanId: hotels[7].stopPlanId }, data: { stopSell: false } }); return async () => { await prismaTx.dailyAvailability.updateMany({ where: { ratePlanId: hotels[7].stopPlanId }, data: { stopSell: true } }) } }, async () => {
      const d = await hotelDetail(7)
      expect(d).toMatchObject({ readiness: 'READY', agentSellable: true, blockers: [] }); expect(d.issues).toEqual([])
      expect(d.gates.every((g: { state: string }) => g.state === 'PASS')).toBe(true)
      const inspect = (await get(`/hotels/${hotels[7].hotelId}/sellability?checkIn=${sellableNights[0]}&checkOut=${sellableNights[3]}&adults=2&children=0`).expect(200)).body.data
      expect(inspect.sellable).toBe(true); expect(inspect.offers).toBeGreaterThanOrEqual(1); expect(inspect.cheapestMinor).toBe(String(hotels[7].nightMinor * 3))
    })
    // DUBAI-08: hotel mapping not approved blocks readiness.
    await scenario(8, async () => { await prismaTx.supplierHotelMapping.update({ where: { id: hotels[8].mappingId }, data: { status: 'PENDING' } }); return async () => { await prismaTx.supplierHotelMapping.update({ where: { id: hotels[8].mappingId }, data: { status: 'MAPPED' } }) } }, async () => {
      const d = await hotelDetail(8); expect(d.readiness).toBe('BLOCKED'); expect(d.hotelMapping).toBe('PENDING'); expect(d.blockers).toContain('SUPPLIER_MAPPING_INVALID')
      expect(d.issues.some((i: { category: string }) => i.category === 'UNMAPPED_HOTEL')).toBe(true)
    })
    // DUBAI-09: an unmapped room blocks the affected supply.
    await scenario(9, async () => { await prismaTx.supplierRoomMapping.update({ where: { id: hotels[9].roomMappingId }, data: { status: 'REJECTED' } }); return async () => { await prismaTx.supplierRoomMapping.update({ where: { id: hotels[9].roomMappingId }, data: { status: 'MAPPED' } }) } }, async () => {
      const d = await hotelDetail(9); expect(d.readiness).toBe('BLOCKED'); expect(d.rooms[0].mapping).toBe('REJECTED')
      expect(d.issues.some((i: { category: string; roomName: string }) => i.category === 'UNMAPPED_ROOM' && i.roomName)).toBe(true)
    })
    // DUBAI-10: a contract that ended blocks sellability.
    await scenario(10, async () => { const before = await prismaTx.contract.findUniqueOrThrow({ where: { id: hotels[10].contractId } }); await prismaTx.contract.update({ where: { id: hotels[10].contractId }, data: { validTo: utc(sellableNights[0]) } }); return async () => { await prismaTx.contract.update({ where: { id: hotels[10].contractId }, data: { validTo: before.validTo } }) } }, async () => {
      const d = await hotelDetail(10); expect(d.readiness).toBe('BLOCKED'); expect(d.blockers).toContain('OUTSIDE_CONTRACT_VALIDITY'); expect(d.issues.some((i: { category: string }) => i.category === 'CONTRACT_EXPIRED')).toBe(true)
    })
    // DUBAI-11 / DUBAI-12: missing rates, missing availability (rows removed and restored exactly).
    for (const [index, model] of [[11, 'dailyRate'], [12, 'dailyAvailability']] as const) {
      const rows = await (prismaTx[model] as unknown as { findMany: (a: object) => Promise<Array<Record<string, unknown>>> }).findMany({ where: { ratePlanId: { in: planIds(index) } } })
      await scenario(index, async () => { await (prismaTx[model] as unknown as { deleteMany: (a: object) => Promise<unknown> }).deleteMany({ where: { ratePlanId: { in: planIds(index) } } }); return async () => { await (prismaTx[model] as unknown as { createMany: (a: object) => Promise<unknown> }).createMany({ data: rows }) } }, async () => {
        const d = await hotelDetail(index); expect(d.readiness).toBe('BLOCKED')
        expect(d.issues.some((i: { category: string }) => i.category === (model === 'dailyRate' ? 'RATE_MISSING' : 'AVAILABILITY_MISSING'))).toBe(true)
        expect((await hotelRow(index))[model === 'dailyRate' ? 'rates' : 'inventory']).toBe('GAPS')
      })
    }
    // DUBAI-14: inventory exhaustion.
    await scenario(14, async () => { await prismaTx.dailyAvailability.updateMany({ where: { ratePlanId: { in: [hotels[14].sellPlanId, hotels[14].minPlanId] } }, data: { sold: 4 } }); return async () => { await prismaTx.dailyAvailability.updateMany({ where: { ratePlanId: { in: [hotels[14].sellPlanId, hotels[14].minPlanId] } }, data: { sold: 0 } }) } }, async () => {
      const d = await hotelDetail(14); expect(d.readiness).toBe('BLOCKED'); expect(d.issues.some((i: { category: string }) => i.category === 'INVENTORY_EXHAUSTED')).toBe(true)
    })
    // DUBAI-15: an active hold is reflected in the calendar and the hotel without overselling.
    {
      const { InventoryHoldService } = await import('../src/agent/inventory-hold.service')
      const { PrismaService } = await import('../src/database/prisma.service')
      const holds = new InventoryHoldService(new PrismaService())
      const hold = await holds.create({ tenantId, userId: ownerId, requestId: `${suffix}-dubai-hold`, idempotencyKey: `${suffix}-dubai-hold`, offerId: 'dubai-offer', searchId: 'dubai-search', ratePlanId: hotels[15].sellPlanId, canonicalHotelId: hotels[15].hotelId, canonicalRoomTypeId: hotels[15].roomId, boardBasisId: boardId, checkIn: sellableNights[0], checkOut: sellableNights[2], rooms: 1, currency: 'AED', sellAmountMinor: hotels[15].nightMinor * 2, offerExpiresAt: new Date(Date.now() + 3_600_000).toISOString() })
      try {
        const cal = (await get(`/hotels/${hotels[15].hotelId}/calendar?from=${sellableNights[0]}&days=3`).expect(200)).body.data.rows.find((r: { ratePlanId: string }) => r.ratePlanId === hotels[15].sellPlanId)
        expect(cal.cells[0]).toMatchObject({ held: 1, sold: 0 }); expect(cal.cells[0].remaining).toBe(cal.cells[0].allotment - 1); expect(cal.cells[0].remaining).toBeGreaterThanOrEqual(0)
        expect((await hotelDetail(15)).counts.activeHolds).toBe(1)
      } finally { await holds.release(tenantId, hold.holdId, `${suffix}-dubai-release`, { type: 'USER', userId: ownerId }) }
    }
    // DUBAI-16: the hotel's bookings are reachable by a server-side filter.
    expect((await get(`/bookings?hotelId=${hotels[16].hotelId}`).expect(200)).body.data).toMatchObject({ total: 0, items: [] }) // an honest, successful zero
    const booking = await prisma.booking.create({ data: { tenantId, reference: `${suffix}-DBK`, supplier: 'contracted', hotelId: hotels[16].hotelId, status: 'CONFIRMED', currency: 'AED', totalMinor: BigInt(hotels[16].totalMinor), idempotencyKey: `${suffix}-dbk`, searchSnapshot: { checkIn, checkOut } } })
    try { expect((await get(`/bookings?hotelId=${hotels[16].hotelId}`).expect(200)).body.data.items.map((b: { id: string }) => b.id)).toEqual([booking.id]); expect((await hotelDetail(16)).counts.bookings).toBe(1) } finally { await prisma.booking.delete({ where: { id: booking.id } }) }

    // Everything was restored: the fixture is exactly as it was for the Agent tests that follow.
    expect((await get(`/hotels/summary?${window}`).expect(200)).body.data.readiness).toEqual({ ready: 0, partial: HOTEL_COUNT, blocked: 0 })

    // ADMIN-01 / RBAC / tenant boundaries at this scale.
    for (const path of ['/readiness', '/hotels', '/hotels/summary', '/exceptions', '/bookings', '/audit']) expect((await request(app.getHttpServer()).get(`/api/v1/admin/operations${path}`).expect(401)).body.success).toBe(false)
    expect((await get('/hotels', agentCookie).expect(403)).body.success).toBe(false) // agent role: no supply.hotels.read
    expect((await get('/hotels', ownerCookie, otherTenantId).expect(403)).body.success).toBe(false) // owner has no membership in the other tenant
    expect((await get('/hotels?pageSize=101').expect(400)).body.success).toBe(false)
    const otherHotels = (await get('/hotels?pageSize=100', otherCookie, otherTenantId)).status
    expect(otherHotels).toBe(403) // the other tenant's agent holds no supply permission either
  }, 180000)

  it('walks every sellable hotel through deterministic pages', async () => {
    const pageSize = 25
    const seen = new Set<string>()
    const names: string[] = []
    const offerIds = new Set<string>()
    const pages: number[] = []
    let offset = 0
    let secondPageIds: string[] = []
    for (let page = 0; page < 5; page += 1) {
      const response = await search(agentCookie, { limit: pageSize, offset }).expect(201)
      const rows = response.body.data.hotels as Array<{ hotelId: string; name: string; rooms: Array<{ rates: Array<{ offerId: string }> }> }>
      const pagination = response.body.data.pagination
      expect(pagination).toMatchObject({ limit: pageSize, offset, total: HOTEL_COUNT, hasMore: offset + rows.length < HOTEL_COUNT })
      expect(response.body.data.total).toBe(rows.length)
      if (pagination.hasMore) expect(pagination.nextOffset).toBe(offset + pageSize)
      else expect(pagination.nextOffset).toBeUndefined()
      pages.push(rows.length)
      if (offset === pageSize) secondPageIds = rows.map((hotel) => hotel.hotelId)
      for (const hotel of rows) {
        expect(seen.has(hotel.hotelId)).toBe(false)
        seen.add(hotel.hotelId)
        names.push(hotel.name)
        for (const rate of hotel.rooms.flatMap((room) => room.rates)) offerIds.add(rate.offerId)
      }
      if (!pagination.hasMore) break
      offset = pagination.nextOffset
    }
    expect(pages).toEqual([25, 25, 25, 25])
    expect(seen.size).toBe(HOTEL_COUNT)
    expect(offerIds.size).toBe(HOTEL_COUNT)
    expect(names).toEqual(hotels.map((hotel) => hotel.name))
    expect(names.some((name) => name.includes('Other Tenant'))).toBe(false)
    const repeated = await search(agentCookie, { limit: pageSize, offset: pageSize }).expect(201)
    expect(repeated.body.data.hotels.map((hotel: { hotelId: string }) => hotel.hotelId)).toEqual(secondPageIds)

    await request(app.getHttpServer()).post('/api/v1/agent/search').set('x-fbeds-tenant-id', tenantId).send(searchBody({ limit: pageSize, offset: pageSize })).expect(401)
    await api(deniedCookie).post('/api/v1/agent/search').send(searchBody({ limit: pageSize, offset: pageSize })).expect(403)
    await api(agentCookie, otherTenantId).post('/api/v1/agent/search').send(searchBody({ limit: pageSize, offset: pageSize })).expect(403)
    const otherPage = await search(otherCookie, { limit: pageSize, offset: 0 }, otherTenantId).expect(201)
    expect(otherPage.body.data.hotels.map((hotel: { name: string }) => hotel.name)).toEqual([`${suffix} ZZZ Other Tenant`])
    expect(otherPage.body.data.hotels.some((hotel: { hotelId: string }) => seen.has(hotel.hotelId))).toBe(false)

    const priced = hotels[10]
    await withTenant(tenantId, (tx) => tx.dailyRate.update({
      where: { ratePlanId_stayDate_occupancy: { ratePlanId: priced.sellPlanId, stayDate: utc(nights[0]), occupancy: 2 } },
      data: { amountMinor: BigInt(priced.nightMinor + 100) },
    }))
    const repriced = await search(agentCookie, { limit: pageSize, offset: 0 }).expect(201)
    expect(repriced.body.data.hotels.find((hotel: { hotelId: string }) => hotel.hotelId === priced.hotelId).rooms[0].rates[0].sellAmountMinor).toBe(priced.totalMinor + 100)
    await withTenant(tenantId, (tx) => tx.dailyRate.update({
      where: { ratePlanId_stayDate_occupancy: { ratePlanId: priced.sellPlanId, stayDate: utc(nights[0]), occupancy: 2 } },
      data: { amountMinor: BigInt(priced.nightMinor) },
    }))

    const stoppedHotel = hotels[30]
    await withTenant(tenantId, (tx) => tx.dailyAvailability.update({
      where: { ratePlanId_stayDate: { ratePlanId: stoppedHotel.sellPlanId, stayDate: utc(nights[0]) } },
      data: { stopSell: true },
    }))
    const afterStop = await search(agentCookie, { limit: pageSize, offset: pageSize }).expect(201)
    expect(afterStop.body.data.hotels.some((hotel: { hotelId: string }) => hotel.hotelId === stoppedHotel.hotelId)).toBe(false)
    expect(afterStop.body.data.pagination.total).toBe(HOTEL_COUNT - 1)
    await withTenant(tenantId, (tx) => tx.dailyAvailability.update({
      where: { ratePlanId_stayDate: { ratePlanId: stoppedHotel.sellPlanId, stayDate: utc(nights[0]) } },
      data: { stopSell: false },
    }))
    expect((await search()).body.data.hotels).toHaveLength(HOTEL_COUNT)
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

    await withTenant(tenantId, (tx) => tx.dailyRate.update({
      where: { ratePlanId_stayDate_occupancy: { ratePlanId: hotels[50].sellPlanId, stayDate: utc(nights[0]), occupancy: 2 } },
      data: { amountMinor: BigInt(hotels[50].nightMinor + 100) },
    }))
    const changedStarted = process.hrtime.bigint()
    const changed = await api(agentCookie).post('/api/v1/agent/rates/recheck').send({
      offerId: middle.offerId, searchId: found.body.data.searchId, expectedCurrency: 'AED', expectedSellAmountMinor: middle.sellAmountMinor,
    }).expect(409)
    measured.priceChangedRecheckMs = Number(process.hrtime.bigint() - changedStarted) / 1_000_000
    expect(changed.body.data).toMatchObject({ offerId: middle.offerId, status: 'price_changed', currency: 'AED', sellAmountMinor: hotels[50].totalMinor + 100 })
    expect(middle.sellAmountMinor).toBe(hotels[50].totalMinor)
    await withTenant(tenantId, (tx) => tx.dailyRate.update({
      where: { ratePlanId_stayDate_occupancy: { ratePlanId: hotels[50].sellPlanId, stayDate: utc(nights[0]), occupancy: 2 } },
      data: { amountMinor: BigInt(hotels[50].nightMinor) },
    }))

    await withTenant(tenantId, (tx) => tx.dailyAvailability.update({
      where: { ratePlanId_stayDate: { ratePlanId: hotels[99].sellPlanId, stayDate: utc(nights[0]) } },
      data: { stopSell: true },
    }))
    const stoppedStarted = process.hrtime.bigint()
    const stopped = await api(agentCookie).post('/api/v1/agent/rates/recheck').send({
      offerId: last.offerId, searchId: found.body.data.searchId, expectedCurrency: 'AED', expectedSellAmountMinor: last.sellAmountMinor,
    }).expect(409)
    measured.stopSellRecheckMs = Number(process.hrtime.bigint() - stoppedStarted) / 1_000_000
    expect(stopped.body.data.status).toBe('unavailable')
    const afterStop = await search().expect(201)
    expect(afterStop.body.data.hotels).toHaveLength(HOTEL_COUNT - 1)
    expect(afterStop.body.data.hotels.some((hotel: { hotelId: string }) => hotel.hotelId === hotels[99].hotelId)).toBe(false)
    expect(afterStop.body.data.hotels.some((hotel: { hotelId: string }) => hotel.hotelId === hotels[0].hotelId)).toBe(true)
    await withTenant(tenantId, (tx) => tx.dailyAvailability.update({
      where: { ratePlanId_stayDate: { ratePlanId: hotels[99].sellPlanId, stayDate: utc(nights[0]) } },
      data: { stopSell: false },
    }))
    expect((await search()).body.data.hotels).toHaveLength(HOTEL_COUNT)
  })

  it('sells the same 100 hotels on a later stay inside the seven-day window', async () => {
    const coverage = await withTenant(tenantId, (tx) => tx.dailyRate.findMany({
      where: { tenantId, ratePlanId: hotels[0].sellPlanId },
      select: { stayDate: true },
      orderBy: { stayDate: 'asc' },
    }))
    expect(coverage.map((row) => row.stayDate.toISOString().slice(0, 10))).toEqual(sellableNights)
    expect(new Set([...nights, ...shiftedNights])).toEqual(new Set(sellableNights))
    const later = await search(agentCookie, { checkIn: shiftedCheckIn, checkOut: shiftedCheckOut, limit: 100 }).expect(201)
    expect(later.body.data.status).toBe('available')
    expect(later.body.data.hotels.map((hotel: { hotelId: string }) => hotel.hotelId)).toEqual(hotels.map((hotel) => hotel.hotelId))
    expect(later.body.data.hotels[50].rooms[0].rates[0].total).toEqual({ amountMinor: hotels[50].nightMinor * shiftedNights.length, currency: 'AED' })
    expect(later.body.data.hotels[99].rooms[0].rates[0].ratePlanId).toBe(hotels[99].sellPlanId)

    await withTenant(tenantId, (tx) => tx.dailyAvailability.update({
      where: { ratePlanId_stayDate: { ratePlanId: hotels[0].sellPlanId, stayDate: utc(nights[0]) } },
      data: { stopSell: true },
    }))
    const primary = await search().expect(201)
    expect(primary.body.data.hotels.some((hotel: { hotelId: string }) => hotel.hotelId === hotels[0].hotelId)).toBe(false)
    const stillLater = await search(agentCookie, { checkIn: shiftedCheckIn, checkOut: shiftedCheckOut, limit: 100 }).expect(201)
    expect(stillLater.body.data.hotels.some((hotel: { hotelId: string }) => hotel.hotelId === hotels[0].hotelId)).toBe(true)
    await withTenant(tenantId, (tx) => tx.dailyAvailability.update({
      where: { ratePlanId_stayDate: { ratePlanId: hotels[0].sellPlanId, stayDate: utc(nights[0]) } },
      data: { stopSell: false },
    }))
    expect((await search()).body.data.hotels).toHaveLength(HOTEL_COUNT)
  })

  it('reports a decreased price as price_changed and does not create a booking or hold', async () => {
    const beforeBookings = await withTenant(tenantId, (tx) => tx.booking.count({ where: { tenantId } }))
    const beforeHolds = await withTenant(tenantId, (tx) => tx.inventoryHold.count({ where: { tenantId } }))
    const found = await search().expect(201)
    const sample = hotels[40]
    const offer = found.body.data.hotels.find((hotel: { hotelId: string }) => hotel.hotelId === sample.hotelId).rooms[0].rates[0]
    await withTenant(tenantId, (tx) => tx.dailyRate.update({
      where: { ratePlanId_stayDate_occupancy: { ratePlanId: sample.sellPlanId, stayDate: utc(nights[0]), occupancy: 2 } },
      data: { amountMinor: BigInt(sample.nightMinor - 100) },
    }))
    const decreased = await api(agentCookie).post('/api/v1/agent/rates/recheck').send({
      offerId: offer.offerId, searchId: found.body.data.searchId, expectedCurrency: 'AED', expectedSellAmountMinor: offer.sellAmountMinor,
    }).expect(409)
    expect(decreased.body.data).toMatchObject({ offerId: offer.offerId, status: 'price_changed', currency: 'AED', sellAmountMinor: sample.totalMinor - 100 })
    expect(decreased.body.data.sellAmountMinor).toBeLessThan(offer.sellAmountMinor)
    await withTenant(tenantId, (tx) => tx.dailyRate.update({
      where: { ratePlanId_stayDate_occupancy: { ratePlanId: sample.sellPlanId, stayDate: utc(nights[0]), occupancy: 2 } },
      data: { amountMinor: BigInt(sample.nightMinor) },
    }))
    expect(await withTenant(tenantId, (tx) => tx.booking.count({ where: { tenantId } }))).toBe(beforeBookings)
    expect(await withTenant(tenantId, (tx) => tx.inventoryHold.count({ where: { tenantId } }))).toBe(beforeHolds)
  })

  it('marks an elapsed offer expired and rejects an extreme page size', async () => {
    await search(agentCookie, { limit: 10_000 }).expect(400)
    const previousTtl = process.env.AGENT_OFFER_TTL_MS
    process.env.AGENT_OFFER_TTL_MS = '1000'
    try {
      const beforeBookings = await withTenant(tenantId, (tx) => tx.booking.count({ where: { tenantId } }))
      const found = await search().expect(201)
      const offer = found.body.data.hotels[2].rooms[0].rates[0]
      const fresh = await api(agentCookie).post('/api/v1/agent/rates/recheck').send({
        offerId: offer.offerId, searchId: found.body.data.searchId, expectedCurrency: 'AED', expectedSellAmountMinor: offer.sellAmountMinor,
      }).expect(200)
      expect(fresh.body.data.status).toBe('rechecked')
      await new Promise((resolve) => setTimeout(resolve, 1_200))
      const expired = await api(agentCookie).post('/api/v1/agent/rates/recheck').send({
        offerId: offer.offerId, searchId: found.body.data.searchId, expectedCurrency: 'AED', expectedSellAmountMinor: offer.sellAmountMinor,
      }).expect(410)
      expect(expired.body.data.status).toBe('offer_expired')
      expect(JSON.stringify(expired.body)).not.toContain('postgresql://')
      expect(await withTenant(tenantId, (tx) => tx.booking.count({ where: { tenantId } }))).toBe(beforeBookings)
    } finally {
      if (previousTtl === undefined) delete process.env.AGENT_OFFER_TTL_MS
      else process.env.AGENT_OFFER_TTL_MS = previousTtl
    }
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
