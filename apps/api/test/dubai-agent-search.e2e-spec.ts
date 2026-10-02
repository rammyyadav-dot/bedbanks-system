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

describe('Authoritative Dubai one-hotel agent search', () => {
  const suffix = `dubai-one-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const password = 'dubai-one-hotel-certification-password'
  const hotelName = `${suffix} Marina Hotel`
  const roomName = 'Deluxe Room'
  const boardName = 'Bed & Breakfast'
  const nightMinor = 29900
  const stayMinor = nightMinor * 3
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
  const checkIn = day(14)
  const checkOut = day(17)
  const nights = [day(14), day(15), day(16)]
  let app: INestApplication
  let tenantId: string
  let otherTenantId: string
  let emptyTenantId: string
  let ownerId: string
  let agentId: string
  let deniedId: string
  let otherUserId: string
  let emptyUserId: string
  let roleId: string
  let agentRoleId: string
  let deniedRoleId: string
  let otherRoleId: string
  let emptyRoleId: string
  let supplierId: string
  let hotelId: string
  let roomId: string
  let boardId: string
  let mappingId: string
  let roomMappingId: string
  let contractId: string
  let ratePlanId: string
  let ownerCookie: string
  let agentCookie: string
  let deniedCookie: string
  let otherCookie: string
  let emptyCookie: string

  const searchBody = (patch: Record<string, unknown> = {}) => ({
    destination: 'Dubai', checkIn, checkOut, rooms: 1, adults: 2, children: 0, childAges: [],
    nationality: 'IN', currency: 'AED', limit: 50, ...patch,
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
    const [owner, agent, denied, otherUser, emptyUser] = await Promise.all([
      prisma.user.create({ data: { email: `${suffix}-owner@example.test`, passwordHash } }),
      prisma.user.create({ data: { email: `${suffix}-agent@example.test`, passwordHash } }),
      prisma.user.create({ data: { email: `${suffix}-denied@example.test`, passwordHash } }),
      prisma.user.create({ data: { email: `${suffix}-other@example.test`, passwordHash } }),
      prisma.user.create({ data: { email: `${suffix}-empty@example.test`, passwordHash } }),
    ])
    ownerId = owner.id
    agentId = agent.id
    deniedId = denied.id
    otherUserId = otherUser.id
    emptyUserId = emptyUser.id
    const permissionKeys = [
      'supply.hotels.read', 'supply.hotels.manage', 'supply.rooms.read', 'supply.rooms.manage',
      'supply.rates.read', 'supply.rates.manage', 'supply.contracts.read', 'supply.contracts.manage',
      'supply.availability.read', 'supply.availability.manage', 'supply.suppliers.read', 'supply.suppliers.manage',
      'supply.mappings.read', 'supply.mappings.manage', 'hotel.search', 'booking.prebook', 'booking.create',
    ]
    const permissions = await Promise.all(permissionKeys.map((key) => prisma.permission.upsert({ where: { key }, update: {}, create: { key, description: `${suffix} ${key}` } })))
    const byKey = new Map(permissions.map((permission) => [permission.key, permission.id]))
    const ownerRole = await prisma.role.create({ data: { tenantId, name: `${suffix}-owner` } })
    const agentRole = await prisma.role.create({ data: { tenantId, name: `${suffix}-agent` } })
    const deniedRole = await prisma.role.create({ data: { tenantId, name: `${suffix}-denied` } })
    const otherRole = await prisma.role.create({ data: { tenantId: otherTenantId, name: `${suffix}-other` } })
    const emptyRole = await prisma.role.create({ data: { tenantId: emptyTenantId, name: `${suffix}-empty` } })
    roleId = ownerRole.id
    agentRoleId = agentRole.id
    deniedRoleId = deniedRole.id
    otherRoleId = otherRole.id
    emptyRoleId = emptyRole.id
    await prisma.rolePermission.createMany({ data: permissions.map((permission) => ({ roleId, permissionId: permission.id })) })
    await prisma.rolePermission.createMany({ data: ['hotel.search', 'booking.prebook'].map((key) => ({ roleId: agentRoleId, permissionId: byKey.get(key)! })) })
    await prisma.rolePermission.create({ data: { roleId: otherRoleId, permissionId: byKey.get('hotel.search')! } })
    await prisma.rolePermission.create({ data: { roleId: emptyRoleId, permissionId: byKey.get('hotel.search')! } })
    await prisma.membership.createMany({ data: [
      { tenantId, userId: ownerId, role: 'owner' },
      { tenantId, userId: agentId, role: 'agent' },
      { tenantId, userId: deniedId, role: 'staff' },
      { tenantId: otherTenantId, userId: otherUserId, role: 'agent' },
      { tenantId: emptyTenantId, userId: emptyUserId, role: 'agent' },
    ] })
    await prisma.userRole.createMany({ data: [
      { tenantId, userId: ownerId, roleId },
      { tenantId, userId: agentId, roleId: agentRoleId },
      { tenantId, userId: deniedId, roleId: deniedRoleId },
      { tenantId: otherTenantId, userId: otherUserId, roleId: otherRoleId },
      { tenantId: emptyTenantId, userId: emptyUserId, roleId: emptyRoleId },
    ] })

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
    await loadGoldenPath()
  }, 60000)

  afterAll(async () => {
    await app?.close()
    const userIds = [ownerId, agentId, deniedId, otherUserId, emptyUserId].filter(Boolean)
    const tenantIds = [tenantId, otherTenantId, emptyTenantId].filter(Boolean)
    if (tenantId) {
      await prisma.auditEvent.deleteMany({ where: { tenantId: { in: tenantIds } } })
      await prisma.dailyRate.deleteMany({ where: { tenantId } })
      await prisma.dailyAvailability.deleteMany({ where: { tenantId } })
      await prisma.ratePlan.deleteMany({ where: { tenantId } })
      await prisma.contract.deleteMany({ where: { tenantId } })
      await prisma.supplierRoomMapping.deleteMany({ where: { tenantId } })
      await prisma.supplierHotelMapping.deleteMany({ where: { tenantId } })
      if (boardId) await prisma.boardBasis.deleteMany({ where: { id: boardId } })
      if (roomId) await prisma.roomType.deleteMany({ where: { id: roomId } })
      if (hotelId) await prisma.hotel.deleteMany({ where: { id: hotelId } })
      if (supplierId) await prisma.supplier.deleteMany({ where: { id: supplierId } })
    }
    if (userIds.length) {
      await prisma.userRole.deleteMany({ where: { userId: { in: userIds } } })
      await prisma.membership.deleteMany({ where: { userId: { in: userIds } } })
      await prisma.session.deleteMany({ where: { userId: { in: userIds } } })
      await prisma.user.deleteMany({ where: { id: { in: userIds } } })
    }
    const roleIds = [roleId, agentRoleId, deniedRoleId, otherRoleId, emptyRoleId].filter(Boolean)
    if (roleIds.length) {
      await prisma.rolePermission.deleteMany({ where: { roleId: { in: roleIds } } })
      await prisma.role.deleteMany({ where: { id: { in: roleIds } } })
    }
    if (tenantIds.length) await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } })
    await prisma.$disconnect()
  }, 60000)

  async function login(email: string) {
    const response = await request(app.getHttpServer()).post('/api/v1/auth/login')
      .set('Origin', 'http://localhost:3001').send({ email, password }).expect(200)
    return response.headers['set-cookie'][0].split(';')[0]
  }

  function api(cookie: string, tenant = tenantId) {
    const configure = (test: request.Test) => test.set('Cookie', cookie).set('x-fbeds-tenant-id', tenant)
    return {
      get: (path: string) => configure(request(app.getHttpServer()).get(path)),
      post: (path: string) => configure(request(app.getHttpServer()).post(path)),
      patch: (path: string) => configure(request(app.getHttpServer()).patch(path)),
    }
  }

  async function loadGoldenPath() {
    const admin = api(ownerCookie)
    const supplier = await admin.post('/api/v1/supply/suppliers').send({
      type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${suffix} Supplier`, displayName: 'Dubai Contracted Supply',
      countryCode: 'AE', defaultCurrency: 'AED',
    }).expect(201)
    supplierId = supplier.body.data.id
    const hotel = await admin.post('/api/v1/supply/hotels').send({
      name: hotelName, propertyType: 'HOTEL', starRating: 5, city: 'Dubai', countryCode: 'AE', contentStatus: 'COMPLETE',
    }).expect(201)
    hotelId = hotel.body.data.id
    const audited = await admin.patch(`/api/v1/supply/hotels/${hotelId}`).set('x-request-id', `${suffix}-hotel`).send({ contentStatus: 'COMPLETE' }).expect(200)
    expect(audited.body.data.contentStatus).toBe('COMPLETE')
    const room = await admin.post(`/api/v1/supply/hotels/${hotelId}/rooms`).send({
      name: roomName, code: 'DLX', maxAdults: 2, maxChildren: 0, maxOccupancy: 2, isActive: true,
    }).expect(201)
    roomId = room.body.data.id
    const board = await admin.post('/api/v1/supply/board-bases').send({ code: 'BB', name: boardName }).expect(201)
    boardId = board.body.data.id
    const mapping = await admin.post('/api/v1/supply/mappings/hotels').send({
      supplierId, hotelId, supplierHotelId: `${suffix}-hotel`,
    }).expect(201)
    mappingId = mapping.body.data.id
    await admin.post(`/api/v1/supply/mappings/hotels/${mappingId}/approve`).expect(201)
    const roomMapping = await admin.post(`/api/v1/supply/mappings/hotels/${mappingId}/rooms`).send({
      supplierRoomId: `${suffix}-room`, roomTypeId: roomId,
    }).expect(201)
    roomMappingId = roomMapping.body.data.id
    await admin.post(`/api/v1/supply/mappings/hotels/${mappingId}/rooms/${roomMappingId}/approve`).expect(201)
    const contract = await admin.post('/api/v1/supply/contracts').send({
      supplierId, supplierHotelMappingId: mappingId, code: `${suffix}-C`, validFrom: day(0), validTo: day(60), settlementCurrency: 'AED',
    }).expect(201)
    contractId = contract.body.data.id
    await admin.patch(`/api/v1/supply/contracts/${contractId}`).send({ status: 'ACTIVE' }).expect(200)
    const plan = await admin.post('/api/v1/supply/rate-plans').send({
      contractId, roomTypeId: roomId, boardBasisId: boardId, code: `${suffix}-FLEX`, occupancy: 2, currency: 'AED',
      refundable: true, minStay: 1, releaseDays: 0,
    }).expect(201)
    ratePlanId = plan.body.data.id
    await admin.patch(`/api/v1/supply/rate-plans/${ratePlanId}`).send({ status: 'ACTIVE' }).expect(200)
    await admin.post('/api/v1/supply/daily-rates/bulk').send({ rows: nights.map((stayDate) => ({
      ratePlanId, stayDate, occupancy: 2, amountMinor: String(nightMinor), amountBasis: 'SELL', currency: 'AED',
    })) }).expect(201)
    await admin.post('/api/v1/supply/availability/bulk').send({ rows: nights.map((stayDate) => ({
      ratePlanId, stayDate, allotment: 4, sold: 0, stopSell: false, minStay: 1,
    })) }).expect(201)
  }

  function search(cookie = agentCookie, patch: Record<string, unknown> = {}) {
    return api(cookie).post('/api/v1/agent/search').send(searchBody(patch))
  }

  async function restoreCommercial() {
    const admin = api(ownerCookie)
    await prisma.supplierHotelMapping.update({ where: { id: mappingId }, data: { status: 'MAPPED' } })
    await prisma.supplierRoomMapping.update({ where: { id: roomMappingId }, data: { status: 'MAPPED' } })
    await admin.patch(`/api/v1/supply/suppliers/${supplierId}`).send({ status: 'ACTIVE' }).expect(200)
    await admin.patch(`/api/v1/supply/hotels/${hotelId}`).send({ contentStatus: 'COMPLETE' }).expect(200)
    await admin.patch(`/api/v1/supply/hotels/${hotelId}/rooms/${roomId}`).send({ isActive: true }).expect(200)
    await admin.patch(`/api/v1/supply/board-bases/${boardId}`).send({ isActive: true }).expect(200)
    await admin.patch(`/api/v1/supply/contracts/${contractId}`).send({ status: 'ACTIVE', validFrom: day(0), validTo: day(60) }).expect(200)
    await admin.patch(`/api/v1/supply/rate-plans/${ratePlanId}`).send({ status: 'ACTIVE', minStay: 1, releaseDays: 0 }).expect(200)
    await admin.post('/api/v1/supply/daily-rates/bulk').send({ rows: nights.map((stayDate) => ({
      ratePlanId, stayDate, occupancy: 2, amountMinor: String(nightMinor), amountBasis: 'SELL', currency: 'AED',
    })) })
    await admin.post('/api/v1/supply/availability/bulk').send({ rows: nights.map((stayDate) => ({
      ratePlanId, stayDate, allotment: 4, sold: 0, stopSell: false, minStay: 1,
    })) })
  }

  it('certifies the admin chain and returns the same hotel, room, board and AED total', async () => {
    const admin = api(ownerCookie)
    expect((await admin.get(`/api/v1/supply/suppliers/${supplierId}`)).body.data).toMatchObject({ id: supplierId, status: 'ACTIVE', tenantId })
    expect((await admin.get(`/api/v1/supply/hotels/${hotelId}`)).body.data).toMatchObject({ id: hotelId, name: hotelName, city: 'Dubai', contentStatus: 'COMPLETE' })
    expect((await admin.get(`/api/v1/supply/hotels/${hotelId}/rooms/${roomId}`)).body.data).toMatchObject({ id: roomId, name: roomName, isActive: true })
    expect((await admin.get('/api/v1/supply/board-bases')).body.data).toEqual(expect.arrayContaining([expect.objectContaining({ id: boardId, name: boardName })]))
    expect((await admin.get(`/api/v1/supply/mappings/hotels/${mappingId}`)).body.data).toMatchObject({ id: mappingId, status: 'MAPPED', hotelId, supplierId })
    expect((await admin.get(`/api/v1/supply/mappings/hotels/${mappingId}/rooms/${roomMappingId}`)).body.data).toMatchObject({ id: roomMappingId, status: 'MAPPED', roomTypeId: roomId })
    expect((await admin.get(`/api/v1/supply/contracts/${contractId}`)).body.data).toMatchObject({ id: contractId, status: 'ACTIVE', settlementCurrency: 'AED', supplierId })
    expect((await admin.get(`/api/v1/supply/rate-plans/${ratePlanId}`)).body.data).toMatchObject({
      id: ratePlanId, contractId, roomTypeId: roomId, boardBasisId: boardId, status: 'ACTIVE', currency: 'AED',
    })
    for (const stayDate of nights) {
      const sellable = await admin.post('/api/v1/supply/sellability').send({ ratePlanId, stayDate, occupancy: 2 }).expect(201)
      expect(sellable.body.data).toMatchObject({ eligible: true, status: 'ELIGIBLE_FOR_FUTURE_SEARCH', reasons: [] })
    }
    await expect(prisma.auditEvent.findFirst({ where: { tenantId, entityId: hotelId, action: 'supply.hotel.updated' } })).resolves.toMatchObject({
      payload: { outcome: 'allowed', requestId: `${suffix}-hotel` },
    })

    const response = await search().expect(201)
    expect(response.body.data.status).toBe('available')
    expect(response.body.data.hotels).toHaveLength(1)
    const hotel = response.body.data.hotels[0]
    const room = hotel.rooms[0]
    const rate = room.rates[0]
    expect(hotel).toMatchObject({ hotelId, name: hotelName, destination: 'Dubai', supplierId })
    expect(room).toMatchObject({ roomTypeId: roomId, name: roomName })
    expect(rate).toMatchObject({
      tenantId, supplierId, hotelId, canonicalHotelId: hotelId, roomTypeId: roomId, canonicalRoomTypeId: roomId,
      boardBasisId: boardId, boardBasisName: boardName, ratePlanId, contractId,
    })
    expect(rate.total).toEqual({ amountMinor: stayMinor, currency: 'AED' })
    expect(rate.sellAmountMinor).toBe(stayMinor)
    expect(Number.isSafeInteger(rate.sellAmountMinor)).toBe(true)
    expect(rate.occupancy).toMatchObject({ rooms: 1, adults: 2, children: 0, childAges: [] })
    expect(response.body.data.request).toMatchObject({ destination: 'Dubai', checkIn, checkOut, rooms: 1, adults: 2, children: 0, currency: 'AED' })

    const recheck = await api(agentCookie).post('/api/v1/agent/rates/recheck').send({
      offerId: rate.offerId, searchId: response.body.data.searchId, expectedCurrency: 'AED', expectedSellAmountMinor: stayMinor,
    }).expect(200)
    expect(recheck.body.data).toMatchObject({ offerId: rate.offerId, status: 'rechecked', currency: 'AED', sellAmountMinor: stayMinor })

    const prebook = await api(ownerCookie).post('/api/v1/agent/prebook').send({
      inventoryHoldId: 'hold-not-used-while-disabled', idempotencyKey: `${suffix}-prebook`, adults: 2, children: 0, childAges: [], leadGuest: { firstName: 'Test', lastName: 'Guest' },
    }).expect(503)
    expect(prebook.body.data.status).toBe('booking_unavailable')
    const booking = await api(ownerCookie).post('/api/v1/agent/bookings').send({
      bookingId: 'booking-not-used-while-disabled',
    }).expect(503)
    expect(booking.body.data.status).toBe('booking_unavailable')
  })

  it('rejects an agent without search permission and a cross-tenant header', async () => {
    await api(deniedCookie).post('/api/v1/agent/search').send(searchBody()).expect(403)
    await api(agentCookie, otherTenantId).post('/api/v1/agent/search').send(searchBody()).expect(403)
    await api(ownerCookie, otherTenantId).get('/api/v1/agent/finance/summary').expect(403)
    await api(ownerCookie, otherTenantId).get('/api/v1/agent/audit').expect(403)
    await api(agentCookie, otherTenantId).post('/api/v1/agent/prebook').send({
      hotelId, rateId: 'foreign-rate', idempotencyKey: `${suffix}-foreign-prebook`, totalMinor: stayMinor, currency: 'AED',
    }).expect(403)
    await api(agentCookie, otherTenantId).post('/api/v1/agent/bookings').send({
      hotelId, rateId: 'foreign-rate', idempotencyKey: `${suffix}-foreign-book`, totalMinor: stayMinor, currency: 'AED',
    }).expect(403)
    const ownTenant = await request(app.getHttpServer()).post('/api/v1/agent/search').set('Cookie', ownerCookie).send(searchBody()).expect(201)
    expect(ownTenant.body.data.hotels.some((hotel: { hotelId: string }) => hotel.hotelId === hotelId)).toBe(true)
    const other = await api(otherCookie, otherTenantId).post('/api/v1/agent/search').send(searchBody()).expect(201)
    expect(other.body.data.hotels).toEqual([])
    expect(other.body.data.status).toBe('provider_unavailable')
  })

  it('returns provider unavailable when the tenant has no supplier source', async () => {
    const response = await api(emptyCookie, emptyTenantId).post('/api/v1/agent/search').send(searchBody()).expect(201)
    expect(response.body.data).toMatchObject({ status: 'provider_unavailable', hotels: [], total: 0 })
  })

  it('hides the hotel when commercial gates fail and restores it', async () => {
    const admin = api(ownerCookie)
    const cases: Array<[string, () => Promise<unknown>]> = [
      ['supplier suspended', () => admin.patch(`/api/v1/supply/suppliers/${supplierId}`).send({ status: 'SUSPENDED' }).expect(200)],
      ['hotel suspended', () => admin.patch(`/api/v1/supply/hotels/${hotelId}`).send({ contentStatus: 'SUSPENDED' }).expect(200)],
      ['room inactive', () => admin.patch(`/api/v1/supply/hotels/${hotelId}/rooms/${roomId}`).send({ isActive: false }).expect(200)],
      ['board inactive', () => admin.patch(`/api/v1/supply/board-bases/${boardId}`).send({ isActive: false }).expect(200)],
      ['contract inactive', () => admin.patch(`/api/v1/supply/contracts/${contractId}`).send({ status: 'SUSPENDED' }).expect(200)],
      ['contract expired', () => admin.patch(`/api/v1/supply/contracts/${contractId}`).send({ status: 'EXPIRED' }).expect(200)],
      ['rate plan inactive', () => admin.patch(`/api/v1/supply/rate-plans/${ratePlanId}`).send({ status: 'SUSPENDED' }).expect(200)],
      ['minimum stay', () => admin.patch(`/api/v1/supply/rate-plans/${ratePlanId}`).send({ minStay: 5 }).expect(200)],
      ['release days', () => admin.patch(`/api/v1/supply/rate-plans/${ratePlanId}`).send({ releaseDays: 40 }).expect(200)],
    ]
    for (const [name, mutate] of cases) {
      await mutate()
      const hidden = await search().expect(201)
      expect({ case: name, hotels: hidden.body.data.hotels }).toEqual({ case: name, hotels: [] })
      await restoreCommercial()
      const restored = await search().expect(201)
      expect({ case: name, hotels: restored.body.data.hotels.length }).toEqual({ case: name, hotels: 1 })
    }
  }, 30_000) // nine cases, each a supply write plus two searches; it ran within ~10% of the 5s default (same on origin/main), so the limit is explicit

  it('excludes pending and rejected mappings', async () => {
    const admin = api(ownerCookie)
    await admin.post(`/api/v1/supply/mappings/hotels/${mappingId}/rooms/${roomMappingId}/reopen`).expect(201)
    let hidden = await search().expect(201)
    expect(hidden.body.data.hotels).toEqual([])
    await admin.post(`/api/v1/supply/mappings/hotels/${mappingId}/rooms/${roomMappingId}/reject`).expect(201)
    hidden = await search().expect(201)
    expect(hidden.body.data.hotels).toEqual([])
    await admin.post(`/api/v1/supply/mappings/hotels/${mappingId}/rooms/${roomMappingId}/reopen`).expect(201)
    await admin.post(`/api/v1/supply/mappings/hotels/${mappingId}/rooms/${roomMappingId}/approve`).expect(201)
    await admin.post(`/api/v1/supply/mappings/hotels/${mappingId}/rooms/${roomMappingId}/reopen`).expect(201)
    await admin.post(`/api/v1/supply/mappings/hotels/${mappingId}/reopen`).expect(201)
    hidden = await search().expect(201)
    expect(hidden.body.data.hotels).toEqual([])
    await admin.post(`/api/v1/supply/mappings/hotels/${mappingId}/reject`).expect(201)
    hidden = await search().expect(201)
    expect(hidden.body.data.hotels).toEqual([])
    await restoreCommercial()
  })

  it('drops a stay that is missing a rate or availability, stopped, or depleted', async () => {
    const admin = api(ownerCookie)
    const found = await search().expect(201)
    const offer = found.body.data.hotels[0].rooms[0].rates[0]
    await prisma.dailyRate.deleteMany({ where: { ratePlanId, stayDate: new Date(`${nights[1]}T00:00:00.000Z`) } })
    expect((await search()).body.data.hotels).toEqual([])
    const missingRate = await api(agentCookie).post('/api/v1/agent/rates/recheck').send({
      offerId: offer.offerId, searchId: found.body.data.searchId, expectedCurrency: 'AED', expectedSellAmountMinor: stayMinor,
    })
    expect(missingRate.body.data.status).toBe('unavailable')
    await restoreCommercial()

    await prisma.dailyAvailability.deleteMany({ where: { ratePlanId, stayDate: new Date(`${nights[1]}T00:00:00.000Z`) } })
    expect((await search()).body.data.hotels).toEqual([])
    await restoreCommercial()

    await admin.post('/api/v1/supply/availability').send({ ratePlanId, stayDate: nights[0], allotment: 4, sold: 0, stopSell: true, minStay: 1 }).expect(201)
    const stopped = await search().expect(201)
    expect(stopped.body.data.hotels).toEqual([])
    const stoppedRecheck = await api(agentCookie).post('/api/v1/agent/rates/recheck').send({
      offerId: offer.offerId, searchId: found.body.data.searchId, expectedCurrency: 'AED', expectedSellAmountMinor: stayMinor,
    })
    expect(stoppedRecheck.body.data.status).toBe('unavailable')
    await restoreCommercial()

    await admin.post('/api/v1/supply/availability').send({ ratePlanId, stayDate: nights[0], allotment: 0, sold: 0, stopSell: false, minStay: 1 }).expect(201)
    expect((await search()).body.data.hotels).toEqual([])
    await restoreCommercial()
  })

  it('rejects unsupported occupancy and a currency that does not match the contract', async () => {
    expect((await search(agentCookie, { adults: 3 })).body.data.hotels).toEqual([])
    expect((await search(agentCookie, { currency: 'USD' })).body.data.hotels).toEqual([])
    expect((await search()).body.data.hotels).toHaveLength(1)
  })

  it('returns price_changed without replacing the quoted amount', async () => {
    const found = await search().expect(201)
    const offer = found.body.data.hotels[0].rooms[0].rates[0]
    expect(offer.sellAmountMinor).toBe(stayMinor)
    await api(ownerCookie).post('/api/v1/supply/daily-rates').send({
      ratePlanId, stayDate: nights[0], occupancy: 2, amountMinor: String(nightMinor + 100), amountBasis: 'SELL', currency: 'AED',
    }).expect(201)
    const changed = await api(agentCookie).post('/api/v1/agent/rates/recheck').send({
      offerId: offer.offerId, searchId: found.body.data.searchId, expectedCurrency: 'AED', expectedSellAmountMinor: offer.sellAmountMinor,
    }).expect(409)
    expect(changed.body.data).toMatchObject({ status: 'price_changed', currency: 'AED', sellAmountMinor: stayMinor + 100 })
    expect(offer.sellAmountMinor).toBe(stayMinor)
    await restoreCommercial()
    const accepted = await api(agentCookie).post('/api/v1/agent/rates/recheck').send({
      offerId: offer.offerId, searchId: found.body.data.searchId, expectedCurrency: 'AED', expectedSellAmountMinor: stayMinor,
    }).expect(200)
    expect(accepted.body.data.status).toBe('rechecked')
  })

  it('expires an offer and reports a revoked mapping as unavailable', async () => {
    const previous = process.env.AGENT_OFFER_TTL_MS
    process.env.AGENT_OFFER_TTL_MS = '1000'
    try {
      const found = await search(agentCookie, { checkIn: day(20), checkOut: day(23) }).expect(201)
      expect(found.body.data.hotels).toHaveLength(0)
    } finally {
      if (previous === undefined) delete process.env.AGENT_OFFER_TTL_MS
      else process.env.AGENT_OFFER_TTL_MS = previous
    }

    const admin = api(ownerCookie)
    await admin.post('/api/v1/supply/daily-rates/bulk').send({ rows: [day(20), day(21), day(22)].map((stayDate) => ({
      ratePlanId, stayDate, occupancy: 2, amountMinor: String(nightMinor), amountBasis: 'SELL', currency: 'AED',
    })) }).expect(201)
    await admin.post('/api/v1/supply/availability/bulk').send({ rows: [day(20), day(21), day(22)].map((stayDate) => ({
      ratePlanId, stayDate, allotment: 4, sold: 0, stopSell: false, minStay: 1,
    })) }).expect(201)
    process.env.AGENT_OFFER_TTL_MS = '1000'
    try {
      const found = await search(agentCookie, { checkIn: day(20), checkOut: day(23) }).expect(201)
      expect(found.body.data.hotels).toHaveLength(1)
      const offer = found.body.data.hotels[0].rooms[0].rates[0]
      await new Promise((resolve) => setTimeout(resolve, 1100))
      const expired = await api(agentCookie).post('/api/v1/agent/rates/recheck').send({
        offerId: offer.offerId, searchId: found.body.data.searchId, expectedCurrency: 'AED', expectedSellAmountMinor: stayMinor,
      }).expect(410)
      expect(expired.body.data.status).toBe('offer_expired')
    } finally {
      delete process.env.AGENT_OFFER_TTL_MS
    }

    const current = await search().expect(201)
    const offer = current.body.data.hotels[0].rooms[0].rates[0]
    await admin.post(`/api/v1/supply/mappings/hotels/${mappingId}/rooms/${roomMappingId}/reopen`).expect(201)
    await admin.post(`/api/v1/supply/mappings/hotels/${mappingId}/rooms/${roomMappingId}/reject`).expect(201)
    const revoked = await api(agentCookie).post('/api/v1/agent/rates/recheck').send({
      offerId: offer.offerId, searchId: current.body.data.searchId, expectedCurrency: 'AED', expectedSellAmountMinor: stayMinor,
    }).expect(409)
    expect(revoked.body.data.status).toBe('unavailable')
    await restoreCommercial()
  })
})
