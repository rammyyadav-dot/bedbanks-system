import { INestApplication, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import * as cookieParser from 'cookie-parser'
import * as request from 'supertest'
import { PrismaClient } from '@prisma/client'
import { AppModule } from '../src/app.module'
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor'
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter'
import { hashPassword } from '../src/auth/utils/password'
import { provisionApiRuntimeRole, verifyApiRuntimeRole, API_RUNTIME_LOGIN_ROLE } from '../src/database/api-runtime-role'

/**
 * ADR 0041: rate plan lifecycle status is written only by the readiness-gated activate/suspend routes. Everything here runs
 * through the real HTTP API against a disposable PostgreSQL; the owner Prisma client is used only to arrange and to observe.
 */
const prisma = new PrismaClient()
const ownerUrl = process.env.DATABASE_URL
if (!ownerUrl) throw new Error('DATABASE_URL is required')
const runtimeUrl = (password: string) => { const url = new URL(ownerUrl); url.username = API_RUNTIME_LOGIN_ROLE; url.password = password; return url.toString() }
const DAY = 86_400_000
const iso = (offsetDays: number) => new Date(Math.floor(Date.now() / DAY) * DAY + offsetDays * DAY).toISOString().slice(0, 10)

describe('Rate plan lifecycle on the strict runtime login (fbeds_api_login)', () => {
  const suffix = `lifecycle-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const password = 'lifecycle-certification-password'
  const nights = Array.from({ length: 5 }, (_, offset) => iso(14 + offset))
  let app: INestApplication
  let tenantId: string, otherTenantId: string
  let operator: string, outsider: string
  const userIds: string[] = []
  const roleIds: string[] = []
  let supplierId: string, hotelId: string, roomId: string, boardId: string, mappingId: string, contractId: string
  let n = 0

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
  /** A DRAFT plan, optionally complete with rates and availability for the five test nights. */
  const newPlan = async (complete: boolean, body: Record<string, unknown> = {}) => {
    const plan = await api(operator).post('/supply/rate-plans', { contractId, roomTypeId: roomId, boardBasisId: boardId, code: `${suffix}-P${++n}`, occupancy: 2, currency: 'AED', refundable: true, minStay: 1, releaseDays: 0, ...body }).expect(201)
    const id = plan.body.data.id as string
    if (complete) {
      await api(operator).post('/supply/daily-rates/bulk', { rows: nights.map((stayDate) => ({ ratePlanId: id, stayDate, occupancy: 2, amountMinor: '45000', amountBasis: 'SELL', currency: 'AED' })) }).expect(201)
      await api(operator).post('/supply/availability/bulk', { rows: nights.map((stayDate) => ({ ratePlanId: id, stayDate, allotment: 5, sold: 0, stopSell: false, minStay: 1 })) }).expect(201)
    }
    return id
  }

  beforeAll(async () => {
    await prisma.$connect()
    const [tenant, other] = await Promise.all([
      prisma.tenant.create({ data: { name: `${suffix} Tenant`, slug: suffix } }),
      prisma.tenant.create({ data: { name: `${suffix} Other`, slug: `${suffix}-other` } }),
    ])
    tenantId = tenant.id; otherTenantId = other.id
    const passwordHash = await hashPassword(password)
    const users = await Promise.all(['operator', 'readonly', 'outsider'].map((name) => prisma.user.create({ data: { email: `${suffix}-${name}@example.test`, passwordHash } })))
    userIds.push(...users.map((user) => user.id))
    const keys = ['hotels', 'rooms', 'rates', 'contracts', 'availability', 'suppliers', 'mappings'].flatMap((area) => [`supply.${area}.read`, `supply.${area}.manage`])
    const permissions = await Promise.all(keys.map((key) => prisma.permission.upsert({ where: { key }, update: {}, create: { key, description: key } })))
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
    outsider = await login(`${suffix}-outsider@example.test`)

    supplierId = (await api(operator).post('/supply/suppliers', { type: 'DMC', status: 'ACTIVE', legalName: `${suffix} Supplier LLC`, displayName: 'Lifecycle Supplier', countryCode: 'AE', defaultCurrency: 'AED' }).expect(201)).body.data.id
    hotelId = (await api(operator).post('/supply/hotels', { name: `${suffix} Hotel`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', starRating: 4 }).expect(201)).body.data.id
    roomId = (await api(operator).post(`/supply/hotels/${hotelId}/rooms`, { name: 'Deluxe King', code: 'DLX', maxAdults: 2, maxChildren: 1, maxOccupancy: 3 }).expect(201)).body.data.id
    boardId = (await api(operator).post('/supply/board-bases', { code: 'BB', name: 'Bed & Breakfast' }).expect(201)).body.data.id
    mappingId = (await api(operator).post('/supply/mappings/hotels', { supplierId, hotelId, supplierHotelId: `${suffix}-SUP` }).expect(201)).body.data.id
    const roomMapping = (await api(operator).post(`/supply/mappings/hotels/${mappingId}/rooms`, { supplierRoomId: `${suffix}-DLX`, roomTypeId: roomId }).expect(201)).body.data.id
    await api(operator).post(`/supply/mappings/hotels/${mappingId}/approve`).expect(201)
    await api(operator).post(`/supply/mappings/hotels/${mappingId}/rooms/${roomMapping}/approve`).expect(201)
    contractId = (await api(operator).post('/supply/contracts', { supplierId, supplierHotelMappingId: mappingId, code: `${suffix}-C1`, validFrom: iso(-30), validTo: iso(365), settlementCurrency: 'AED', salesMarkets: ['AE'], nationalities: [] }).expect(201)).body.data.id
    await api(operator).post(`/supply/contracts/${contractId}/policies/cancellation`, { daysBeforeCheckin: 7, penaltyPercent: 100 }).expect(201)
    await api(operator).patch(`/supply/contracts/${contractId}`, { status: 'ACTIVE' }).expect(200)
    // Arrange a complete DRAFT plan through the owner-connected API, then restart the API on the restricted login.
    planId = await newPlan(true)
    await app.close()
    await provisionApiRuntimeRole(prisma, { password: loginPassword })
    runtime = new PrismaClient({ datasourceUrl: runtimeUrl(loginPassword) })
    await runtime.$connect()
    previousUrl = process.env.DATABASE_URL
    process.env.DATABASE_URL = runtimeUrl(loginPassword)
    process.env.ADMIN_ORIGIN = 'http://localhost:3001'
    const strict = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = strict.createNestApplication()
    app.use(cookieParser())
    app.setGlobalPrefix('api/v1')
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
    app.useGlobalFilters(new HttpExceptionFilter())
    app.useGlobalInterceptors(new ResponseInterceptor())
    await app.init()
    operator = await login(`${suffix}-operator@example.test`)
    outsider = await login(`${suffix}-outsider@example.test`)
  }, 90000)

  afterAll(async () => {
    await app?.close()
    await runtime?.$disconnect()
    if (previousUrl !== undefined) process.env.DATABASE_URL = previousUrl
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

  let runtime: PrismaClient
  let planId: string
  const loginPassword = process.env.API_RUNTIME_LOGIN_PASSWORD ?? require('crypto').randomBytes(24).toString('hex')
  let previousUrl: string | undefined

  it('runs the lifecycle routes on the restricted login without any widened privilege', async () => {
    // 1. The identity: not superuser, no BYPASSRLS, owns no table, and the live grants match the contract.
    const report = await verifyApiRuntimeRole(runtime)
    expect(report).toEqual({ ok: true, failures: [] })
    const [attrs] = await runtime.$queryRawUnsafe<Array<{ who: string; rolsuper: boolean; rolbypassrls: boolean; owned: number }>>(
      `SELECT r.rolname AS who, r.rolsuper, r.rolbypassrls,
              (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND pg_get_userbyid(c.relowner) = r.rolname) AS owned
         FROM pg_roles r WHERE r.rolname = current_user`)
    expect(attrs).toEqual({ who: API_RUNTIME_LOGIN_ROLE, rolsuper: false, rolbypassrls: false, owned: 0 })
    const [ratePlanGrant] = await runtime.$queryRawUnsafe<Array<{ can_update_status: boolean; can_insert: boolean; can_delete: boolean }>>(
      `SELECT has_column_privilege(current_user, '"RatePlan"', 'status', 'UPDATE') AS can_update_status, has_table_privilege(current_user, '"RatePlan"', 'INSERT') AS can_insert, has_table_privilege(current_user, '"RatePlan"', 'DELETE') AS can_delete`)
    console.info('STRICT_ROLE_RATEPLAN_PRIVILEGES', JSON.stringify(ratePlanGrant))

    // 2. HTTP over that identity. The readiness read and refused PATCH never need a privileged write.
    const ready = await api(operator).get(`/supply/rate-plans/${planId}/readiness`)
    console.info('STRICT_ROLE_READINESS_STATUS', ready.status)
    await api(operator).patch(`/supply/rate-plans/${planId}`, { status: 'ACTIVE', minStay: 3 }).expect(400)
    await api(outsider, otherTenantId).get(`/supply/rate-plans/${planId}/readiness`).expect(404)

    // 3. Activation is a privileged write: with the grants equal to the contract it must be refused, sanitized, and write nothing.
    const version = ready.status === 200 ? ready.body.data.updatedAt : new Date().toISOString()
    const activation = await api(operator).post(`/supply/rate-plans/${planId}/activate`, { expectedUpdatedAt: version })
    console.info('STRICT_ROLE_ACTIVATE', activation.status, activation.body?.error?.code)
    expect([403, 503]).toContain(activation.status)
    expect(JSON.stringify(activation.body)).not.toMatch(/RatePlan|UPDATE|SELECT|prisma/i)
    await expect(prisma.ratePlan.findUniqueOrThrow({ where: { id: planId } })).resolves.toMatchObject({ status: 'DRAFT' })
    expect(await prisma.auditEvent.count({ where: { tenantId, entityId: planId, action: 'supply.rate_plan.status_changed' } })).toBe(0)
    await api(operator).post(`/supply/rate-plans/${planId}/suspend`, { expectedUpdatedAt: version, reason: 'strict role probe' }).then((r) => expect([403, 409, 503]).toContain(r.status))
    await expect(prisma.ratePlan.findUniqueOrThrow({ where: { id: planId } })).resolves.toMatchObject({ status: 'DRAFT' })
  })
})
