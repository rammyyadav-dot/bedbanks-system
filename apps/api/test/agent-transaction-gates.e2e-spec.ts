import { INestApplication, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import * as cookieParser from 'cookie-parser'
import * as request from 'supertest'
import { PrismaClient } from '@prisma/client'
import { AppModule } from '../src/app.module'
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor'
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter'
import { hashPassword } from '../src/auth/utils/password'
import { SUPPLIER_ADAPTER } from '../src/agent/supplier.port'
import { AGENT_PERMISSION_KEYS } from '../src/agent/agent-permissions'

const prisma = new PrismaClient()

describe('Agent transaction gates, effective capabilities and booking pages', () => {
  const suffix = `gates-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const password = 'agent-transaction-gate-password'
  const previousBooking = process.env.BOOKING_ENABLED
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
  const checkIn = day(21)
  const checkOut = day(23)
  const nights = [day(21), day(22)]
  let app: INestApplication
  let tenantId: string
  let otherTenantId: string
  let emptyTenantId: string
  let ownerId: string
  let searcherId: string
  let financeId: string
  let deniedId: string
  let otherUserId: string
  let emptyOwnerId: string
  let platformUserId: string
  let ownerRoleId: string
  let searcherRoleId: string
  let otherRoleId: string
  let deniedRoleId: string
  let platformRoleId = ''
  let platformPermissionId = ''
  let hotelId: string
  let ratePlanId: string
  let ownerCookie = ''
  let searcherCookie = ''
  let financeCookie = ''
  let deniedCookie = ''
  let otherCookie = ''
  let emptyCookie = ''
  let platformCookie = ''

  beforeAll(async () => {
    delete process.env.BOOKING_ENABLED
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
      prisma.user.create({ data: { email: `${suffix}-search@example.test`, passwordHash } }),
      prisma.user.create({ data: { email: `${suffix}-finance@example.test`, passwordHash } }),
      prisma.user.create({ data: { email: `${suffix}-denied@example.test`, passwordHash } }),
      prisma.user.create({ data: { email: `${suffix}-other@example.test`, passwordHash } }),
      prisma.user.create({ data: { email: `${suffix}-empty@example.test`, passwordHash } }),
      prisma.user.create({ data: { email: `${suffix}-platform@example.test`, passwordHash } }),
    ])
    ;[ownerId, searcherId, financeId, deniedId, otherUserId, emptyOwnerId, platformUserId] = users.map((user) => user.id)
    const permissionKeys = [
      'supply.hotels.read', 'supply.hotels.manage', 'supply.rooms.read', 'supply.rooms.manage',
      'supply.rates.read', 'supply.rates.manage', 'supply.contracts.read', 'supply.contracts.manage',
      'supply.availability.read', 'supply.availability.manage', 'supply.suppliers.read', 'supply.suppliers.manage',
      'supply.mappings.read', 'supply.mappings.manage', 'hotel.search', 'booking.prebook', 'booking.create',
      'booking.cancel', 'booking.read', 'finance.read', 'audit.read', 'booking.reconcile',
    ]
    const permissions = await Promise.all(permissionKeys.map((key) => prisma.permission.upsert({ where: { key }, update: {}, create: { key, description: key } })))
    const byKey = new Map(permissions.map((permission) => [permission.key, permission.id]))
    const [ownerRole, searcherRole, otherRole, deniedRole] = await Promise.all([
      prisma.role.create({ data: { tenantId, name: `${suffix}-owner` } }),
      prisma.role.create({ data: { tenantId, name: `${suffix}-search` } }),
      prisma.role.create({ data: { tenantId: otherTenantId, name: `${suffix}-other` } }),
      prisma.role.create({ data: { tenantId, name: `${suffix}-denied` } }),
    ])
    ownerRoleId = ownerRole.id
    searcherRoleId = searcherRole.id
    otherRoleId = otherRole.id
    deniedRoleId = deniedRole.id
    await prisma.rolePermission.createMany({ data: permissions.filter((permission) => permission.key.startsWith('supply.')).map((permission) => ({ roleId: ownerRoleId, permissionId: permission.id })) })
    await prisma.rolePermission.create({ data: { roleId: searcherRoleId, permissionId: byKey.get('hotel.search')! } })
    await prisma.rolePermission.create({ data: { roleId: otherRoleId, permissionId: byKey.get('hotel.search')! } })
    await prisma.membership.createMany({ data: [
      { tenantId, userId: ownerId, role: 'owner' },
      { tenantId, userId: searcherId, role: 'agent' },
      { tenantId, userId: financeId, role: 'finance' },
      { tenantId, userId: deniedId, role: 'staff' },
      { tenantId: otherTenantId, userId: otherUserId, role: 'agent' },
      { tenantId: emptyTenantId, userId: emptyOwnerId, role: 'owner' },
    ] })
    await prisma.userRole.createMany({ data: [
      { tenantId, userId: ownerId, roleId: ownerRoleId },
      { tenantId, userId: searcherId, roleId: searcherRoleId },
      { tenantId, userId: deniedId, roleId: deniedRoleId },
      { tenantId: otherTenantId, userId: otherUserId, roleId: otherRoleId },
    ] })
    platformPermissionId = `perm-${suffix}`
    platformRoleId = `role-${suffix}`
    await prisma.platformPermission.create({ data: { id: platformPermissionId, key: `e2e.platform.${suffix}`, description: 'isolated platform grant' } })
    await prisma.platformRole.create({ data: { id: platformRoleId, name: `e2e-platform-${suffix}` } })
    await prisma.platformRolePermission.create({ data: { roleId: platformRoleId, permissionId: platformPermissionId } })
    await prisma.platformRoleAssignment.create({ data: { userId: platformUserId, roleId: platformRoleId } })

    const module = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = module.createNestApplication()
    app.use(cookieParser())
    app.setGlobalPrefix('api/v1')
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
    app.useGlobalFilters(new HttpExceptionFilter())
    app.useGlobalInterceptors(new ResponseInterceptor())
    await app.init()
    ownerCookie = await login(`${suffix}-owner@example.test`)
    searcherCookie = await login(`${suffix}-search@example.test`)
    financeCookie = await login(`${suffix}-finance@example.test`)
    deniedCookie = await login(`${suffix}-denied@example.test`)
    otherCookie = await login(`${suffix}-other@example.test`)
    emptyCookie = await login(`${suffix}-empty@example.test`)
    platformCookie = await login(`${suffix}-platform@example.test`)
    await seedCommercial()
  }, 120000)

  afterAll(async () => {
    if (previousBooking === undefined) delete process.env.BOOKING_ENABLED
    else process.env.BOOKING_ENABLED = previousBooking
    await app?.close()
    const userIds = [ownerId, searcherId, financeId, deniedId, otherUserId, emptyOwnerId, platformUserId].filter(Boolean)
    const tenantIds = [tenantId, otherTenantId, emptyTenantId].filter(Boolean)
    if (tenantIds.length) {
      const bookings = await prisma.booking.findMany({ where: { tenantId: { in: tenantIds } }, select: { id: true } })
      const bookingIds = bookings.map((booking) => booking.id)
      if (bookingIds.length) await prisma.cancellation.deleteMany({ where: { bookingId: { in: bookingIds } } })
      await prisma.booking.deleteMany({ where: { tenantId: { in: tenantIds } } })
      await prisma.supplierMutation.deleteMany({ where: { tenantId: { in: tenantIds } } })
      await prisma.inventoryHoldNight.deleteMany({ where: { tenantId: { in: tenantIds } } })
      await prisma.inventoryHold.deleteMany({ where: { tenantId: { in: tenantIds } } })
      await prisma.ledgerEntry.deleteMany({ where: { tenantId: { in: tenantIds } } })
      await prisma.wallet.deleteMany({ where: { tenantId: { in: tenantIds } } })
      await prisma.auditEvent.deleteMany({ where: { OR: [{ tenantId: { in: tenantIds } }, { userId: { in: userIds } }] } })
      await prisma.dailyRate.deleteMany({ where: { tenantId: { in: tenantIds } } })
      await prisma.dailyAvailability.deleteMany({ where: { tenantId: { in: tenantIds } } })
      await prisma.ratePlan.deleteMany({ where: { tenantId: { in: tenantIds } } })
      await prisma.contract.deleteMany({ where: { tenantId: { in: tenantIds } } })
      await prisma.supplierRoomMapping.deleteMany({ where: { tenantId: { in: tenantIds } } })
      await prisma.supplierHotelMapping.deleteMany({ where: { tenantId: { in: tenantIds } } })
      await prisma.roomType.deleteMany({ where: { hotel: { tenantId: { in: tenantIds } } } })
      await prisma.hotel.deleteMany({ where: { tenantId: { in: tenantIds } } })
      await prisma.boardBasis.deleteMany({ where: { tenantId: { in: tenantIds } } })
      await prisma.supplier.deleteMany({ where: { tenantId: { in: tenantIds } } })
    }
    if (platformUserId) await prisma.platformRoleAssignment.deleteMany({ where: { userId: platformUserId } })
    if (platformRoleId) {
      await prisma.platformRolePermission.deleteMany({ where: { roleId: platformRoleId } })
      await prisma.platformRole.deleteMany({ where: { id: platformRoleId } })
    }
    if (platformPermissionId) await prisma.platformPermission.deleteMany({ where: { id: platformPermissionId } })
    if (userIds.length) {
      await prisma.userRole.deleteMany({ where: { userId: { in: userIds } } })
      await prisma.membership.deleteMany({ where: { userId: { in: userIds } } })
      await prisma.session.deleteMany({ where: { userId: { in: userIds } } })
      await prisma.user.deleteMany({ where: { id: { in: userIds } } })
    }
    const roleIds = [ownerRoleId, searcherRoleId, otherRoleId, deniedRoleId].filter(Boolean)
    if (roleIds.length) {
      await prisma.rolePermission.deleteMany({ where: { roleId: { in: roleIds } } })
      await prisma.role.deleteMany({ where: { id: { in: roleIds } } })
    }
    if (tenantIds.length) await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } })
    await prisma.$disconnect()
  }, 120000)

  async function login(email: string) {
    const response = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', 'http://localhost:3001').send({ email, password }).expect(200)
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

  async function seedCommercial() {
    const admin = api(ownerCookie)
    const supplier = await admin.post('/api/v1/supply/suppliers').send({
      type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${suffix} Supplier`, displayName: 'Gate Supply', countryCode: 'AE', defaultCurrency: 'AED',
    }).expect(201)
    const hotel = await admin.post('/api/v1/supply/hotels').send({
      name: `${suffix} Hotel`, propertyType: 'HOTEL', starRating: 4, city: 'Dubai', countryCode: 'AE',
    }).expect(201)
    hotelId = hotel.body.data.id
    await prisma.hotel.update({ where: { id: hotelId }, data: { contentStatus: 'COMPLETE' } }) // fixture: publication is maker-checker (ADR 0022)
    const room = await admin.post(`/api/v1/supply/hotels/${hotelId}/rooms`).send({
      name: 'King', code: 'KNG', maxAdults: 2, maxChildren: 0, maxOccupancy: 2, isActive: true,
    }).expect(201)
    const board = await admin.post('/api/v1/supply/board-bases').send({ code: 'RO', name: `${suffix} Room only` }).expect(201)
    const mapping = await admin.post('/api/v1/supply/mappings/hotels').send({ supplierId: supplier.body.data.id, hotelId, supplierHotelId: `${suffix}-hotel` }).expect(201)
    await admin.post(`/api/v1/supply/mappings/hotels/${mapping.body.data.id}/approve`).expect(201)
    const roomMapping = await admin.post(`/api/v1/supply/mappings/hotels/${mapping.body.data.id}/rooms`).send({ supplierRoomId: `${suffix}-room`, roomTypeId: room.body.data.id }).expect(201)
    await admin.post(`/api/v1/supply/mappings/hotels/${mapping.body.data.id}/rooms/${roomMapping.body.data.id}/approve`).expect(201)
    const contract = await admin.post('/api/v1/supply/contracts').send({
      supplierId: supplier.body.data.id, supplierHotelMappingId: mapping.body.data.id, code: `${suffix}-C`.slice(0, 40), validFrom: day(0), validTo: day(60), settlementCurrency: 'AED',
    }).expect(201)
    await admin.patch(`/api/v1/supply/contracts/${contract.body.data.id}`).send({ status: 'ACTIVE' }).expect(200)
    const plan = await admin.post('/api/v1/supply/rate-plans').send({
      contractId: contract.body.data.id, roomTypeId: room.body.data.id, boardBasisId: board.body.data.id, code: `${suffix}-FLEX`.slice(0, 40), occupancy: 2, currency: 'AED', refundable: true, minStay: 1, releaseDays: 0,
    }).expect(201)
    ratePlanId = plan.body.data.id
    await admin.patch(`/api/v1/supply/rate-plans/${ratePlanId}`).send({ status: 'ACTIVE' }).expect(200)
    await admin.post('/api/v1/supply/daily-rates/bulk').send({ rows: nights.map((stayDate) => ({ ratePlanId, stayDate, occupancy: 2, amountMinor: '25000', amountBasis: 'SELL', currency: 'AED' })) }).expect(201)
    await admin.post('/api/v1/supply/availability/bulk').send({ rows: nights.map((stayDate) => ({ ratePlanId, stayDate, allotment: 4, sold: 0, stopSell: false, minStay: 1 })) }).expect(201)
  }

  function holdBody(offerId = 'offer-missing', searchId = 'search-missing', amount = 50000) {
    return request(app.getHttpServer()).post(`/api/v1/agent/offers/${encodeURIComponent(offerId)}/hold`).set('Cookie', ownerCookie).set('x-fbeds-tenant-id', tenantId).send({
      searchId, expectedCurrency: 'AED', expectedSellAmountMinor: amount, idempotencyKey: `${suffix}-hold`.slice(0, 40),
    })
  }

  async function effects() {
    const [holds, nightsHeld, bookings, mutations, ledger, availability] = await Promise.all([
      prisma.inventoryHold.count({ where: { tenantId } }),
      prisma.inventoryHoldNight.count({ where: { tenantId } }),
      prisma.booking.count({ where: { tenantId } }),
      prisma.supplierMutation.count({ where: { tenantId } }),
      prisma.ledgerEntry.count({ where: { tenantId } }),
      prisma.dailyAvailability.aggregate({ where: { ratePlanId }, _sum: { held: true } }),
    ])
    return { holds, nights: nightsHeld, bookings, mutations, ledger, held: availability._sum.held ?? 0 }
  }

  async function searchOffer() {
    const response = await api(searcherCookie).post('/api/v1/agent/search').send({
      destination: 'Dubai', checkIn, checkOut, rooms: 1, adults: 2, children: 0, childAges: [], nationality: 'IN', currency: 'AED',
    }).expect(201)
    expect(response.body.data.status).toBe('available')
    const rate = response.body.data.hotels[0].rooms[0].rates[0]
    return { offerId: rate.offerId as string, searchId: response.body.data.searchId as string, sellAmountMinor: rate.sellAmountMinor as number }
  }

  it('CTX-05 unauthenticated context is rejected', async () => {
    await request(app.getHttpServer()).get('/api/v1/agent/context').expect(401)
  })

  it('CTX-01/02/07 a caller receives only the grants for the selected membership', async () => {
    const searcher = await api(searcherCookie).get('/api/v1/agent/context').expect(200)
    expect(searcher.body.data.capabilities).toEqual(['hotel.search'])
    const owner = await api(ownerCookie).get('/api/v1/agent/context').expect(200)
    expect(owner.body.data.capabilities).toEqual([...AGENT_PERMISSION_KEYS])
    const finance = await api(financeCookie).get('/api/v1/agent/context').expect(200)
    expect(finance.body.data.capabilities).toEqual(['finance.read'])
    const bare = await request(app.getHttpServer()).get('/api/v1/agent/context').set('Cookie', searcherCookie).expect(200)
    expect(bare.body.data.capabilities).toEqual([])
    expect(bare.body.data.memberships.map((membership: { tenantId: string }) => membership.tenantId)).toEqual([tenantId])
  })

  it('CTX-03/04 a tenant the caller does not belong to fails closed', async () => {
    await api(searcherCookie, otherTenantId).get('/api/v1/agent/context').expect(403)
    await api(ownerCookie, emptyTenantId).get('/api/v1/agent/context').expect(403)
    const other = await api(otherCookie, otherTenantId).get('/api/v1/agent/context').expect(200)
    expect(other.body.data.capabilities).toEqual(['hotel.search'])
    expect(other.body.data.capabilities).not.toContain('booking.create')
  })

  it('CTX-06 a platform assignment does not create tenant capabilities', async () => {
    const bare = await request(app.getHttpServer()).get('/api/v1/agent/context').set('Cookie', platformCookie).expect(200)
    expect(bare.body.data.memberships).toEqual([])
    expect(bare.body.data.capabilities).toEqual([])
    await request(app.getHttpServer()).get('/api/v1/agent/context').set('Cookie', platformCookie).set('x-fbeds-tenant-id', tenantId).expect(403)
    expect(await prisma.membership.count({ where: { userId: platformUserId } })).toBe(0)
  })

  it('CTX-08/09/10 search follows the formal grant and a removal is denied and audited', async () => {
    const allowed = await api(searcherCookie).post('/api/v1/agent/search').send({
      destination: 'Dubai', checkIn, checkOut, rooms: 1, adults: 2, children: 0, childAges: [], nationality: 'IN', currency: 'AED',
    }).expect(201)
    expect(allowed.body.data.status).toBe('available')
    await prisma.rolePermission.deleteMany({ where: { roleId: searcherRoleId } })
    const removed = await api(searcherCookie).get('/api/v1/agent/context').expect(200)
    expect(removed.body.data.capabilities).toEqual([])
    await api(searcherCookie).post('/api/v1/agent/search').set('x-request-id', `${suffix}-deny`).send({
      destination: 'Dubai', checkIn, checkOut, rooms: 1, adults: 2, children: 0, childAges: [], nationality: 'IN', currency: 'AED',
    }).expect(403)
    await expect(prisma.auditEvent.findFirst({ where: { tenantId, userId: searcherId, action: 'permission.denied', entityId: 'hotel.search' } })).resolves.toMatchObject({
      entityType: 'permission', payload: { tenantId },
    })
    await prisma.rolePermission.create({ data: { roleId: searcherRoleId, permissionId: (await prisma.permission.findUniqueOrThrow({ where: { key: 'hotel.search' } })).id } })
  })

  it('HOLD-01..05 and HOLD-11..14 reject every non-exact booking flag with zero mutation', async () => {
    const before = await effects()
    for (const value of [undefined, 'false', '', 'TRUE', '1']) {
      if (value === undefined) delete process.env.BOOKING_ENABLED
      else process.env.BOOKING_ENABLED = value
      const response = await holdBody().expect(503)
      expect(response.body.data.status).toBe('booking_unavailable')
      const again = await holdBody().expect(503)
      expect(again.body.data.status).toBe('booking_unavailable')
    }
    expect(await effects()).toEqual(before)
    delete process.env.BOOKING_ENABLED
  })

  it('HOLD-07/08/09/10 fail closed for unauthorized, foreign, expired and unavailable offers', async () => {
    process.env.BOOKING_ENABLED = 'true'
    try {
      const before = await effects()
      await request(app.getHttpServer()).post('/api/v1/agent/offers/missing-offer/hold').set('Cookie', deniedCookie).set('x-fbeds-tenant-id', tenantId).send({
        searchId: 'search-a', expectedCurrency: 'AED', expectedSellAmountMinor: 50000, idempotencyKey: `${suffix}-denied`,
      }).expect(403)
      await request(app.getHttpServer()).post('/api/v1/agent/offers/missing-offer/hold').set('Cookie', ownerCookie).set('x-fbeds-tenant-id', otherTenantId).send({
        searchId: 'search-a', expectedCurrency: 'AED', expectedSellAmountMinor: 50000, idempotencyKey: `${suffix}-foreign`,
      }).expect(403)
      const missing = await holdBody(`missing-${suffix}`, `search-${suffix}`, 50000).expect(409)
      expect(missing.body.data.status).toBe('unavailable')
      const offer = await searchOffer()
      const adapter = app.get(SUPPLIER_ADAPTER) as { offers: Map<string, { offerId: string; expiresAt: string }> }
      const stored = [...adapter.offers.values()].find((item) => item.offerId === offer.offerId)
      expect(stored).toBeTruthy()
      stored!.expiresAt = new Date(Date.now() - 60_000).toISOString()
      const expired = await request(app.getHttpServer()).post(`/api/v1/agent/offers/${encodeURIComponent(offer.offerId)}/hold`).set('Cookie', ownerCookie).set('x-fbeds-tenant-id', tenantId).send({
        searchId: offer.searchId, expectedCurrency: 'AED', expectedSellAmountMinor: offer.sellAmountMinor, idempotencyKey: `${suffix}-expired`,
      }).expect(410)
      expect(expired.body.data.status).toBe('offer_expired')
      expect(await effects()).toEqual(before)
    } finally { delete process.env.BOOKING_ENABLED }
  })

  it('HOLD-06 an enabled authorized rechecked offer creates one hold', async () => {
    process.env.BOOKING_ENABLED = 'true'
    try {
      const before = await effects()
      const offer = await searchOffer()
      const held = await request(app.getHttpServer()).post(`/api/v1/agent/offers/${encodeURIComponent(offer.offerId)}/hold`).set('Cookie', ownerCookie).set('x-fbeds-tenant-id', tenantId).send({
        searchId: offer.searchId, expectedCurrency: 'AED', expectedSellAmountMinor: offer.sellAmountMinor, idempotencyKey: `${suffix}-live-hold`,
      }).expect(201)
      expect(held.body.data).toMatchObject({ status: 'held', currency: 'AED', sellAmountMinor: offer.sellAmountMinor })
      const after = await effects()
      expect(after.holds).toBe(before.holds + 1)
      expect(after.nights).toBeGreaterThan(before.nights)
      expect(after.held).toBeGreaterThan(before.held)
      expect(after.bookings).toBe(before.bookings)
      expect(after.mutations).toBe(before.mutations)
      expect(after.ledger).toBe(before.ledger)
      const nightsRows = await prisma.dailyAvailability.findMany({ where: { ratePlanId }, select: { allotment: true, sold: true, held: true } })
      for (const night of nightsRows) expect(night.allotment - night.sold - night.held).toBeGreaterThanOrEqual(0)
    } finally { delete process.env.BOOKING_ENABLED }
  })

  it('pages booking history with an authoritative total and keeps reads closed while booking is disabled', async () => {
    delete process.env.BOOKING_ENABLED
    await api(ownerCookie).get('/api/v1/agent/bookings').expect(503)
    const created = await Promise.all(Array.from({ length: 51 }, (_, index) => prisma.booking.create({
      data: {
        tenantId, reference: `${suffix}-${index}`, supplier: 'contracted', hotelId, currency: 'AED', totalMinor: 1000n + BigInt(index),
        idempotencyKey: `${suffix}-booking-${index}`, status: index === 50 ? 'CANCELLED' : index % 10 === 0 ? 'CONFIRMED' : 'PENDING_SUPPLIER',
        searchSnapshot: { checkIn: '2099-04-01', checkOut: '2099-04-03', rooms: 1, adults: 2, children: 0, leadGuest: { firstName: 'Amina', lastName: 'Noor' } },
        createdAt: new Date(Date.now() - index * 1000),
      },
    })))
    const cancelled = created[50]
    await prisma.cancellation.create({ data: { bookingId: cancelled.id, reason: 'guest', refundMinor: 0n, createdAt: new Date('2099-04-02T00:00:00.000Z') } })
    process.env.BOOKING_ENABLED = 'true'
    try {
      const empty = await api(emptyCookie, emptyTenantId).get('/api/v1/agent/bookings').expect(200)
      expect(empty.body.data).toMatchObject({ items: [], total: 0, offset: 0 })
      const other = await api(otherCookie, otherTenantId).get('/api/v1/agent/bookings').expect(403)
      expect(other.body.success).toBe(false)
      const first = await api(ownerCookie).get('/api/v1/agent/bookings?limit=20&offset=0').expect(200)
      expect(first.body.data.total).toBe(51)
      expect(first.body.data.items).toHaveLength(20)
      expect(first.body.data.items[0].reference).toBe(`${suffix}-0`)
      const middle = await api(ownerCookie).get('/api/v1/agent/bookings?limit=20&offset=20').expect(200)
      expect(middle.body.data.items).toHaveLength(20)
      expect(middle.body.data.items.map((row: { reference: string }) => row.reference)).not.toEqual(expect.arrayContaining([first.body.data.items[0].reference]))
      const last = await api(ownerCookie).get('/api/v1/agent/bookings?limit=20&offset=40').expect(200)
      expect(last.body.data.items).toHaveLength(11)
      expect(last.body.data.items.at(-1).reference).toBe(`${suffix}-50`)
      const confirmed = await api(ownerCookie).get('/api/v1/agent/bookings?status=CONFIRMED&limit=20').expect(200)
      expect(confirmed.body.data.total).toBe(5)
      expect(confirmed.body.data.items.every((row: { status: string }) => row.status === 'CONFIRMED')).toBe(true)
      await api(ownerCookie).get('/api/v1/agent/bookings?status=ARCHIVED').expect(400)
      const fresh = await api(ownerCookie).get(`/api/v1/agent/bookings/${created[0].id}`).expect(200)
      expect(fresh.body.data.timeline).toEqual([{ type: 'recorded', at: fresh.body.data.createdAt }])
      expect(JSON.stringify(fresh.body.data.timeline)).not.toContain('confirmed')
      const closed = await api(ownerCookie).get(`/api/v1/agent/bookings/${cancelled.id}`).expect(200)
      expect(closed.body.data.timeline).toEqual([
        { type: 'recorded', at: cancelled.createdAt.toISOString() },
        { type: 'cancelled', at: '2099-04-02T00:00:00.000Z' },
      ])
      expect(closed.body.data.supplierMutation).toBeNull()
    } finally { delete process.env.BOOKING_ENABLED }
  })
})
