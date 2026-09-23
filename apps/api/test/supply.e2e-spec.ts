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

describe('Supply HTTP authorization boundaries', () => {
  const suffix = `supply-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const password = 'supply-http-certification-password'
  const requestId = `${suffix}-audit-001`
  let app: INestApplication
  let tenantAId: string
  let tenantBId: string
  let userAId: string
  let userBId: string
  let hotelAId: string
  let hotelBId: string
  let roomAId: string
  let roomBId: string
  let ratePlanAId: string
  let ratePlanBId: string
  let boardAId: string
  let boardBId: string
  let supplierAId: string
  let supplierBId: string
  let contractAId: string
  let contractBId: string
  const roleIds: string[] = []
  const permissionIds: string[] = []

  beforeAll(async () => {
    await prisma.$connect()
    const [tenantA, tenantB] = await Promise.all([
      prisma.tenant.create({ data: { name: `${suffix} Tenant A`, slug: `${suffix}-a` } }),
      prisma.tenant.create({ data: { name: `${suffix} Tenant B`, slug: `${suffix}-b` } }),
    ])
    tenantAId = tenantA.id
    tenantBId = tenantB.id
    const passwordHash = await hashPassword(password)
    const [userA, userB] = await Promise.all([
      prisma.user.create({ data: { email: `${suffix}-a@example.test`, passwordHash } }),
      prisma.user.create({ data: { email: `${suffix}-b@example.test`, passwordHash } }),
    ])
    userAId = userA.id
    userBId = userB.id

    const permissionKeys = [
      'supply.hotels.read', 'supply.hotels.manage', 'supply.rooms.read', 'supply.rooms.manage',
      'supply.rates.read', 'supply.rates.manage', 'supply.contracts.read', 'supply.contracts.manage',
      'supply.availability.manage',
      'supply.mappings.read', 'supply.mappings.manage',
    ]
    const permissions = await Promise.all(permissionKeys.map((key) => prisma.permission.upsert({ where: { key }, update: {}, create: { key, description: `${suffix} ${key}` } })))
    permissionIds.push(...permissions.map((permission) => permission.id))
    for (const tenantId of [tenantAId, tenantBId]) {
      const role = await prisma.role.create({ data: { tenantId, name: `${suffix}-${tenantId}` } })
      roleIds.push(role.id)
      await prisma.rolePermission.createMany({ data: permissions.map((permission) => ({ roleId: role.id, permissionId: permission.id })) })
    }
    await prisma.membership.createMany({ data: [{ tenantId: tenantAId, userId: userAId, role: 'owner' }, { tenantId: tenantBId, userId: userBId, role: 'owner' }] })
    await prisma.userRole.createMany({ data: [{ tenantId: tenantAId, userId: userAId, roleId: roleIds[0] }, { tenantId: tenantBId, userId: userBId, roleId: roleIds[1] }] })

    const [supplierA, supplierB] = await Promise.all([
      prisma.supplier.create({ data: { tenantId: tenantAId, type: 'HOTEL_DIRECT', legalName: `${suffix} Supplier A`, displayName: 'Supplier A', countryCode: 'AE', defaultCurrency: 'USD' } }),
      prisma.supplier.create({ data: { tenantId: tenantBId, type: 'HOTEL_DIRECT', legalName: `${suffix} Supplier B`, displayName: 'Supplier B', countryCode: 'AE', defaultCurrency: 'USD' } }),
    ])
    supplierAId = supplierA.id
    supplierBId = supplierB.id
    const [hotelA, hotelB] = await Promise.all([
      prisma.hotel.create({ data: { tenantId: tenantAId, name: `${suffix} Hotel A`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE' } }),
      prisma.hotel.create({ data: { tenantId: tenantBId, name: `${suffix} Hotel B`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE' } }),
    ])
    hotelAId = hotelA.id
    hotelBId = hotelB.id
    const [roomA, roomB] = await Promise.all([
      prisma.roomType.create({ data: { hotelId: hotelAId, name: 'Room A', code: `${suffix}-A`, maxAdults: 2, maxOccupancy: 2 } }),
      prisma.roomType.create({ data: { hotelId: hotelBId, name: 'Room B', code: `${suffix}-B`, maxAdults: 2, maxOccupancy: 2 } }),
    ])
    roomAId = roomA.id
    roomBId = roomB.id
    const [boardA, boardB] = await Promise.all([
      prisma.boardBasis.create({ data: { tenantId: tenantAId, code: 'ROA', name: 'Room Only A' } }),
      prisma.boardBasis.create({ data: { tenantId: tenantBId, code: 'ROB', name: 'Room Only B' } }),
    ])
    boardAId = boardA.id
    boardBId = boardB.id
    const [contractA, contractB] = await Promise.all([
      prisma.contract.create({ data: { tenantId: tenantAId, supplierId: supplierAId, code: `${suffix}-CA`, validFrom: new Date('2026-01-01'), validTo: new Date('2027-12-31'), settlementCurrency: 'USD' } }),
      prisma.contract.create({ data: { tenantId: tenantBId, supplierId: supplierBId, code: `${suffix}-CB`, validFrom: new Date('2026-01-01'), validTo: new Date('2027-12-31'), settlementCurrency: 'USD' } }),
    ])
    contractAId = contractA.id
    contractBId = contractB.id
    const [planA, planB] = await Promise.all([
      prisma.ratePlan.create({ data: { tenantId: tenantAId, contractId: contractAId, roomTypeId: roomAId, boardBasisId: boardAId, code: `${suffix}-RPA`, occupancy: 2, currency: 'USD' } }),
      prisma.ratePlan.create({ data: { tenantId: tenantBId, contractId: contractBId, roomTypeId: roomBId, boardBasisId: boardBId, code: `${suffix}-RPB`, occupancy: 2, currency: 'USD' } }),
    ])
    ratePlanAId = planA.id
    ratePlanBId = planB.id

    const module = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = module.createNestApplication()
    app.use(cookieParser())
    app.setGlobalPrefix('api/v1')
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
    app.useGlobalFilters(new HttpExceptionFilter())
    app.useGlobalInterceptors(new ResponseInterceptor())
    await app.init()
  }, 30000)

  afterAll(async () => {
    await app?.close()
    await prisma.auditEvent.deleteMany({ where: { userId: { in: [userAId, userBId] } } })
    await prisma.dailyRate.deleteMany({ where: { ratePlanId: { in: [ratePlanAId, ratePlanBId] } } })
    await prisma.dailyAvailability.deleteMany({ where: { ratePlanId: { in: [ratePlanAId, ratePlanBId] } } })
    await prisma.ratePlan.deleteMany({ where: { id: { in: [ratePlanAId, ratePlanBId] } } })
    await prisma.contract.deleteMany({ where: { id: { in: [contractAId, contractBId] } } })
    await prisma.boardBasis.deleteMany({ where: { id: { in: [boardAId, boardBId] } } })
    await prisma.roomType.deleteMany({ where: { id: { in: [roomAId, roomBId] } } })
    await prisma.hotel.deleteMany({ where: { id: { in: [hotelAId, hotelBId] } } })
    await prisma.supplier.deleteMany({ where: { id: { in: [supplierAId, supplierBId] } } })
    await prisma.userRole.deleteMany({ where: { userId: { in: [userAId, userBId] } } })
    await prisma.rolePermission.deleteMany({ where: { roleId: { in: roleIds } } })
    await prisma.role.deleteMany({ where: { id: { in: roleIds } } })
    await prisma.membership.deleteMany({ where: { userId: { in: [userAId, userBId] } } })
    await prisma.session.deleteMany({ where: { userId: { in: [userAId, userBId] } } })
    await prisma.user.deleteMany({ where: { id: { in: [userAId, userBId] } } })
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantAId, tenantBId] } } })
    await prisma.$disconnect()
  })

  async function login(email: string) {
    const response = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', 'http://localhost:3001').send({ email, password }).expect(200)
    return response.headers['set-cookie'][0].split(';')[0]
  }

  function supply(cookie: string, tenantId: string) {
    const configure = (test: request.Test) => test.set('Cookie', cookie).set('x-fbeds-tenant-id', tenantId)
    return {
      get: (path: string) => configure(request(app.getHttpServer()).get(path)),
      post: (path: string) => configure(request(app.getHttpServer()).post(path)),
      patch: (path: string) => configure(request(app.getHttpServer()).patch(path)),
    }
  }

  it('requires authentication and distinguishes authenticated authorization', async () => {
    await request(app.getHttpServer()).get('/api/v1/supply/hotels').expect(401)
    const cookie = await login(`${suffix}-a@example.test`)
    await request(app.getHttpServer()).get('/api/v1/supply/hotels').set('Cookie', cookie).expect(403)
  })

  it('isolates tenant lists and ignores forged body/query/header tenant claims', async () => {
    const cookie = await login(`${suffix}-a@example.test`)
    const list = await supply(cookie, tenantAId).get('/api/v1/supply/hotels').expect(200)
    expect(list.body.data.map((hotel: { id: string }) => hotel.id)).toEqual([hotelAId])
    await supply(cookie, tenantBId).get('/api/v1/supply/hotels').expect(403)
    const created = await supply(cookie, tenantAId).post('/api/v1/supply/hotels?tenantId=' + tenantBId).set('x-tenant-id', tenantBId).send({ tenantId: tenantBId, name: `${suffix} Forged`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE' }).expect(201)
    const createdHotelId = created.body.data.id
    await expect(prisma.hotel.findFirst({ where: { id: createdHotelId, tenantId: tenantAId } })).resolves.not.toBeNull()
    await expect(prisma.hotel.findFirst({ where: { id: createdHotelId, tenantId: tenantBId } })).resolves.toBeNull()
    await prisma.hotel.delete({ where: { id: createdHotelId } })
  })

  it('certifies authoritative Room Master read, create, update, audit and tenant boundaries', async () => {
    const cookie = await login(`${suffix}-a@example.test`)
    const list = await supply(cookie, tenantAId).get(`/api/v1/supply/hotels/${hotelAId}/rooms`).expect(200)
    expect(list.body.data.map((room: { id: string }) => room.id)).toContain(roomAId)
    await supply(cookie, tenantAId).get(`/api/v1/supply/hotels/${hotelAId}/rooms/${roomAId}`).expect(200)

    const roomRequestId = `${suffix}-room-audit`
    const created = await supply(cookie, tenantAId).post(`/api/v1/supply/hotels/${hotelAId}/rooms`).set('x-request-id', roomRequestId).send({ name: 'Executive King', code: `${suffix}-EXEC`, maxAdults: 2, maxChildren: 1, maxOccupancy: 3, beddingMetadata: { description: 'King bed' } }).expect(201)
    const createdId = created.body.data.id
    await expect(prisma.roomType.findUnique({ where: { id: createdId } })).resolves.toMatchObject({ hotelId: hotelAId, maxOccupancy: 3 })
    await supply(cookie, tenantAId).patch(`/api/v1/supply/hotels/${hotelAId}/rooms/${createdId}`).send({ maxAdults: 2, maxChildren: 0, maxOccupancy: 2, isActive: false }).expect(200)
    await expect(prisma.roomType.findUnique({ where: { id: createdId } })).resolves.toMatchObject({ maxOccupancy: 2, isActive: false })
    await expect(prisma.auditEvent.findFirst({ where: { tenantId: tenantAId, entityId: createdId, action: 'supply.room.created' } })).resolves.toMatchObject({ payload: { outcome: 'allowed', requestId: roomRequestId } })

    await supply(cookie, tenantAId).get(`/api/v1/supply/hotels/${hotelBId}/rooms`).expect(404)
    await supply(cookie, tenantAId).get(`/api/v1/supply/hotels/${hotelBId}/rooms/${roomBId}`).expect(404)
    const before = await prisma.roomType.count({ where: { hotelId: hotelBId } })
    await supply(cookie, tenantAId).post(`/api/v1/supply/hotels/${hotelBId}/rooms`).send({ name: 'Blocked', code: `${suffix}-BLOCKED`, maxAdults: 2, maxOccupancy: 2 }).expect(404)
    await supply(cookie, tenantAId).patch(`/api/v1/supply/hotels/${hotelBId}/rooms/${roomBId}`).send({ name: 'Blocked update' }).expect(404)
    await expect(prisma.roomType.count({ where: { hotelId: hotelBId } })).resolves.toBe(before)
    await prisma.roomType.delete({ where: { id: createdId } })
  })

  it('certifies HTTP RBAC for read, create, rate, and availability operations', async () => {
    const cookie = await login(`${suffix}-a@example.test`)
    await supply(cookie, tenantAId).get('/api/v1/supply/hotels').expect(200)
    await supply(cookie, tenantAId).post('/api/v1/supply/hotels').send({ name: `${suffix} RBAC`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE' }).expect(201)
    await supply(cookie, tenantAId).post('/api/v1/supply/daily-rates').send({ ratePlanId: ratePlanAId, stayDate: '2026-10-01', occupancy: 2, amountMinor: '12000', currency: 'USD' }).expect(201)
    await supply(cookie, tenantAId).post('/api/v1/supply/availability').send({ ratePlanId: ratePlanAId, stayDate: '2026-10-01', allotment: 5, sold: 0 }).expect(201)
  })

  it('rejects cross-tenant RatePlan mutations without persisting rows', async () => {
    const cookie = await login(`${suffix}-a@example.test`)
    await supply(cookie, tenantAId).post('/api/v1/supply/daily-rates').send({ ratePlanId: ratePlanBId, stayDate: '2026-10-02', occupancy: 2, amountMinor: '12000', currency: 'USD' }).expect(400)
    await supply(cookie, tenantAId).post('/api/v1/supply/availability').send({ ratePlanId: ratePlanBId, stayDate: '2026-10-02', allotment: 5, sold: 0 }).expect(400)
    await expect(prisma.dailyRate.findFirst({ where: { ratePlanId: ratePlanBId, stayDate: new Date('2026-10-02T00:00:00.000Z') } })).resolves.toBeNull()
    await expect(prisma.dailyAvailability.findFirst({ where: { ratePlanId: ratePlanBId, stayDate: new Date('2026-10-02T00:00:00.000Z') } })).resolves.toBeNull()
  })

  it('persists supply audit metadata and request ID for an allowed HTTP mutation', async () => {
    const cookie = await login(`${suffix}-a@example.test`)
    const response = await supply(cookie, tenantAId).post('/api/v1/supply/daily-rates').set('x-request-id', requestId).send({ ratePlanId: ratePlanAId, stayDate: '2026-10-03', occupancy: 2, amountMinor: '12500', currency: 'USD' }).expect(201)
    const row = await prisma.dailyRate.findUnique({ where: { id: response.body.data.id } })
    expect(row?.tenantId).toBe(tenantAId)
    const audit = await prisma.auditEvent.findFirst({ where: { userId: userAId, tenantId: tenantAId, action: 'supply.daily_rate.updated', entityId: response.body.data.id }, orderBy: { createdAt: 'desc' } })
    expect(audit).toMatchObject({ actorType: 'USER', entityType: 'daily_rate' })
    expect(audit?.payload).toMatchObject({ outcome: 'allowed', requestId })
    expect(audit?.createdAt).toBeInstanceOf(Date)
  })

  it('does not create successful mutation audit evidence for rejected cross-tenant writes', async () => {
    const cookie = await login(`${suffix}-a@example.test`)
    const before = await prisma.auditEvent.count({ where: { userId: userAId, action: 'supply.daily_rate.updated' } })
    await supply(cookie, tenantAId).post('/api/v1/supply/daily-rates').send({ ratePlanId: ratePlanBId, stayDate: '2026-10-04', occupancy: 2, amountMinor: '12000', currency: 'USD' }).expect(400)
    await expect(prisma.auditEvent.count({ where: { userId: userAId, action: 'supply.daily_rate.updated' } })).resolves.toBe(before)
  })

  it('governs supplier hotel and room identities with tenant, status, and audit boundaries', async () => {
    const cookie = await login(`${suffix}-a@example.test`)
    const other = await prisma.supplierHotelMapping.create({ data: { tenantId: tenantBId, supplierId: supplierBId, hotelId: hotelBId, supplierHotelId: `${suffix}-B` } })
    const otherRoom = await prisma.supplierRoomMapping.create({ data: { tenantId: tenantBId, supplierHotelMappingId: other.id, hotelId: hotelBId, supplierRoomId: `${suffix}-BR`, roomTypeId: roomBId } })
    const path = '/api/v1/supply/mappings/hotels'
    await request(app.getHttpServer()).get(path).expect(401)
    await supply(cookie, tenantBId).get(path).expect(403)
    const list = await supply(cookie, tenantAId).get(path).expect(200)
    expect(list.body.data.some((row: { id: string }) => row.id === other.id)).toBe(false)
    await supply(cookie, tenantAId).get(`${path}/${other.id}`).expect(404)
    await supply(cookie, tenantAId).get(`${path}/${other.id}/rooms/${otherRoom.id}`).expect(404)
    const before = await prisma.supplierHotelMapping.count()
    await supply(cookie, tenantAId).post(path).send({ supplierId: supplierBId, hotelId: hotelAId, supplierHotelId: 'foreign' }).expect(400)
    await supply(cookie, tenantAId).post(path).send({ supplierId: supplierAId, hotelId: hotelBId, supplierHotelId: 'foreign' }).expect(400)
    await supply(cookie, tenantAId).post(path).send({ tenantId: tenantBId, supplierId: supplierAId, hotelId: hotelAId, supplierHotelId: 'forged-body' }).expect(400)
    await expect(prisma.supplierHotelMapping.count()).resolves.toBe(before)
    const created = await supply(cookie, tenantAId).post(`${path}?tenantId=${tenantBId}`).set('x-tenant-id', tenantBId).set('x-request-id', requestId)
      .send({ supplierId: supplierAId, hotelId: hotelAId, supplierHotelId: `${suffix}-A` }).expect(201)
    const mappingId = created.body.data.id as string
    expect(created.body.data.tenantId).toBe(tenantAId)
    await supply(cookie, tenantAId).patch(`${path}/${mappingId}`).send({ status: 'MAPPED' }).expect(400)
    await supply(cookie, tenantAId).patch(`${path}/${other.id}`).send({ confidence: 50 }).expect(404)
    await supply(cookie, tenantAId).post(`${path}/${mappingId}/approve`).expect(201)
    await supply(cookie, tenantAId).post(`${path}/${mappingId}/reject`).expect(400)
    await supply(cookie, tenantAId).post(`${path}/${mappingId}/reopen`).expect(201)
    await supply(cookie, tenantAId).post(`${path}/${mappingId}/reject`).expect(201)
    await supply(cookie, tenantAId).post(`${path}/${mappingId}/reopen`).expect(201)
    await supply(cookie, tenantAId).post(`${path}/${mappingId}/approve`).expect(201)
    for (const action of ['approved', 'rejected', 'reopened']) {
      await expect(prisma.auditEvent.count({ where: { entityId: mappingId, action: `supply.hotel_mapping.${action}` } })).resolves.toBeGreaterThan(0)
    }
    const roomPath = `${path}/${mappingId}/rooms`
    await supply(cookie, tenantAId).get(`${path}/${other.id}/rooms`).expect(404)
    await supply(cookie, tenantAId).post(`${path}/${other.id}/rooms`).send({ supplierRoomId: 'x', roomTypeId: roomAId }).expect(404)
    const roomsBefore = await prisma.supplierRoomMapping.count()
    await supply(cookie, tenantAId).post(roomPath).send({ supplierRoomId: 'wrong', roomTypeId: roomBId }).expect(400)
    await supply(cookie, tenantAId).post(roomPath).send({ tenantId: tenantBId, supplierRoomId: 'forged-body', roomTypeId: roomAId }).expect(400)
    await expect(prisma.supplierRoomMapping.count()).resolves.toBe(roomsBefore)
    const room = await supply(cookie, tenantAId).post(roomPath).set('x-request-id', requestId).send({ supplierRoomId: `${suffix}-RA`, roomTypeId: roomAId }).expect(201)
    const roomMappingId = room.body.data.id as string
    await supply(cookie, tenantAId).get(`${roomPath}/${roomMappingId}`).expect(200)
    await supply(cookie, tenantAId).get(`${path}/${other.id}/rooms/${roomMappingId}`).expect(404)
    await supply(cookie, tenantAId).patch(`${roomPath}/${roomMappingId}`).send({ status: 'MAPPED' }).expect(400)
    await supply(cookie, tenantAId).post(`${roomPath}/${roomMappingId}/approve`).expect(201)
    await supply(cookie, tenantAId).post(`${roomPath}/${roomMappingId}/reopen`).expect(201)
    for (const action of ['approved', 'rejected', 'reopened']) {
      await expect(prisma.auditEvent.count({ where: { entityId: roomMappingId, action: `supply.room_mapping.${action}` } })).resolves.toBeGreaterThan(0)
    }
    await supply(cookie, tenantAId).post(`${roomPath}/${roomMappingId}/reject`).expect(201)
    await supply(cookie, tenantAId).post(`${roomPath}/${roomMappingId}/reopen`).expect(201)
    const audit = await prisma.auditEvent.findFirst({ where: { entityId: roomMappingId, action: 'supply.room_mapping.created' } })
    expect(audit?.payload).toMatchObject({ requestId, outcome: 'allowed', hotelId: hotelAId, roomTypeId: roomAId })
    await expect(prisma.auditEvent.findFirst({ where: { action: 'supply.room_mapping.created', entityId: other.id } })).resolves.toBeNull()
    await prisma.supplierRoomMapping.delete({ where: { id: roomMappingId } })
    await prisma.supplierRoomMapping.delete({ where: { id: otherRoom.id } })
    await prisma.supplierHotelMapping.deleteMany({ where: { id: { in: [mappingId, other.id] } } })
  })

  it('denies mapping read and manage independently without their dedicated permissions', async () => {
    const cookie = await login(`${suffix}-a@example.test`)
    const read = await prisma.permission.findUniqueOrThrow({ where: { key: 'supply.mappings.read' } })
    const manage = await prisma.permission.findUniqueOrThrow({ where: { key: 'supply.mappings.manage' } })
    const roleId = roleIds[0]
    try {
      await prisma.rolePermission.delete({ where: { roleId_permissionId: { roleId, permissionId: read.id } } })
      await supply(cookie, tenantAId).get('/api/v1/supply/mappings/hotels').expect(403)
      await prisma.rolePermission.create({ data: { roleId, permissionId: read.id } })
      await prisma.rolePermission.delete({ where: { roleId_permissionId: { roleId, permissionId: manage.id } } })
      await supply(cookie, tenantAId).post('/api/v1/supply/mappings/hotels').send({ supplierId: supplierAId, hotelId: hotelAId, supplierHotelId: 'blocked' }).expect(403)
    } finally {
      for (const permissionId of [read.id, manage.id]) await prisma.rolePermission.upsert({ where: { roleId_permissionId: { roleId, permissionId } }, update: {}, create: { roleId, permissionId } })
    }
  })
})
