import { INestApplication, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import * as cookieParser from 'cookie-parser'
import * as request from 'supertest'
import { PrismaClient } from '@prisma/client'
import { AppModule } from '../src/app.module'
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor'
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter'
import { hashPassword } from '../src/auth/utils/password'

/**
 * One-hotel Admin commercial golden path, driven only through the authoritative HTTP API the Admin UI uses:
 * Supplier → Hotel → Room → Board Basis → Hotel Mapping → Room Mapping → Contract → Rate Plan → Daily Rate → Availability → Sellability.
 * Runs against a disposable database only (see CI). Every id is asserted to be linked, not just displayed.
 */
const prisma = new PrismaClient()
const DAY = 86_400_000
const iso = (offsetDays: number) => new Date(Math.floor(Date.now() / DAY) * DAY + offsetDays * DAY).toISOString().slice(0, 10)

describe('Admin one-hotel golden path (Dubai, AED, 1 room, 2 adults)', () => {
  const suffix = `golden-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const password = 'golden-path-certification-password'
  const start = iso(14)
  const nights = Array.from({ length: 7 }, (_, offset) => iso(14 + offset))
  let app: INestApplication
  let tenantId: string, otherTenantId: string
  let operator: string, readOnly: string, outsider: string
  const ids: Record<string, string> = {}
  const userIds: string[] = []
  const roleIds: string[] = []

  const api = (cookie: string, tenant = tenantId) => {
    const configure = (test: request.Test) => test.set('Cookie', cookie).set('x-fbeds-tenant-id', tenant)
    return {
      get: (path: string) => configure(request(app.getHttpServer()).get(`/api/v1${path}`)),
      post: (path: string, body: object = {}) => configure(request(app.getHttpServer()).post(`/api/v1${path}`)).send(body),
      patch: (path: string, body: object) => configure(request(app.getHttpServer()).patch(`/api/v1${path}`)).send(body),
    }
  }
  const login = async (email: string) => {
    const response = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', 'http://localhost:3001').send({ email, password }).expect(200)
    return (response.headers['set-cookie'][0] as string).split(';')[0]
  }
  const sellable = async (body: Record<string, unknown>) => (await api(operator).post('/supply/sellability', { ratePlanId: ids.ratePlan, stayDate: start, occupancy: 2, ...body }).expect(201)).body.data as { eligible: boolean; status: string; reasons: string[] }

  beforeAll(async () => {
    await prisma.$connect()
    const [tenant, other] = await Promise.all([
      prisma.tenant.create({ data: { name: `${suffix} Tenant`, slug: suffix } }),
      prisma.tenant.create({ data: { name: `${suffix} Other`, slug: `${suffix}-other` } }),
    ])
    tenantId = tenant.id
    otherTenantId = other.id
    const passwordHash = await hashPassword(password)
    const users = await Promise.all(['operator', 'readonly', 'outsider'].map((name) => prisma.user.create({ data: { email: `${suffix}-${name}@example.test`, passwordHash } })))
    userIds.push(...users.map((user) => user.id))
    const keys = ['hotels', 'rooms', 'rates', 'contracts', 'availability', 'suppliers', 'mappings'].flatMap((area) => [`supply.${area}.read`, `supply.${area}.manage`])
    const permissions = await Promise.all([...keys].map((key) => prisma.permission.upsert({ where: { key }, update: {}, create: { key, description: key } })))
    const grant = async (tenant: string, name: string, granted: typeof permissions) => {
      const role = await prisma.role.create({ data: { tenantId: tenant, name: `${suffix}-${name}` } })
      roleIds.push(role.id)
      await prisma.rolePermission.createMany({ data: granted.map((permission) => ({ roleId: role.id, permissionId: permission.id })) })
      return role.id
    }
    const operatorRole = await grant(tenantId, 'operator', permissions)
    const readOnlyRole = await grant(tenantId, 'readonly', permissions.filter((permission) => permission.key.endsWith('.read')))
    const outsiderRole = await grant(otherTenantId, 'outsider', permissions)
    await prisma.membership.createMany({ data: [{ tenantId, userId: userIds[0], role: 'owner' }, { tenantId, userId: userIds[1], role: 'member' }, { tenantId: otherTenantId, userId: userIds[2], role: 'owner' }] })
    await prisma.userRole.createMany({ data: [{ tenantId, userId: userIds[0], roleId: operatorRole }, { tenantId, userId: userIds[1], roleId: readOnlyRole }, { tenantId: otherTenantId, userId: userIds[2], roleId: outsiderRole }] })

    const module = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = module.createNestApplication()
    app.use(cookieParser())
    app.setGlobalPrefix('api/v1')
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
    app.useGlobalFilters(new HttpExceptionFilter())
    app.useGlobalInterceptors(new ResponseInterceptor())
    await app.init()
    operator = await login(`${suffix}-operator@example.test`)
    readOnly = await login(`${suffix}-readonly@example.test`)
    outsider = await login(`${suffix}-outsider@example.test`)
  }, 60000)

  afterAll(async () => {
    await app?.close()
    const tenants = { in: [tenantId, otherTenantId] }
    await prisma.auditEvent.deleteMany({ where: { tenantId: tenants } })
    await prisma.dailyRate.deleteMany({ where: { tenantId: tenants } })
    await prisma.dailyAvailability.deleteMany({ where: { tenantId: tenants } })
    await prisma.ratePlan.deleteMany({ where: { tenantId: tenants } })
    await prisma.contract.deleteMany({ where: { tenantId: tenants } })
    await prisma.supplierRoomMapping.deleteMany({ where: { tenantId: tenants } })
    await prisma.supplierHotelMapping.deleteMany({ where: { tenantId: tenants } })
    await prisma.roomType.deleteMany({ where: { hotel: { tenantId: tenants } } })
    await prisma.hotel.deleteMany({ where: { tenantId: tenants } })
    await prisma.boardBasis.deleteMany({ where: { tenantId: tenants } })
    await prisma.supplier.deleteMany({ where: { tenantId: tenants } })
    await prisma.userRole.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.rolePermission.deleteMany({ where: { roleId: { in: roleIds } } })
    await prisma.role.deleteMany({ where: { id: { in: roleIds } } })
    await prisma.membership.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.session.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.user.deleteMany({ where: { id: { in: userIds } } })
    await prisma.tenant.deleteMany({ where: { id: tenants } })
    await prisma.$disconnect()
  })

  it('exposes only the caller\'s own supply permissions for UI gating', async () => {
    const write = (await api(operator).get('/supply/capabilities').expect(200)).body.data.permissions as string[]
    const read = (await api(readOnly).get('/supply/capabilities').expect(200)).body.data.permissions as string[]
    expect(write).toContain('supply.contracts.manage')
    expect(read).toContain('supply.contracts.read')
    expect(read.some((key) => key.endsWith('.manage'))).toBe(false)
    await request(app.getHttpServer()).get('/api/v1/supply/capabilities').expect(401)
  })

  it('builds one Dubai hotel through authoritative APIs', async () => {
    const supplier = await api(operator).post('/supply/suppliers', { type: 'DMC', status: 'ACTIVE', legalName: `${suffix} Supplier LLC`, displayName: 'Golden Supplier', countryCode: 'AE', defaultCurrency: 'AED' }).expect(201)
    ids.supplier = supplier.body.data.id
    const hotel = await api(operator).post('/supply/hotels', { name: `${suffix} Dubai Marina Hotel`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', starRating: 4 }).expect(201)
    ids.hotel = hotel.body.data.id
    const room = await api(operator).post(`/supply/hotels/${ids.hotel}/rooms`, { name: 'Deluxe King', code: 'DLX', maxAdults: 2, maxChildren: 1, maxOccupancy: 3 }).expect(201)
    ids.room = room.body.data.id
    const board = await api(operator).post('/supply/board-bases', { code: 'BB', name: 'Bed & Breakfast' }).expect(201)
    ids.board = board.body.data.id

    const hotelMapping = await api(operator).post('/supply/mappings/hotels', { supplierId: ids.supplier, hotelId: ids.hotel, supplierHotelId: 'SUP-DXB-001' }).expect(201)
    ids.hotelMapping = hotelMapping.body.data.id
    expect(hotelMapping.body.data.status).toBe('PENDING')
    const roomMapping = await api(operator).post(`/supply/mappings/hotels/${ids.hotelMapping}/rooms`, { supplierRoomId: 'SUP-DLX', roomTypeId: ids.room }).expect(201)
    ids.roomMapping = roomMapping.body.data.id
    await api(operator).post(`/supply/mappings/hotels/${ids.hotelMapping}/approve`).expect(201)
    await api(operator).post(`/supply/mappings/hotels/${ids.hotelMapping}/rooms/${ids.roomMapping}/approve`).expect(201)

    const contract = await api(operator).post('/supply/contracts', { supplierId: ids.supplier, supplierHotelMappingId: ids.hotelMapping, code: `${suffix}-C1`, validFrom: iso(-30), validTo: iso(365), settlementCurrency: 'AED', salesMarkets: ['AE'], nationalities: [] }).expect(201)
    ids.contract = contract.body.data.id
    expect(contract.body.data).toMatchObject({ status: 'DRAFT', supplierId: ids.supplier, supplierHotelMappingId: ids.hotelMapping, settlementCurrency: 'AED' })
    await api(operator).post(`/supply/contracts/${ids.contract}/policies/cancellation`, { daysBeforeCheckin: 7, penaltyPercent: 100 }).expect(201)
    await api(operator).post(`/supply/contracts/${ids.contract}/policies/lead-time`, { minLeadHours: 24 }).expect(201)
    await api(operator).patch(`/supply/contracts/${ids.contract}`, { status: 'ACTIVE' }).expect(200)

    const plan = await api(operator).post('/supply/rate-plans', { contractId: ids.contract, roomTypeId: ids.room, boardBasisId: ids.board, code: 'DLX-BB-2A', occupancy: 2, currency: 'AED', refundable: true, taxesIncluded: false, feesIncluded: false, minStay: 1, releaseDays: 0 }).expect(201)
    ids.ratePlan = plan.body.data.id
    expect(plan.body.data).toMatchObject({ contractId: ids.contract, roomTypeId: ids.room, boardBasisId: ids.board, status: 'DRAFT', currency: 'AED' })
    await api(operator).patch(`/supply/rate-plans/${ids.ratePlan}`, { status: 'ACTIVE' }).expect(200)

    await api(operator).post('/supply/daily-rates/bulk', { rows: nights.map((stayDate) => ({ ratePlanId: ids.ratePlan, stayDate, occupancy: 2, amountMinor: '45000', amountBasis: 'SELL', currency: 'AED' })) }).expect(201)
    await api(operator).post('/supply/availability/bulk', { rows: nights.map((stayDate) => ({ ratePlanId: ids.ratePlan, stayDate, allotment: 5, sold: 0, stopSell: false, minStay: 1 })) }).expect(201)
  })

  it('links every identifier correctly in the database', async () => {
    const plan = await prisma.ratePlan.findUniqueOrThrow({ where: { id: ids.ratePlan }, include: { contract: { include: { supplierHotelMapping: { include: { roomMappings: true } } } }, roomType: true, dailyRates: true, availability: true } })
    expect(plan.tenantId).toBe(tenantId)
    expect(plan.roomType.hotelId).toBe(ids.hotel)
    expect(plan.boardBasisId).toBe(ids.board)
    expect(plan.contract.supplierId).toBe(ids.supplier)
    expect(plan.contract.supplierHotelMapping).toMatchObject({ id: ids.hotelMapping, hotelId: ids.hotel, supplierId: ids.supplier, status: 'MAPPED' })
    expect(plan.contract.supplierHotelMapping!.roomMappings).toEqual([expect.objectContaining({ id: ids.roomMapping, roomTypeId: ids.room, status: 'MAPPED' })])
    expect(plan.dailyRates).toHaveLength(7)
    expect(plan.dailyRates.every((rate) => rate.tenantId === tenantId && rate.currency === 'AED' && rate.amountMinor === 45000n && rate.amountBasis === 'SELL')).toBe(true)
    expect(plan.availability).toHaveLength(7)
    const audits = await prisma.auditEvent.findMany({ where: { tenantId, action: { startsWith: 'supply.' } }, select: { action: true } })
    for (const action of ['supply.supplier.created', 'supply.hotel.created', 'supply.room.created', 'supply.board_basis.created', 'supply.contract.created', 'supply.rate_plan.created', 'supply.daily_rate.updated', 'supply.availability.updated']) expect(audits.map((event) => event.action)).toContain(action)
  })

  it('reaches SELLABLE for every night of the seven-night stay', async () => {
    for (const stayDate of nights) expect(await sellable({ stayDate, checkInDate: start, nights: 7 })).toEqual({ eligible: true, status: 'ELIGIBLE_FOR_FUTURE_SEARCH', reasons: [] })
    // AED amounts are read back as integer minor-unit strings, never floats.
    const rates = (await api(operator).get(`/supply/daily-rates?from=${start}&to=${nights[6]}&ratePlanId=${ids.ratePlan}`).expect(200)).body.data as Array<{ amountMinor: string }>
    expect(rates.map((rate) => rate.amountMinor)).toEqual(Array(7).fill('45000'))
  })

  describe('negative scenarios', () => {
    const restore = async () => {
      await prisma.supplier.update({ where: { id: ids.supplier }, data: { status: 'ACTIVE' } })
      await prisma.contract.update({ where: { id: ids.contract }, data: { status: 'ACTIVE', validTo: new Date(`${iso(365)}T00:00:00.000Z`) } })
      await prisma.ratePlan.update({ where: { id: ids.ratePlan }, data: { status: 'ACTIVE', minStay: 1, maxStay: null, releaseDays: 0 } })
      await prisma.dailyAvailability.updateMany({ where: { ratePlanId: ids.ratePlan }, data: { allotment: 5, stopSell: false, minStay: 1 } })
      await prisma.supplierRoomMapping.update({ where: { id: ids.roomMapping }, data: { status: 'MAPPED' } })
      await prisma.supplierHotelMapping.update({ where: { id: ids.hotelMapping }, data: { status: 'MAPPED' } })
    }
    afterEach(restore)

    it('1-4. rejects missing, invalid, expired sessions, missing permission and cross-tenant access', async () => {
      await request(app.getHttpServer()).get('/api/v1/supply/contracts').expect(401)
      await request(app.getHttpServer()).get('/api/v1/supply/contracts').set('Cookie', 'fbeds_session=forged').expect(401)
      const expiring = await login(`${suffix}-readonly@example.test`)
      await prisma.session.updateMany({ where: { userId: userIds[1] }, data: { expiresAt: new Date(Date.now() - 1000) } })
      await api(expiring).get('/supply/contracts').expect(401)
      await api(readOnly).get('/supply/contracts').expect(401) // same user's older session was expired above
      const fresh = await login(`${suffix}-readonly@example.test`)
      await api(fresh).get('/supply/contracts').expect(200)
      await api(fresh).post('/supply/contracts', { supplierId: ids.supplier, code: 'DENIED', validFrom: iso(0), validTo: iso(10), settlementCurrency: 'AED' }).expect(403)
      await api(fresh).patch(`/supply/rate-plans/${ids.ratePlan}`, { status: 'SUSPENDED' }).expect(403)
      await api(outsider, otherTenantId).get(`/supply/contracts/${ids.contract}`).expect(404)
      await api(outsider, otherTenantId).get(`/supply/rate-plans/${ids.ratePlan}`).expect(404)
      await api(outsider, tenantId).get('/supply/contracts').expect(403)
      const listed = (await api(outsider, otherTenantId).get('/supply/contracts').expect(200)).body.data as unknown[]
      expect(listed).toHaveLength(0)
    })

    it('5-6. rejects invalid hotel and invalid room/hotel relationships', async () => {
      await api(operator).post('/supply/mappings/hotels', { supplierId: ids.supplier, hotelId: 'does-not-exist', supplierHotelId: 'X' }).expect((res) => expect([400, 404]).toContain(res.status))
      const secondHotel = await api(operator).post('/supply/hotels', { name: `${suffix} Second`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE' }).expect(201)
      const strayRoom = await api(operator).post(`/supply/hotels/${secondHotel.body.data.id}/rooms`, { name: 'Stray', code: 'STR', maxAdults: 2, maxOccupancy: 2 }).expect(201)
      await api(operator).post(`/supply/mappings/hotels/${ids.hotelMapping}/rooms`, { supplierRoomId: 'SUP-STRAY', roomTypeId: strayRoom.body.data.id }).expect((res) => expect([400, 404]).toContain(res.status))
      await api(operator).post('/supply/rate-plans', { contractId: ids.contract, roomTypeId: strayRoom.body.data.id, boardBasisId: ids.board, code: 'STRAY', occupancy: 2, currency: 'AED' }).expect(400)
    })

    it('7-8. makes the stay unsellable while hotel or room mappings are not approved', async () => {
      await api(operator).post('/supply/mappings/hotels', { supplierId: ids.supplier, hotelId: (await prisma.hotel.create({ data: { tenantId, name: `${suffix} Pending`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE' } })).id, supplierHotelId: 'SUP-PENDING' }).expect(201)
      const pending = await prisma.supplierHotelMapping.findFirstOrThrow({ where: { tenantId, supplierHotelId: 'SUP-PENDING' } })
      await api(operator).post('/supply/contracts', { supplierId: ids.supplier, supplierHotelMappingId: pending.id, code: `${suffix}-PENDING`, validFrom: iso(0), validTo: iso(10), settlementCurrency: 'AED' }).expect(400)
      await prisma.supplierRoomMapping.update({ where: { id: ids.roomMapping }, data: { status: 'PENDING' } })
      expect((await sellable({})).reasons).toContain('ROOM_MAPPING_UNAPPROVED')
      await prisma.supplierHotelMapping.update({ where: { id: ids.hotelMapping }, data: { status: 'PENDING' } })
      expect((await sellable({})).reasons).toContain('SUPPLIER_MAPPING_INVALID')
    })

    it('9-11. blocks inactive supplier, inactive contract and expired contract', async () => {
      await prisma.supplier.update({ where: { id: ids.supplier }, data: { status: 'SUSPENDED' } })
      expect((await sellable({})).reasons).toContain('SUPPLIER_INACTIVE')
      await restore()
      await prisma.contract.update({ where: { id: ids.contract }, data: { status: 'SUSPENDED' } })
      expect((await sellable({})).reasons).toContain('CONTRACT_INACTIVE')
      await restore()
      await prisma.contract.update({ where: { id: ids.contract }, data: { validTo: new Date(`${iso(15)}T00:00:00.000Z`) } })
      expect((await sellable({ stayDate: iso(18) })).reasons).toContain('OUTSIDE_CONTRACT_VALIDITY')
    })

    it('12-13. rejects foreign rate-plan relationships and currency mismatches', async () => {
      const foreignSupplier = await prisma.supplier.create({ data: { tenantId: otherTenantId, type: 'DMC', status: 'ACTIVE', legalName: `${suffix} Foreign`, displayName: 'Foreign', countryCode: 'AE', defaultCurrency: 'AED' } })
      const foreignContract = await prisma.contract.create({ data: { tenantId: otherTenantId, supplierId: foreignSupplier.id, code: `${suffix}-FC`, validFrom: new Date(`${iso(0)}T00:00:00.000Z`), validTo: new Date(`${iso(100)}T00:00:00.000Z`), settlementCurrency: 'AED' } })
      await api(operator).post('/supply/rate-plans', { contractId: foreignContract.id, roomTypeId: ids.room, boardBasisId: ids.board, code: 'FOREIGN', occupancy: 2, currency: 'AED' }).expect(400)
      await api(operator).post('/supply/daily-rates', { ratePlanId: ids.ratePlan, stayDate: start, occupancy: 2, amountMinor: '45000', amountBasis: 'SELL', currency: 'USD' }).expect(400)
      await prisma.contract.delete({ where: { id: foreignContract.id } })
      await prisma.supplier.delete({ where: { id: foreignSupplier.id } })
    })

    it('14-17. reports missing rate, zero availability, stop sell and unsupported occupancy with backend reason codes', async () => {
      const gap = iso(40)
      expect((await sellable({ stayDate: gap })).reasons).toEqual(expect.arrayContaining(['DAILY_RATE_MISSING_OR_INVALID', 'AVAILABILITY_MISSING']))
      await api(operator).post('/supply/availability', { ratePlanId: ids.ratePlan, stayDate: start, allotment: 0 }).expect(201)
      expect((await sellable({})).reasons).toContain('NO_INVENTORY')
      await restore()
      await api(operator).post('/supply/availability', { ratePlanId: ids.ratePlan, stayDate: start, allotment: 5, stopSell: true }).expect(201)
      expect((await sellable({})).reasons).toContain('STOP_SELL')
      await restore()
      expect((await sellable({ occupancy: 3 })).reasons).toContain('OCCUPANCY_UNSUPPORTED')
    })

    it('18-19. enforces minimum stay, maximum stay and release days', async () => {
      await prisma.ratePlan.update({ where: { id: ids.ratePlan }, data: { minStay: 3, maxStay: 5 } })
      expect((await sellable({ checkInDate: start, nights: 2 })).reasons).toContain('MIN_STAY_NOT_MET')
      expect((await sellable({ checkInDate: start, nights: 6 })).reasons).toContain('MAX_STAY_EXCEEDED')
      expect((await sellable({ checkInDate: start, nights: 4 })).eligible).toBe(true)
      await restore()
      await prisma.dailyAvailability.updateMany({ where: { ratePlanId: ids.ratePlan, stayDate: new Date(`${start}T00:00:00.000Z`) }, data: { minStay: 4 } })
      expect((await sellable({ checkInDate: start, nights: 3 })).reasons).toContain('MIN_STAY_NOT_MET')
      await restore()
      await prisma.ratePlan.update({ where: { id: ids.ratePlan }, data: { releaseDays: 30 } })
      expect((await sellable({ checkInDate: start, nights: 2 })).reasons).toContain('RELEASE_WINDOW_VIOLATED')
      await restore()
      await api(operator).post('/supply/sellability', { ratePlanId: ids.ratePlan, stayDate: start, occupancy: 2, nights: 2 }).expect(400)
    })
  })

  it('keeps booking fail-closed: no booking surface was enabled by the commercial setup', async () => {
    expect(await prisma.booking.count({ where: { tenantId } })).toBe(0)
  })
})
