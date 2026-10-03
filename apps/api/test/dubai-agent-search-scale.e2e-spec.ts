import { mkdirSync, writeFileSync } from 'fs'
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

describe('Authoritative Dubai 10-hotel agent search', () => {
  const suffix = `dubai-10-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const password = 'dubai-ten-hotel-certification-password'
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
  const checkIn = day(14)
  const checkOut = day(17)
  const nights = [day(14), day(15), day(16)]
  const stayNights = 3
  let app: INestApplication
  let tenantId = ''
  let otherTenantId = ''
  let emptyTenantId = ''
  let ownerId = ''
  let agentId = ''
  let deniedId = ''
  let otherOwnerId = ''
  let otherUserId = ''
  let emptyUserId = ''
  const roleIds: string[] = []
  let supplierId = ''
  let otherSupplierId = ''
  let bbId = ''
  let hbId = ''
  let ownerCookie = ''
  let agentCookie = ''
  let deniedCookie = ''
  let otherOwnerCookie = ''
  let otherCookie = ''
  let emptyCookie = ''
  const hiddenPlanIds = new Set<string>()
  const hiddenHotelIds = new Set<string>()
  const expected: Array<{
    hotelName: string
    hotelId: string
    roomName: string
    roomId: string
    boardName: string
    boardId: string
    ratePlanId: string
    contractId: string
    supplierId: string
    nightMinor: number
    totalMinor: number
    availability: 'available' | 'limited'
  }> = []

  const chains: Record<string, {
    hotelId: string
    mappingId: string
    roomId: string
    roomMappingId: string
    contractId: string
    ratePlanId: string
    nightMinor: number
  }> = {}

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
    const users = await Promise.all([
      prisma.user.create({ data: { email: `${suffix}-owner@example.test`, passwordHash } }),
      prisma.user.create({ data: { email: `${suffix}-agent@example.test`, passwordHash } }),
      prisma.user.create({ data: { email: `${suffix}-denied@example.test`, passwordHash } }),
      prisma.user.create({ data: { email: `${suffix}-b-owner@example.test`, passwordHash } }),
      prisma.user.create({ data: { email: `${suffix}-other@example.test`, passwordHash } }),
      prisma.user.create({ data: { email: `${suffix}-empty@example.test`, passwordHash } }),
    ])
    ;[ownerId, agentId, deniedId, otherOwnerId, otherUserId, emptyUserId] = users.map((user) => user.id)
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
    const otherOwnerRole = await prisma.role.create({ data: { tenantId: otherTenantId, name: `${suffix}-b-owner` } })
    const otherRole = await prisma.role.create({ data: { tenantId: otherTenantId, name: `${suffix}-other` } })
    const emptyRole = await prisma.role.create({ data: { tenantId: emptyTenantId, name: `${suffix}-empty` } })
    roleIds.push(ownerRole.id, agentRole.id, deniedRole.id, otherOwnerRole.id, otherRole.id, emptyRole.id)
    await prisma.rolePermission.createMany({ data: permissions.map((permission) => ({ roleId: ownerRole.id, permissionId: permission.id })) })
    await prisma.rolePermission.createMany({ data: permissions.map((permission) => ({ roleId: otherOwnerRole.id, permissionId: permission.id })) })
    await prisma.rolePermission.createMany({ data: ['hotel.search', 'booking.prebook'].map((key) => ({ roleId: agentRole.id, permissionId: byKey.get(key)! })) })
    await prisma.rolePermission.create({ data: { roleId: otherRole.id, permissionId: byKey.get('hotel.search')! } })
    await prisma.rolePermission.create({ data: { roleId: emptyRole.id, permissionId: byKey.get('hotel.search')! } })
    await prisma.membership.createMany({ data: [
      { tenantId, userId: ownerId, role: 'owner' },
      { tenantId, userId: agentId, role: 'agent' },
      { tenantId, userId: deniedId, role: 'staff' },
      { tenantId: otherTenantId, userId: otherOwnerId, role: 'owner' },
      { tenantId: otherTenantId, userId: otherUserId, role: 'agent' },
      { tenantId: emptyTenantId, userId: emptyUserId, role: 'agent' },
    ] })
    await prisma.userRole.createMany({ data: [
      { tenantId, userId: ownerId, roleId: ownerRole.id },
      { tenantId, userId: agentId, roleId: agentRole.id },
      { tenantId, userId: deniedId, roleId: deniedRole.id },
      { tenantId: otherTenantId, userId: otherOwnerId, roleId: otherOwnerRole.id },
      { tenantId: otherTenantId, userId: otherUserId, roleId: otherRole.id },
      { tenantId: emptyTenantId, userId: emptyUserId, roleId: emptyRole.id },
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
    otherOwnerCookie = await login(`${suffix}-b-owner@example.test`)
    otherCookie = await login(`${suffix}-other@example.test`)
    emptyCookie = await login(`${suffix}-empty@example.test`)
    await loadCatalog()
  }, 180000)

  afterAll(async () => {
    await app?.close()
    const userIds = [ownerId, agentId, deniedId, otherOwnerId, otherUserId, emptyUserId].filter(Boolean)
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

  function search(cookie = agentCookie, patch: Record<string, unknown> = {}, tenant = tenantId) {
    return api(cookie, tenant).post('/api/v1/agent/search').send(searchBody(patch))
  }

  async function loadCatalog() {
    const admin = api(ownerCookie)
    const supplier = await admin.post('/api/v1/supply/suppliers').send({
      type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${suffix} Supplier`, displayName: 'Dubai Contracted Supply',
      countryCode: 'AE', defaultCurrency: 'AED',
    }).expect(201)
    supplierId = supplier.body.data.id
    const bb = await admin.post('/api/v1/supply/board-bases').send({ code: 'BB', name: 'Bed & Breakfast' }).expect(201)
    const hb = await admin.post('/api/v1/supply/board-bases').send({ code: 'HB', name: 'Half Board' }).expect(201)
    bbId = bb.body.data.id
    hbId = hb.body.data.id

    const h1 = await sellableChain(admin, { key: 'h1', hotel: '01 Palm BB', room: 'Palm King', code: 'PK', boardId: bbId, boardName: 'Bed & Breakfast', nightMinor: 29900 })
    await hiddenContractPlan(admin, h1, 'suspended-contract', 'SUSPENDED', 11100)
    const pendingSupplier = await admin.post('/api/v1/supply/suppliers').send({
      type: 'DMC', status: 'ACTIVE', legalName: `${suffix} Pending DMC`, displayName: 'Unapproved DMC',
      countryCode: 'AE', defaultCurrency: 'AED',
    }).expect(201)
    const pendingMapping = await admin.post('/api/v1/supply/mappings/hotels').send({
      supplierId: pendingSupplier.body.data.id, hotelId: h1.hotelId, supplierHotelId: `${suffix}-h1-pending`,
    }).expect(201)
    expect(pendingMapping.body.data.status).toBe('PENDING')

    const h2 = await sellableChain(admin, { key: 'h2', hotel: '02 Creek HB', room: 'Creek Twin', code: 'CT', boardId: hbId, boardName: 'Half Board', nightMinor: 32500 })
    await hiddenContractPlan(admin, h2, 'expired-contract', 'EXPIRED', 22200)

    const h3 = await sellableChain(admin, { key: 'h3', hotel: '03 Marina Partial Room', room: 'Marina Sellable', code: 'MS', boardId: bbId, boardName: 'Bed & Breakfast', nightMinor: 41000 })
    await hiddenRoom(admin, h3, 'Marina Unmapped', 'MU', bbId, 33300, false, {})

    const h4 = await sellableChain(admin, { key: 'h4', hotel: '04 Jumeirah Partial Plan', room: 'Jumeirah Deluxe', code: 'JD', boardId: bbId, boardName: 'Bed & Breakfast', nightMinor: 45500 })
    const minStayPlan = await extraPlan(admin, h4, 'MIN', bbId, 44400, { minStay: 5 })
    hiddenPlanIds.add(minStayPlan)
    const suspendedPlan = await extraPlan(admin, h4, 'OFF', bbId, 44500, { planStatus: 'SUSPENDED' })
    hiddenPlanIds.add(suspendedPlan)

    const h5 = await sellableChain(admin, { key: 'h5', hotel: '05 Deira Min Stay', room: 'Deira Room', code: 'DR', boardId: bbId, boardName: 'Bed & Breakfast', nightMinor: 50000, minStay: 5, sellable: false })
    hiddenHotelIds.add(h5.hotelId)
    hiddenPlanIds.add(h5.ratePlanId)
    const h6 = await sellableChain(admin, { key: 'h6', hotel: '06 Business Bay Release', room: 'Bay Room', code: 'BR', boardId: hbId, boardName: 'Half Board', nightMinor: 51000, releaseDays: 40, sellable: false })
    hiddenHotelIds.add(h6.hotelId)
    hiddenPlanIds.add(h6.ratePlanId)

    const h7 = await sellableChain(admin, { key: 'h7', hotel: '07 Downtown Stop Sell', room: 'Downtown Open', code: 'DO', boardId: bbId, boardName: 'Bed & Breakfast', nightMinor: 52000 })
    await hiddenRoom(admin, h7, 'Downtown Stopped', 'DS', bbId, 61000, true, { stopSell: true })

    await sellableChain(admin, { key: 'h8', hotel: '08 Al Barsha Limited', room: 'Barsha Limited', code: 'BL', boardId: hbId, boardName: 'Half Board', nightMinor: 27500, allotment: 1, availability: 'limited' })
    const zeroPlan = await extraPlan(admin, chains.h8, 'ZERO', hbId, 27600, { allotment: 0 })
    hiddenPlanIds.add(zeroPlan)

    const h9 = await sellableChain(admin, { key: 'h9', hotel: '09 Festival City Boards', room: 'Festival Room', code: 'FR', boardId: bbId, boardName: 'Bed & Breakfast', nightMinor: 28000 })
    await extraPlan(admin, h9, 'HB', hbId, 36000, { boardName: 'Half Board', record: true })

    const h10 = await sellableChain(admin, { key: 'h10', hotel: '10 Trade Centre Offers', room: 'Trade King', code: 'TK', boardId: bbId, boardName: 'Bed & Breakfast', nightMinor: 33000 })
    await hiddenRoom(admin, h10, 'Trade Twin', 'TT', hbId, 47000, true, { record: true, boardName: 'Half Board' })

    const otherAdmin = api(otherOwnerCookie, otherTenantId)
    const otherSupplier = await otherAdmin.post('/api/v1/supply/suppliers').send({
      type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${suffix} Other Supplier`, displayName: 'Other Tenant Supply',
      countryCode: 'AE', defaultCurrency: 'AED',
    }).expect(201)
    otherSupplierId = otherSupplier.body.data.id
    const otherBoard = await otherAdmin.post('/api/v1/supply/board-bases').send({ code: 'BB', name: 'Bed & Breakfast' }).expect(201)
    const otherHotel = await otherAdmin.post('/api/v1/supply/hotels').send({
      name: `${suffix} 99 Other Tenant Hotel`, propertyType: 'HOTEL', starRating: 4, city: 'Dubai', countryCode: 'AE',
    }).expect(201)
    await prisma.hotel.update({ where: { id: otherHotel.body.data.id }, data: { contentStatus: 'COMPLETE' } }) // fixture: publication is maker-checker (ADR 0022)
    hiddenHotelIds.add(otherHotel.body.data.id)
    const otherRoom = await otherAdmin.post(`/api/v1/supply/hotels/${otherHotel.body.data.id}/rooms`).send({
      name: 'Other Room', code: 'OR', maxAdults: 2, maxChildren: 0, maxOccupancy: 2, isActive: true,
    }).expect(201)
    const otherMapping = await otherAdmin.post('/api/v1/supply/mappings/hotels').send({
      supplierId: otherSupplierId, hotelId: otherHotel.body.data.id, supplierHotelId: `${suffix}-other-hotel`,
    }).expect(201)
    await otherAdmin.post(`/api/v1/supply/mappings/hotels/${otherMapping.body.data.id}/approve`).expect(201)
    const otherRoomMapping = await otherAdmin.post(`/api/v1/supply/mappings/hotels/${otherMapping.body.data.id}/rooms`).send({
      supplierRoomId: `${suffix}-other-room`, roomTypeId: otherRoom.body.data.id,
    }).expect(201)
    await otherAdmin.post(`/api/v1/supply/mappings/hotels/${otherMapping.body.data.id}/rooms/${otherRoomMapping.body.data.id}/approve`).expect(201)
    const otherContract = await otherAdmin.post('/api/v1/supply/contracts').send({
      supplierId: otherSupplierId, supplierHotelMappingId: otherMapping.body.data.id, code: `${suffix}-other-C`, validFrom: day(0), validTo: day(60), settlementCurrency: 'AED',
    }).expect(201)
    await otherAdmin.patch(`/api/v1/supply/contracts/${otherContract.body.data.id}`).send({ status: 'ACTIVE' }).expect(200)
    const otherPlan = await otherAdmin.post('/api/v1/supply/rate-plans').send({
      contractId: otherContract.body.data.id, roomTypeId: otherRoom.body.data.id, boardBasisId: otherBoard.body.data.id,
      code: `${suffix}-other-FLEX`, occupancy: 2, currency: 'AED', refundable: true, minStay: 1, releaseDays: 0,
    }).expect(201)
    await otherAdmin.patch(`/api/v1/supply/rate-plans/${otherPlan.body.data.id}`).send({ status: 'ACTIVE' }).expect(200)
    await otherAdmin.post('/api/v1/supply/daily-rates/bulk').send({ rows: nights.map((stayDate) => ({
      ratePlanId: otherPlan.body.data.id, stayDate, occupancy: 2, amountMinor: '19900', amountBasis: 'SELL', currency: 'AED',
    })) }).expect(201)
    await otherAdmin.post('/api/v1/supply/availability/bulk').send({ rows: nights.map((stayDate) => ({
      ratePlanId: otherPlan.body.data.id, stayDate, allotment: 4, sold: 0, stopSell: false, minStay: 1,
    })) }).expect(201)
    chains.other = {
      hotelId: otherHotel.body.data.id, mappingId: otherMapping.body.data.id, roomId: otherRoom.body.data.id,
      roomMappingId: otherRoomMapping.body.data.id, contractId: otherContract.body.data.id, ratePlanId: otherPlan.body.data.id, nightMinor: 19900,
    }
  }

  async function sellableChain(admin: ReturnType<typeof api>, input: {
    key: string
    hotel: string
    room: string
    code: string
    boardId: string
    boardName: string
    nightMinor: number
    minStay?: number
    releaseDays?: number
    allotment?: number
    availability?: 'available' | 'limited'
    sellable?: boolean
  }) {
    const hotel = await admin.post('/api/v1/supply/hotels').send({
      name: `${suffix} ${input.hotel}`, propertyType: 'HOTEL', starRating: 5, city: 'Dubai', countryCode: 'AE',
    }).expect(201)
    await prisma.hotel.update({ where: { id: hotel.body.data.id }, data: { contentStatus: 'COMPLETE' } }) // fixture: publication is maker-checker (ADR 0022)
    const room = await admin.post(`/api/v1/supply/hotels/${hotel.body.data.id}/rooms`).send({
      name: input.room, code: input.code, maxAdults: 2, maxChildren: 0, maxOccupancy: 2, isActive: true,
    }).expect(201)
    const mapping = await admin.post('/api/v1/supply/mappings/hotels').send({
      supplierId, hotelId: hotel.body.data.id, supplierHotelId: `${suffix}-${input.key}-hotel`,
    }).expect(201)
    await admin.post(`/api/v1/supply/mappings/hotels/${mapping.body.data.id}/approve`).expect(201)
    const roomMapping = await admin.post(`/api/v1/supply/mappings/hotels/${mapping.body.data.id}/rooms`).send({
      supplierRoomId: `${suffix}-${input.key}-room`, roomTypeId: room.body.data.id,
    }).expect(201)
    await admin.post(`/api/v1/supply/mappings/hotels/${mapping.body.data.id}/rooms/${roomMapping.body.data.id}/approve`).expect(201)
    const contract = await admin.post('/api/v1/supply/contracts').send({
      supplierId, supplierHotelMappingId: mapping.body.data.id, code: `${suffix}-${input.key}-C`, validFrom: day(0), validTo: day(60), settlementCurrency: 'AED',
    }).expect(201)
    await admin.patch(`/api/v1/supply/contracts/${contract.body.data.id}`).send({ status: 'ACTIVE' }).expect(200)
    const plan = await admin.post('/api/v1/supply/rate-plans').send({
      contractId: contract.body.data.id, roomTypeId: room.body.data.id, boardBasisId: input.boardId, code: `${suffix}-${input.key}-FLEX`,
      occupancy: 2, currency: 'AED', refundable: true, minStay: input.minStay ?? 1, releaseDays: input.releaseDays ?? 0,
    }).expect(201)
    await admin.patch(`/api/v1/supply/rate-plans/${plan.body.data.id}`).send({ status: 'ACTIVE' }).expect(200)
    await writeInventory(admin, plan.body.data.id, input.nightMinor, input.allotment ?? 4, false)
    const row = {
      hotelId: hotel.body.data.id, mappingId: mapping.body.data.id, roomId: room.body.data.id, roomMappingId: roomMapping.body.data.id,
      contractId: contract.body.data.id, ratePlanId: plan.body.data.id, nightMinor: input.nightMinor,
    }
    chains[input.key] = row
    if (input.sellable !== false) {
      expected.push({
        hotelName: `${suffix} ${input.hotel}`, hotelId: row.hotelId, roomName: input.room, roomId: row.roomId,
        boardName: input.boardName, boardId: input.boardId, ratePlanId: row.ratePlanId, contractId: row.contractId,
        supplierId, nightMinor: input.nightMinor, totalMinor: input.nightMinor * stayNights, availability: input.availability ?? 'available',
      })
    }
    return row
  }

  async function hiddenContractPlan(admin: ReturnType<typeof api>, chain: typeof chains.h1, code: string, status: 'SUSPENDED' | 'EXPIRED', nightMinor: number) {
    const contract = await admin.post('/api/v1/supply/contracts').send({
      supplierId, supplierHotelMappingId: chain.mappingId, code: `${suffix}-${code}`, validFrom: day(0), validTo: day(60), settlementCurrency: 'AED',
    }).expect(201)
    await admin.patch(`/api/v1/supply/contracts/${contract.body.data.id}`).send({ status: 'ACTIVE' }).expect(200)
    const plan = await admin.post('/api/v1/supply/rate-plans').send({
      contractId: contract.body.data.id, roomTypeId: chain.roomId, boardBasisId: bbId, code: `${suffix}-${code}-P`,
      occupancy: 2, currency: 'AED', refundable: true, minStay: 1, releaseDays: 0,
    }).expect(201)
    await admin.patch(`/api/v1/supply/rate-plans/${plan.body.data.id}`).send({ status: 'ACTIVE' }).expect(200)
    await writeInventory(admin, plan.body.data.id, nightMinor, 4, false)
    await admin.patch(`/api/v1/supply/contracts/${contract.body.data.id}`).send({ status }).expect(200)
    hiddenPlanIds.add(plan.body.data.id)
  }

  async function extraPlan(admin: ReturnType<typeof api>, chain: typeof chains.h1, code: string, boardId: string, nightMinor: number, options: {
    minStay?: number
    planStatus?: 'ACTIVE' | 'SUSPENDED'
    allotment?: number
    boardName?: string
    record?: boolean
  }) {
    const plan = await admin.post('/api/v1/supply/rate-plans').send({
      contractId: chain.contractId, roomTypeId: chain.roomId, boardBasisId: boardId, code: `${suffix}-${code}`,
      occupancy: 2, currency: 'AED', refundable: true, minStay: options.minStay ?? 1, releaseDays: 0,
    }).expect(201)
    await admin.patch(`/api/v1/supply/rate-plans/${plan.body.data.id}`).send({ status: options.planStatus ?? 'ACTIVE' }).expect(200)
    await writeInventory(admin, plan.body.data.id, nightMinor, options.allotment ?? 4, false)
    if (options.record) {
      expected.push({
        hotelName: expected.find((row) => row.hotelId === chain.hotelId)!.hotelName,
        hotelId: chain.hotelId, roomName: expected.find((row) => row.roomId === chain.roomId)!.roomName, roomId: chain.roomId,
        boardName: options.boardName ?? 'Bed & Breakfast', boardId, ratePlanId: plan.body.data.id, contractId: chain.contractId,
        supplierId, nightMinor, totalMinor: nightMinor * stayNights, availability: 'available',
      })
    }
    return plan.body.data.id as string
  }

  async function hiddenRoom(admin: ReturnType<typeof api>, chain: typeof chains.h1, roomName: string, code: string, boardId: string, nightMinor: number, approve: boolean, options: { stopSell?: boolean; record?: boolean; boardName?: string }) {
    const room = await admin.post(`/api/v1/supply/hotels/${chain.hotelId}/rooms`).send({
      name: roomName, code, maxAdults: 2, maxChildren: 0, maxOccupancy: 2, isActive: true,
    }).expect(201)
    const roomMapping = await admin.post(`/api/v1/supply/mappings/hotels/${chain.mappingId}/rooms`).send({
      supplierRoomId: `${suffix}-${code}-room`, roomTypeId: room.body.data.id,
    }).expect(201)
    if (approve) await admin.post(`/api/v1/supply/mappings/hotels/${chain.mappingId}/rooms/${roomMapping.body.data.id}/approve`).expect(201)
    const plan = await admin.post('/api/v1/supply/rate-plans').send({
      contractId: chain.contractId, roomTypeId: room.body.data.id, boardBasisId: boardId, code: `${suffix}-${code}-P`,
      occupancy: 2, currency: 'AED', refundable: true, minStay: 1, releaseDays: 0,
    }).expect(201)
    await admin.patch(`/api/v1/supply/rate-plans/${plan.body.data.id}`).send({ status: 'ACTIVE' }).expect(200)
    await writeInventory(admin, plan.body.data.id, nightMinor, 4, options.stopSell ?? false)
    if (options.record) {
      expected.push({
        hotelName: expected.find((row) => row.hotelId === chain.hotelId)!.hotelName, hotelId: chain.hotelId,
        roomName, roomId: room.body.data.id, boardName: options.boardName ?? 'Bed & Breakfast', boardId,
        ratePlanId: plan.body.data.id, contractId: chain.contractId, supplierId, nightMinor, totalMinor: nightMinor * stayNights, availability: 'available',
      })
    } else hiddenPlanIds.add(plan.body.data.id)
    return { roomId: room.body.data.id as string, roomMappingId: roomMapping.body.data.id as string, ratePlanId: plan.body.data.id as string }
  }

  async function writeInventory(admin: ReturnType<typeof api>, ratePlanId: string, nightMinor: number, allotment: number, stopSell: boolean) {
    await admin.post('/api/v1/supply/daily-rates/bulk').send({ rows: nights.map((stayDate) => ({
      ratePlanId, stayDate, occupancy: 2, amountMinor: String(nightMinor), amountBasis: 'SELL', currency: 'AED',
    })) }).expect(201)
    await admin.post('/api/v1/supply/availability/bulk').send({ rows: nights.map((stayDate) => ({
      ratePlanId, stayDate, allotment, sold: 0, stopSell, minStay: 1,
    })) }).expect(201)
  }

  function offersOf(hotels: Array<{ hotelId: string; name: string; supplierId: string; supplierHotelId: string; destination: string; rooms: Array<{ roomTypeId: string; name: string; rates: Array<Record<string, unknown>> }> }>) {
    return hotels.flatMap((hotel) => hotel.rooms.flatMap((room) => room.rates.map((rate) => ({ hotel, room, rate }))))
  }

  function commercialSignature(hotels: Array<{ hotelId: string; name: string; supplierId: string; rooms: Array<{ roomTypeId: string; name: string; rates: Array<{ ratePlanId: string; contractId?: string; boardBasisId: string; supplierId: string; sellAmountMinor: number; total: { currency: string } }> }> }>) {
    return hotels.map((hotel) => ({
      hotelId: hotel.hotelId,
      name: hotel.name,
      supplierId: hotel.supplierId,
      rooms: hotel.rooms.map((room) => ({
        roomTypeId: room.roomTypeId,
        name: room.name,
        rates: room.rates.map((rate) => ({
          ratePlanId: rate.ratePlanId, contractId: rate.contractId, boardBasisId: rate.boardBasisId,
          supplierId: rate.supplierId, sellAmountMinor: rate.sellAmountMinor, currency: rate.total.currency,
        })),
      })),
    }))
  }

  it('returns the sellable Dubai hotels and excludes unsellable combinations', async () => {
    const response = await search().expect(201)
    expect(response.body.data.status).toBe('available')
    const hotels = response.body.data.hotels
    const offers = offersOf(hotels)
    expect(hotels.map((hotel: { hotelId: string }) => hotel.hotelId).sort()).toEqual(Array.from(new Set(expected.map((row) => row.hotelId))).sort())
    expect(offers.map((offer) => offer.rate.ratePlanId).sort()).toEqual(expected.map((row) => row.ratePlanId).sort())
    expect(hotels.some((hotel: { hotelId: string }) => hiddenHotelIds.has(hotel.hotelId))).toBe(false)
    expect(offers.some((offer) => hiddenPlanIds.has(String(offer.rate.ratePlanId)))).toBe(false)
    expect(new Set(hotels.map((hotel: { hotelId: string }) => hotel.hotelId)).size).toBe(hotels.length)
    expect(new Set(offers.map((offer) => offer.rate.offerId)).size).toBe(offers.length)
    const commercial = offers.map((offer) => [offer.hotel.hotelId, offer.room.roomTypeId, offer.rate.boardBasisId, offer.rate.ratePlanId, offer.rate.supplierId, offer.rate.contractId].join('|'))
    expect(new Set(commercial).size).toBe(commercial.length)

    for (const row of expected) {
      const offer = offers.find((candidate) => candidate.rate.ratePlanId === row.ratePlanId)
      expect(offer).toBeTruthy()
      expect(offer!.hotel).toMatchObject({ hotelId: row.hotelId, name: row.hotelName, destination: 'Dubai', supplierId: row.supplierId })
      expect(offer!.room).toMatchObject({ roomTypeId: row.roomId, name: row.roomName })
      expect(offer!.rate).toMatchObject({
        tenantId, supplierId: row.supplierId, hotelId: row.hotelId, canonicalHotelId: row.hotelId,
        roomTypeId: row.roomId, canonicalRoomTypeId: row.roomId, boardBasisId: row.boardId, boardBasisName: row.boardName,
        ratePlanId: row.ratePlanId, contractId: row.contractId, availability: row.availability,
      })
      expect(offer!.rate.total).toEqual({ amountMinor: row.totalMinor, currency: 'AED' })
      expect(offer!.rate.sellAmountMinor).toBe(row.totalMinor)
      expect(Number.isSafeInteger(offer!.rate.sellAmountMinor)).toBe(true)
      expect(offer!.rate.sellAmountMinor).toBe(row.nightMinor * stayNights)
      expect(offer!.hotel.supplierId).toBe(supplierId)
      expect(offer!.rate.supplierId).not.toBe(otherSupplierId)
    }
    expect(hotels.map((hotel: { name: string }) => hotel.name)).toEqual([...expected.map((row) => row.hotelName)].filter((name, index, names) => names.indexOf(name) === index).sort((left, right) => left.localeCompare(right)))
  })

  it('repeats the same commercial result and drops a stop-sell without serving a stale search', async () => {
    const first = await search().expect(201)
    const signature = commercialSignature(first.body.data.hotels)
    const durations: number[] = []
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const started = process.hrtime.bigint()
      const again = await search().expect(201)
      durations.push(Number(process.hrtime.bigint() - started) / 1_000_000)
      expect(commercialSignature(again.body.data.hotels)).toEqual(signature)
    }
    const admin = api(ownerCookie)
    await admin.post('/api/v1/supply/availability').send({
      ratePlanId: chains.h7.ratePlanId, stayDate: nights[0], allotment: 4, sold: 0, stopSell: true, minStay: 1,
    }).expect(201)
    const stopped = await search().expect(201)
    expect(stopped.body.data.hotels.some((hotel: { hotelId: string }) => hotel.hotelId === chains.h7.hotelId)).toBe(false)
    expect(commercialSignature(stopped.body.data.hotels)).not.toEqual(signature)
    await writeInventory(admin, chains.h7.ratePlanId, chains.h7.nightMinor, 4, false)
    const restored = await search().expect(201)
    expect(commercialSignature(restored.body.data.hotels)).toEqual(signature)
    const started = process.hrtime.bigint()
    const recheck = await api(agentCookie).post('/api/v1/agent/rates/recheck').send({
      offerId: first.body.data.hotels.find((hotel: { hotelId: string }) => hotel.hotelId === chains.h1.hotelId).rooms[0].rates[0].offerId,
      searchId: first.body.data.searchId, expectedCurrency: 'AED', expectedSellAmountMinor: chains.h1.nightMinor * stayNights,
    }).expect(200)
    const recheckMs = Number(process.hrtime.bigint() - started) / 1_000_000
    expect(recheck.body.data.status).toBe('rechecked')
    mkdirSync('/opt/cursor/artifacts', { recursive: true })
    writeFileSync('/opt/cursor/artifacts/dubai-10-metrics.json', JSON.stringify({
      searchMs: durations, recheckMs, hotels: signature.length,
      offers: signature.reduce((sum, hotel) => sum + hotel.rooms.reduce((rooms, room) => rooms + room.rates.length, 0), 0),
    }, null, 2))
  })

  it('rechecks price, availability, stop sell, mapping, expiry and contract changes per hotel', async () => {
    const found = await search().expect(201)
    const offerFor = (hotelId: string, ratePlanId = chains[Object.keys(chains).find((key) => chains[key].hotelId === hotelId)!].ratePlanId) => {
      const hotel = found.body.data.hotels.find((candidate: { hotelId: string }) => candidate.hotelId === hotelId)
      const rate = hotel.rooms.flatMap((room: { rates: Array<{ ratePlanId: string }> }) => room.rates).find((rate: { ratePlanId: string }) => rate.ratePlanId === ratePlanId)
      return rate
    }
    const h1 = offerFor(chains.h1.hotelId)
    const unchanged = await api(agentCookie).post('/api/v1/agent/rates/recheck').send({
      offerId: h1.offerId, searchId: found.body.data.searchId, expectedCurrency: 'AED', expectedSellAmountMinor: h1.sellAmountMinor,
    }).expect(200)
    expect(unchanged.body.data).toMatchObject({ offerId: h1.offerId, status: 'rechecked', currency: 'AED', sellAmountMinor: chains.h1.nightMinor * stayNights })

    const h2 = offerFor(chains.h2.hotelId)
    const quoted = h2.sellAmountMinor
    await api(ownerCookie).post('/api/v1/supply/daily-rates').send({
      ratePlanId: chains.h2.ratePlanId, stayDate: nights[0], occupancy: 2, amountMinor: String(chains.h2.nightMinor + 100), amountBasis: 'SELL', currency: 'AED',
    }).expect(201)
    const changed = await api(agentCookie).post('/api/v1/agent/rates/recheck').send({
      offerId: h2.offerId, searchId: found.body.data.searchId, expectedCurrency: 'AED', expectedSellAmountMinor: quoted,
    }).expect(409)
    expect(changed.body.data).toMatchObject({ offerId: h2.offerId, status: 'price_changed', currency: 'AED', sellAmountMinor: quoted + 100 })
    expect(h2.sellAmountMinor).toBe(quoted)
    await writeInventory(api(ownerCookie), chains.h2.ratePlanId, chains.h2.nightMinor, 4, false)

    const h3 = offerFor(chains.h3.hotelId)
    await prisma.dailyAvailability.deleteMany({ where: { ratePlanId: chains.h3.ratePlanId, stayDate: new Date(`${nights[1]}T00:00:00.000Z`) } })
    const removed = await api(agentCookie).post('/api/v1/agent/rates/recheck').send({
      offerId: h3.offerId, searchId: found.body.data.searchId, expectedCurrency: 'AED', expectedSellAmountMinor: h3.sellAmountMinor,
    }).expect(409)
    expect(removed.body.data.status).toBe('unavailable')
    expect((await search()).body.data.hotels.some((hotel: { hotelId: string }) => hotel.hotelId === chains.h1.hotelId)).toBe(true)
    await writeInventory(api(ownerCookie), chains.h3.ratePlanId, chains.h3.nightMinor, 4, false)

    const h7 = offerFor(chains.h7.hotelId)
    await api(ownerCookie).post('/api/v1/supply/availability').send({
      ratePlanId: chains.h7.ratePlanId, stayDate: nights[0], allotment: 4, sold: 0, stopSell: true, minStay: 1,
    }).expect(201)
    const stopped = await api(agentCookie).post('/api/v1/agent/rates/recheck').send({
      offerId: h7.offerId, searchId: found.body.data.searchId, expectedCurrency: 'AED', expectedSellAmountMinor: h7.sellAmountMinor,
    }).expect(409)
    expect(stopped.body.data.status).toBe('unavailable')
    await writeInventory(api(ownerCookie), chains.h7.ratePlanId, chains.h7.nightMinor, 4, false)

    const h8 = offerFor(chains.h8.hotelId)
    await api(ownerCookie).post(`/api/v1/supply/mappings/hotels/${chains.h8.mappingId}/rooms/${chains.h8.roomMappingId}/reopen`).expect(201)
    await api(ownerCookie).post(`/api/v1/supply/mappings/hotels/${chains.h8.mappingId}/rooms/${chains.h8.roomMappingId}/reject`).expect(201)
    const revoked = await api(agentCookie).post('/api/v1/agent/rates/recheck').send({
      offerId: h8.offerId, searchId: found.body.data.searchId, expectedCurrency: 'AED', expectedSellAmountMinor: h8.sellAmountMinor,
    }).expect(409)
    expect(revoked.body.data.status).toBe('unavailable')
    await prisma.supplierRoomMapping.update({ where: { id: chains.h8.roomMappingId }, data: { status: 'MAPPED' } })

    const previous = process.env.AGENT_OFFER_TTL_MS
    process.env.AGENT_OFFER_TTL_MS = '1000'
    try {
      const expiring = await search().expect(201)
      const h4 = expiring.body.data.hotels.find((hotel: { hotelId: string }) => hotel.hotelId === chains.h4.hotelId).rooms[0].rates[0]
      await new Promise((resolve) => setTimeout(resolve, 1100))
      const expired = await api(agentCookie).post('/api/v1/agent/rates/recheck').send({
        offerId: h4.offerId, searchId: expiring.body.data.searchId, expectedCurrency: 'AED', expectedSellAmountMinor: h4.sellAmountMinor,
      }).expect(410)
      expect(expired.body.data.status).toBe('offer_expired')
    } finally {
      if (previous === undefined) delete process.env.AGENT_OFFER_TTL_MS
      else process.env.AGENT_OFFER_TTL_MS = previous
    }

    const current = await search().expect(201)
    const h9 = current.body.data.hotels.find((hotel: { hotelId: string }) => hotel.hotelId === chains.h9.hotelId).rooms[0].rates[0]
    await api(ownerCookie).patch(`/api/v1/supply/contracts/${chains.h9.contractId}`).send({ status: 'SUSPENDED' }).expect(200)
    const disabled = await api(agentCookie).post('/api/v1/agent/rates/recheck').send({
      offerId: h9.offerId, searchId: current.body.data.searchId, expectedCurrency: 'AED', expectedSellAmountMinor: h9.sellAmountMinor,
    }).expect(409)
    expect(disabled.body.data.status).toBe('unavailable')
    const remaining = await search().expect(201)
    expect(remaining.body.data.hotels.some((hotel: { hotelId: string }) => hotel.hotelId === chains.h1.hotelId)).toBe(true)
    expect(remaining.body.data.hotels.some((hotel: { hotelId: string }) => hotel.hotelId === chains.h9.hotelId)).toBe(false)
    await api(ownerCookie).patch(`/api/v1/supply/contracts/${chains.h9.contractId}`).send({ status: 'ACTIVE' }).expect(200)
  })

  it('keeps a valid hotel when another hotel fails a commercial gate', async () => {
    expect((await search(agentCookie, { adults: 3 })).body.data.hotels).toEqual([])
    expect((await search(agentCookie, { currency: 'USD' })).body.data.hotels).toEqual([])
    const admin = api(ownerCookie)
    await admin.post(`/api/v1/supply/mappings/hotels/${chains.h3.mappingId}/rooms/${chains.h3.roomMappingId}/reopen`).expect(201)
    const unmappedRoom = await search().expect(201)
    expect(unmappedRoom.body.data.hotels.some((hotel: { hotelId: string }) => hotel.hotelId === chains.h3.hotelId)).toBe(false)
    expect(unmappedRoom.body.data.hotels.some((hotel: { hotelId: string }) => hotel.hotelId === chains.h1.hotelId)).toBe(true)
    await admin.post(`/api/v1/supply/mappings/hotels/${chains.h3.mappingId}/rooms/${chains.h3.roomMappingId}/approve`).expect(201)

    await admin.post(`/api/v1/supply/mappings/hotels/${chains.h2.mappingId}/rooms/${chains.h2.roomMappingId}/reopen`).expect(201)
    await admin.post(`/api/v1/supply/mappings/hotels/${chains.h2.mappingId}/reopen`).expect(201)
    const unmappedHotel = await search().expect(201)
    expect(unmappedHotel.body.data.hotels.some((hotel: { hotelId: string }) => hotel.hotelId === chains.h2.hotelId)).toBe(false)
    expect(unmappedHotel.body.data.hotels.some((hotel: { hotelId: string }) => hotel.hotelId === chains.h1.hotelId)).toBe(true)
    await prisma.supplierHotelMapping.update({ where: { id: chains.h2.mappingId }, data: { status: 'MAPPED' } })
    await prisma.supplierRoomMapping.update({ where: { id: chains.h2.roomMappingId }, data: { status: 'MAPPED' } })

    await admin.patch(`/api/v1/supply/rate-plans/${chains.h4.ratePlanId}`).send({ status: 'SUSPENDED' }).expect(200)
    const inactivePlan = await search().expect(201)
    expect(inactivePlan.body.data.hotels.some((hotel: { hotelId: string }) => hotel.hotelId === chains.h4.hotelId)).toBe(false)
    expect(inactivePlan.body.data.hotels.some((hotel: { hotelId: string }) => hotel.hotelId === chains.h1.hotelId)).toBe(true)
    await admin.patch(`/api/v1/supply/rate-plans/${chains.h4.ratePlanId}`).send({ status: 'ACTIVE' }).expect(200)
    expect((await search()).body.data.hotels).toHaveLength(new Set(expected.map((row) => row.hotelId)).size)
  })

  it('isolates tenants, permissions, sessions and an unconfigured supplier', async () => {
    const own = await search().expect(201)
    const offer = own.body.data.hotels[0].rooms[0].rates[0]
    const otherSearch = await search(otherCookie, {}, otherTenantId).expect(201)
    expect(otherSearch.body.data.hotels.map((hotel: { hotelId: string }) => hotel.hotelId)).toEqual([chains.other.hotelId])
    expect(own.body.data.hotels.some((hotel: { hotelId: string }) => hotel.hotelId === chains.other.hotelId)).toBe(false)
    const cross = await api(otherCookie, otherTenantId).post('/api/v1/agent/rates/recheck').send({
      offerId: offer.offerId, searchId: own.body.data.searchId, expectedCurrency: 'AED', expectedSellAmountMinor: offer.sellAmountMinor,
    }).expect(409)
    expect(cross.body.data.status).toBe('unavailable')
    await api(agentCookie, otherTenantId).post('/api/v1/agent/search').send(searchBody()).expect(403)
    await api(deniedCookie).post('/api/v1/agent/search').send(searchBody()).expect(403)
    await request(app.getHttpServer()).post('/api/v1/agent/search').set('x-fbeds-tenant-id', tenantId).send(searchBody()).expect(401)
    await request(app.getHttpServer()).post('/api/v1/agent/search').set('Cookie', 'fbeds_session=invalid').set('x-fbeds-tenant-id', tenantId).send(searchBody()).expect(401)
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
