import { INestApplication, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { PrismaClient } from '@prisma/client'
import * as cookieParser from 'cookie-parser'
import * as request from 'supertest'
import { AppModule } from '../src/app.module'
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter'
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor'
import { hashPassword } from '../src/auth/utils/password'

const prisma = new PrismaClient()

describe('Supplier extranet organization scope', () => {
  const suffix = `xt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const password = 'supplier-extranet-foundation-password'
  const origin = 'http://localhost:3001'
  let app: INestApplication
  let tenantA = ''
  let tenantB = ''
  let supplierA1 = ''
  let supplierA2 = ''
  let supplierSuspended = ''
  let supplierB = ''
  let hotelA1 = ''
  let hotelA2 = ''
  let hotelShared = ''
  let hotelRejected = ''
  let hotelUnmapped = ''
  let hotelB = ''
  let roomA1 = ''
  let roomA2 = ''
  let roomShared = ''
  let roomB = ''
  const userIds: string[] = []
  const roleIds: string[] = []
  const emails: Record<string, string> = {}

  beforeAll(async () => {
    await prisma.$connect()
    const passwordHash = await hashPassword(password)
    const [a, b] = await Promise.all([
      prisma.tenant.create({ data: { name: `${suffix} A`, slug: `${suffix}-a` } }),
      prisma.tenant.create({ data: { name: `${suffix} B`, slug: `${suffix}-b` } }),
    ])
    tenantA = a.id
    tenantB = b.id
    const suppliers = await Promise.all([
      prisma.supplier.create({ data: { tenantId: tenantA, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${suffix} A1`, displayName: 'Org A1', countryCode: 'AE', defaultCurrency: 'AED' } }),
      prisma.supplier.create({ data: { tenantId: tenantA, type: 'DMC', status: 'ACTIVE', legalName: `${suffix} A2`, displayName: 'Org A2', countryCode: 'AE', defaultCurrency: 'AED' } }),
      prisma.supplier.create({ data: { tenantId: tenantA, type: 'HOTEL_DIRECT', status: 'SUSPENDED', legalName: `${suffix} suspended`, displayName: 'Suspended Org', countryCode: 'AE', defaultCurrency: 'AED' } }),
      prisma.supplier.create({ data: { tenantId: tenantB, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${suffix} B`, displayName: 'Org B', countryCode: 'OM', defaultCurrency: 'OMR' } }),
    ])
    supplierA1 = suppliers[0].id
    supplierA2 = suppliers[1].id
    supplierSuspended = suppliers[2].id
    supplierB = suppliers[3].id
    const hotels = await Promise.all([
      prisma.hotel.create({ data: { tenantId: tenantA, name: `${suffix} Hotel A1`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE' } }),
      prisma.hotel.create({ data: { tenantId: tenantA, name: `${suffix} Hotel A2`, propertyType: 'HOTEL', city: 'Abu Dhabi', countryCode: 'AE' } }),
      prisma.hotel.create({ data: { tenantId: tenantA, name: `${suffix} Shared`, propertyType: 'HOTEL', city: 'Sharjah', countryCode: 'AE' } }),
      prisma.hotel.create({ data: { tenantId: tenantA, name: `${suffix} Rejected`, propertyType: 'HOTEL', city: 'Ajman', countryCode: 'AE' } }),
      prisma.hotel.create({ data: { tenantId: tenantA, name: `${suffix} Unmapped`, propertyType: 'HOTEL', city: 'Fujairah', countryCode: 'AE' } }),
      prisma.hotel.create({ data: { tenantId: tenantB, name: `${suffix} Hotel B`, propertyType: 'HOTEL', city: 'Muscat', countryCode: 'OM' } }),
    ])
    ;[hotelA1, hotelA2, hotelShared, hotelRejected, hotelUnmapped, hotelB] = hotels.map((hotel) => hotel.id)
    const rooms = await Promise.all([
      prisma.roomType.create({ data: { hotelId: hotelA1, name: 'Room A1', code: `${suffix}-A1`, maxAdults: 2, maxOccupancy: 2 } }),
      prisma.roomType.create({ data: { hotelId: hotelA2, name: 'Room A2', code: `${suffix}-A2`, maxAdults: 2, maxOccupancy: 2 } }),
      prisma.roomType.create({ data: { hotelId: hotelShared, name: 'Room Shared', code: `${suffix}-S`, maxAdults: 2, maxOccupancy: 3 } }),
      prisma.roomType.create({ data: { hotelId: hotelB, name: 'Room B', code: `${suffix}-B`, maxAdults: 2, maxOccupancy: 2 } }),
    ])
    ;[roomA1, roomA2, roomShared, roomB] = rooms.map((room) => room.id)
    const mapping = (supplierId: string, hotelId: string, status: 'MAPPED' | 'PENDING' | 'REJECTED') => prisma.supplierHotelMapping.create({
      data: { tenantId: supplierId === supplierB ? tenantB : tenantA, supplierId, hotelId, supplierHotelId: `${supplierId}-${hotelId}`, status },
    })
    await Promise.all([
      mapping(supplierA1, hotelA1, 'MAPPED'),
      mapping(supplierA2, hotelA2, 'MAPPED'),
      mapping(supplierA1, hotelShared, 'PENDING'),
      mapping(supplierA2, hotelShared, 'MAPPED'),
      mapping(supplierA1, hotelRejected, 'REJECTED'),
      mapping(supplierB, hotelB, 'MAPPED'),
    ])

    const permissionKeys = [
      'supplier.extranet.hotels.read', 'supplier.extranet.rooms.read', 'supplier.extranet.drafts.manage',
      'supply.suppliers.read', 'supply.hotels.read',
    ]
    const permissions = await Promise.all(permissionKeys.map((key) => prisma.permission.upsert({ where: { key }, update: {}, create: { key, description: key } })))
    const byKey = new Map(permissions.map((permission) => [permission.key, permission.id]))
    const extranet = ['supplier.extranet.hotels.read', 'supplier.extranet.rooms.read', 'supplier.extranet.drafts.manage']
    const readOnly = ['supplier.extranet.hotels.read', 'supplier.extranet.rooms.read']
    async function role(tenantId: string, name: string, keys: string[]) {
      const created = await prisma.role.create({ data: { tenantId, name: `${suffix}-${name}` } })
      roleIds.push(created.id)
      await prisma.rolePermission.createMany({ data: keys.map((key) => ({ roleId: created.id, permissionId: byKey.get(key)! })) })
      return created.id
    }
    const roleA = await role(tenantA, 'extranet', extranet)
    const roleRead = await role(tenantA, 'readonly', readOnly)
    const roleAdmin = await role(tenantA, 'admin', ['supply.suppliers.read', 'supply.hotels.read'])
    const roleB = await role(tenantB, 'extranet-b', extranet)

    async function user(key: string, tenantId: string, roleId: string, memberships: { supplierId: string; status?: 'ACTIVE' | 'SUSPENDED' | 'REVOKED' }[]) {
      const email = `${suffix}-${key}@example.test`
      const created = await prisma.user.create({ data: { email, passwordHash, name: key } })
      userIds.push(created.id)
      emails[key] = email
      await prisma.membership.create({ data: { tenantId, userId: created.id, role: 'member' } })
      await prisma.userRole.create({ data: { tenantId, userId: created.id, roleId } })
      if (memberships.length) {
        await prisma.supplierMembership.createMany({ data: memberships.map((membership) => ({ tenantId, userId: created.id, supplierId: membership.supplierId, status: membership.status ?? 'ACTIVE' })) })
      }
      return created.id
    }
    await user('a1', tenantA, roleA, [{ supplierId: supplierA1 }])
    await user('a2', tenantA, roleA, [{ supplierId: supplierA2 }])
    await user('read', tenantA, roleRead, [{ supplierId: supplierA1 }])
    await user('multi', tenantA, roleA, [{ supplierId: supplierA1 }, { supplierId: supplierA2 }])
    await user('revoked', tenantA, roleA, [{ supplierId: supplierA1, status: 'REVOKED' }])
    await user('suspended', tenantA, roleA, [{ supplierId: supplierA1, status: 'SUSPENDED' }])
    await user('closed-org', tenantA, roleA, [{ supplierId: supplierSuspended }])
    await user('admin', tenantA, roleAdmin, [])
    await user('b', tenantB, roleB, [{ supplierId: supplierB }])

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication()
    app.use(cookieParser())
    app.setGlobalPrefix('api/v1')
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
    app.useGlobalFilters(new HttpExceptionFilter())
    app.useGlobalInterceptors(new ResponseInterceptor())
    await app.init()
  }, 60000)

  afterAll(async () => {
    await app?.close()
    await prisma.auditEvent.deleteMany({ where: { OR: [{ tenantId: { in: [tenantA, tenantB] } }, { userId: { in: userIds } }] } })
    await prisma.supplierRoomDraft.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } })
    await prisma.supplierHotelMapping.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } })
    await prisma.supplierMembership.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } })
    await prisma.roomType.deleteMany({ where: { id: { in: [roomA1, roomA2, roomShared, roomB] } } })
    await prisma.hotel.deleteMany({ where: { id: { in: [hotelA1, hotelA2, hotelShared, hotelRejected, hotelUnmapped, hotelB] } } })
    await prisma.supplier.deleteMany({ where: { id: { in: [supplierA1, supplierA2, supplierSuspended, supplierB] } } })
    await prisma.userRole.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.rolePermission.deleteMany({ where: { roleId: { in: roleIds } } })
    await prisma.role.deleteMany({ where: { id: { in: roleIds } } })
    await prisma.membership.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.session.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.user.deleteMany({ where: { id: { in: userIds } } })
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } })
    await prisma.$disconnect()
  })

  async function login(key: string) {
    const response = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', origin).send({ email: emails[key], password }).expect(200)
    return response.headers['set-cookie'][0].split(';')[0]
  }

  function call(cookie: string, tenantId: string, supplierId?: string) {
    const configure = (test: request.Test) => {
      test.set('Cookie', cookie).set('Origin', origin).set('x-fbeds-tenant-id', tenantId)
      if (supplierId) test.set('x-fbeds-supplier-id', supplierId)
      return test
    }
    return {
      get: (path: string) => configure(request(app.getHttpServer()).get(path)),
      patch: (path: string) => configure(request(app.getHttpServer()).patch(path)),
    }
  }

  it('blocks unauthenticated extranet and supply reads', async () => {
    await request(app.getHttpServer()).get('/api/v1/supplier/extranet/hotels').expect(401)
    await request(app.getHttpServer()).get('/api/v1/supply/hotels').expect(401)
  })

  it('lets a supplier read only mapped hotels and rooms in that organization', async () => {
    const cookie = await login('a1')
    const hotels = await call(cookie, tenantA).get('/api/v1/supplier/extranet/hotels').expect(200)
    const ids = hotels.body.data.hotels.map((hotel: { id: string }) => hotel.id).sort()
    expect(ids).toEqual([hotelA1, hotelShared].sort())
    expect(hotels.body.data.hotels.every((hotel: { mappingStatus: string }) => hotel.mappingStatus === 'MAPPED' || hotel.mappingStatus === 'PENDING')).toBe(true)
    const rooms = await call(cookie, tenantA).get(`/api/v1/supplier/extranet/hotels/${hotelA1}/rooms`).expect(200)
    expect(rooms.body.data.rooms.map((room: { id: string }) => room.id)).toEqual([roomA1])
    await call(cookie, tenantA).get(`/api/v1/supplier/extranet/hotels/${hotelA2}`).expect(404)
    await call(cookie, tenantA).get(`/api/v1/supplier/extranet/hotels/${hotelRejected}`).expect(404)
    await call(cookie, tenantA).get(`/api/v1/supplier/extranet/hotels/${hotelUnmapped}`).expect(404)
    await call(cookie, tenantA).get(`/api/v1/supplier/extranet/hotels/${hotelB}`).expect(404)
  })

  it('denies the other organization in the same tenant, forged selectors, and cross-tenant access', async () => {
    const cookie = await login('a1')
    const before = await prisma.supplierRoomDraft.count({ where: { tenantId: tenantA } })
    await call(cookie, tenantA, supplierA2).get('/api/v1/supplier/extranet/hotels').expect(403)
    await call(cookie, tenantB).get('/api/v1/supplier/extranet/hotels').expect(403)
    await call(cookie, tenantA, 'forged-supplier').get(`/api/v1/supplier/extranet/hotels/${hotelA1}/rooms`).expect(403)
    await call(cookie, tenantA).patch(`/api/v1/supplier/extranet/hotels/${hotelA2}/rooms/${roomA2}/draft`).send({ supplierNotes: 'should not save' }).expect(404)
    await call(cookie, tenantA).patch(`/api/v1/supplier/extranet/hotels/${hotelA1}/rooms/${roomA2}/draft`).send({ supplierNotes: 'wrong room' }).expect(404)
    await call(cookie, tenantA).patch(`/api/v1/supplier/extranet/hotels/${hotelB}/rooms/${roomB}/draft`).send({ supplierNotes: 'cross tenant' }).expect(404)
    expect(await prisma.supplierRoomDraft.count({ where: { tenantId: tenantA } })).toBe(before)
    expect(await prisma.supplierRoomDraft.count({ where: { tenantId: tenantB } })).toBe(0)
  })

  it('requires an explicit organization when membership is ambiguous and rejects inactive memberships', async () => {
    const multi = await login('multi')
    await call(multi, tenantA).get('/api/v1/supplier/extranet/hotels').expect(403)
    const chosen = await call(multi, tenantA, supplierA2).get('/api/v1/supplier/extranet/hotels').expect(200)
    expect(chosen.body.data.hotels.map((hotel: { id: string }) => hotel.id).sort()).toEqual([hotelA2, hotelShared].sort())
    await call(multi, tenantA, supplierA1).get(`/api/v1/supplier/extranet/hotels/${hotelA2}`).expect(404)
    for (const key of ['revoked', 'suspended', 'closed-org']) {
      const cookie = await login(key)
      await call(cookie, tenantA).get('/api/v1/supplier/extranet/memberships').expect(200)
      expect((await call(cookie, tenantA).get('/api/v1/supplier/extranet/memberships')).body.data.organizations).toEqual([])
      await call(cookie, tenantA).get('/api/v1/supplier/extranet/hotels').expect(403)
    }
  })

  it('persists a private note with audit evidence and leaves master rows unchanged', async () => {
    const cookie = await login('a1')
    const hotelBefore = await prisma.hotel.findUniqueOrThrow({ where: { id: hotelShared } })
    const roomBefore = await prisma.roomType.findUniqueOrThrow({ where: { id: roomShared } })
    const requestId = `${suffix}-draft`
    const saved = await call(cookie, tenantA).patch(`/api/v1/supplier/extranet/hotels/${hotelShared}/rooms/${roomShared}/draft`).set('X-Request-ID', requestId).send({ supplierNotes: '  Arrival desk is on the left  ' }).expect(200)
    expect(saved.body.data.supplierNotes).toBe('Arrival desk is on the left')
    const audit = await prisma.auditEvent.findFirst({ where: { tenantId: tenantA, action: 'supplier.room_draft.updated', entityId: saved.body.data.id } })
    expect(audit?.payload).toMatchObject({ outcome: 'allowed', requestId, fields: ['supplierNotes'] })
    expect(JSON.stringify(audit?.payload)).not.toContain('Arrival desk')
    const rooms = await call(cookie, tenantA).get(`/api/v1/supplier/extranet/hotels/${hotelShared}/rooms`).expect(200)
    expect(rooms.body.data.rooms[0].draft.supplierNotes).toBe('Arrival desk is on the left')
    const other = await login('a2')
    const otherRooms = await call(other, tenantA).get(`/api/v1/supplier/extranet/hotels/${hotelShared}/rooms`).expect(200)
    expect(otherRooms.body.data.rooms[0].draft).toBeNull()
    const hotelAfter = await prisma.hotel.findUniqueOrThrow({ where: { id: hotelShared } })
    const roomAfter = await prisma.roomType.findUniqueOrThrow({ where: { id: roomShared } })
    expect(hotelAfter.updatedAt.toISOString()).toBe(hotelBefore.updatedAt.toISOString())
    expect(roomAfter.name).toBe(roomBefore.name)
    expect(roomAfter.updatedAt.toISOString()).toBe(roomBefore.updatedAt.toISOString())
  })

  it('rejects read-only and forged draft bodies without changing the note', async () => {
    const reader = await login('read')
    await call(reader, tenantA).patch(`/api/v1/supplier/extranet/hotels/${hotelShared}/rooms/${roomShared}/draft`).send({ supplierNotes: 'reader overwrite' }).expect(403)
    const editor = await login('a1')
    await call(editor, tenantA).patch(`/api/v1/supplier/extranet/hotels/${hotelShared}/rooms/${roomShared}/draft`).send({ supplierNotes: 'kept', supplierId: supplierA2, tenantId: tenantB }).expect(400)
    const note = await prisma.supplierRoomDraft.findFirstOrThrow({ where: { tenantId: tenantA, supplierId: supplierA1, roomTypeId: roomShared } })
    expect(note.supplierNotes).toBe('Arrival desk is on the left')
    expect(note.supplierId).toBe(supplierA1)
  })

  it('keeps admin supply tenant-scoped and does not grant extranet access', async () => {
    const admin = await login('admin')
    const suppliers = await call(admin, tenantA).get('/api/v1/supply/suppliers').expect(200)
    const names = suppliers.body.data.items.map((item: { displayName: string }) => item.displayName).sort()
    expect(names).toEqual(['Org A1', 'Org A2', 'Suspended Org'])
    await call(admin, tenantA).get('/api/v1/supplier/extranet/hotels').expect(403)
    const supplierUser = await login('a1')
    await call(supplierUser, tenantA).get('/api/v1/supply/hotels').expect(403)
  })

  it('invalidates the session on logout', async () => {
    const cookie = await login('a1')
    await call(cookie, tenantA).get('/api/v1/supplier/extranet/hotels').expect(200)
    await request(app.getHttpServer()).post('/api/v1/auth/logout').set('Cookie', cookie).set('Origin', origin).expect(200)
    await request(app.getHttpServer()).get('/api/v1/supplier/extranet/hotels').set('Cookie', cookie).set('x-fbeds-tenant-id', tenantA).expect(401)
  })
})
