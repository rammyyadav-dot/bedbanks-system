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
import { provisionRatePlanOpsRole, verifyRatePlanOpsRole, RATE_PLAN_OPS_LOGIN_ROLE } from '../src/database/rate-plan-ops-role'

/**
 * ADR 0041: rate plan lifecycle status is written only by the readiness-gated activate/suspend routes. Everything here runs
 * through the real HTTP API against a disposable PostgreSQL; the owner Prisma client is used only to arrange and to observe.
 */
const prisma = new PrismaClient()
const ownerUrl = process.env.DATABASE_URL
if (!ownerUrl) throw new Error('DATABASE_URL is required')
const loginUrl = (user: string, password: string) => { const url = new URL(ownerUrl); url.username = user; url.password = password; return url.toString() }
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
  let previousOps: string | undefined

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

  it('with the narrow lifecycle role configured, the strict API can activate and suspend and nothing else widens', async () => {
    const opsPassword = require('crypto').randomBytes(24).toString('hex')
    await provisionRatePlanOpsRole(prisma, { password: opsPassword })
    await provisionRatePlanOpsRole(prisma, { password: opsPassword }) // idempotent
    const ops = new PrismaClient({ datasourceUrl: loginUrl(RATE_PLAN_OPS_LOGIN_ROLE, opsPassword) })
    const probe = <T,>(work: (tx: import('@prisma/client').Prisma.TransactionClient) => Promise<T>, tenant: string | null = tenantId) => ops.$transaction(async (tx) => {
      if (tenant) await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenant}, true)`
      return work(tx)
    })
    try {
      // 1. The identity and its exact privileges.
      expect(await verifyRatePlanOpsRole(ops)).toEqual({ ok: true, failures: [] })

      // 2. Probes the role must lose (each is refused by the database, not by application code).
      await expect(probe((tx) => tx.$executeRaw`UPDATE "RatePlan" SET code = 'hijack' WHERE id = ${planId}`)).rejects.toThrow()
      await expect(probe((tx) => tx.$executeRaw`UPDATE "RatePlan" SET currency = 'USD' WHERE id = ${planId}`)).rejects.toThrow()
      await expect(probe((tx) => tx.$executeRaw`DELETE FROM "RatePlan" WHERE id = ${planId}`)).rejects.toThrow()
      await expect(probe((tx) => tx.$executeRaw`UPDATE "DailyRate" SET amount_minor = 1 WHERE rate_plan_id = ${planId}`)).rejects.toThrow()
      await expect(probe((tx) => tx.$executeRaw`UPDATE "DailyAvailability" SET allotment = 99 WHERE rate_plan_id = ${planId}`)).rejects.toThrow()
      await expect(probe((tx) => tx.$executeRaw`UPDATE "Contract" SET status = 'ACTIVE' WHERE id = ${contractId}`)).rejects.toThrow()
      await expect(probe((tx) => tx.$queryRaw`SELECT 1 FROM "AuditEvent" LIMIT 1`)).rejects.toThrow()
      await expect(probe((tx) => tx.$queryRaw`SELECT 1 FROM users LIMIT 1`)).rejects.toThrow()
      await expect(probe((tx) => tx.$queryRaw`SELECT name FROM "Hotel" LIMIT 1`)).rejects.toThrow()
      // Row-level security still applies: with another tenant's context the status column matches no row, and without context nothing is visible.
      expect(await probe((tx) => tx.$executeRaw`UPDATE "RatePlan" SET status = 'SUSPENDED' WHERE id = ${planId}`, otherTenantId)).toBe(0)
      expect(await probe((tx) => tx.ratePlan.count({ where: { id: planId } }), null)).toBe(0)
      await expect(prisma.ratePlan.findUniqueOrThrow({ where: { id: planId } })).resolves.toMatchObject({ status: 'DRAFT', code: expect.not.stringMatching(/hijack/), currency: 'AED' })

      // 3. Configured: the strict API now activates and suspends through the narrow role only.
      previousOps = process.env.RATE_PLAN_OPS_DATABASE_URL
      process.env.RATE_PLAN_OPS_DATABASE_URL = loginUrl(RATE_PLAN_OPS_LOGIN_ROLE, opsPassword)
      const ready = await api(operator).get(`/supply/rate-plans/${planId}/readiness`).expect(200)
      const refusedEmpty = await api(operator).post(`/supply/rate-plans/${planId}/activate`, { expectedUpdatedAt: '2020-01-01T00:00:00.000Z' })
      expect(refusedEmpty.status).toBe(409) // stale version is still a typed conflict on the new path
      expect(refusedEmpty.body.error.code).toBe('RATE_PLAN_CHANGED')
      const activated = await api(operator).post(`/supply/rate-plans/${planId}/activate`, { expectedUpdatedAt: ready.body.data.updatedAt }).set('x-request-id', `${suffix}-ops-act`)
      console.info('STRICT_ROLE_ACTIVATE_WITH_OPS_ROLE', activated.status)
      expect(activated.status).toBe(201)
      await expect(prisma.ratePlan.findUniqueOrThrow({ where: { id: planId } })).resolves.toMatchObject({ status: 'ACTIVE' })
      const audit = await prisma.auditEvent.findMany({ where: { tenantId, entityId: planId, action: 'supply.rate_plan.status_changed' } })
      expect(audit).toHaveLength(1)
      expect(audit[0]!.payload).toMatchObject({ requestId: `${suffix}-ops-act`, before: { status: 'DRAFT' }, after: { status: 'ACTIVE' } })
      expect(audit[0]!.userId).toBe(userIds[0])

      const version = (await api(operator).get(`/supply/rate-plans/${planId}/readiness`).expect(200)).body.data.updatedAt
      await api(operator).post(`/supply/rate-plans/${planId}/suspend`, { expectedUpdatedAt: version, reason: 'ops role probe' }).expect(201)
      await expect(prisma.ratePlan.findUniqueOrThrow({ where: { id: planId } })).resolves.toMatchObject({ status: 'SUSPENDED' })

      // 4. The readiness gate still applies on this path: a plan without rates cannot be activated by the role.
      const bare = await prisma.ratePlan.create({ data: { tenantId, contractId, roomTypeId: roomId, boardBasisId: boardId, code: `${suffix}-BARE`, occupancy: 2, currency: 'AED' } })
      const bareVersion = bare.updatedAt.toISOString()
      const gate = await api(operator).post(`/supply/rate-plans/${bare.id}/activate`, { expectedUpdatedAt: bareVersion })
      expect(gate.status).toBe(409)
      expect(gate.body.error.code).toBe('RATE_PLAN_NOT_READY')
      await expect(prisma.ratePlan.findUniqueOrThrow({ where: { id: bare.id } })).resolves.toMatchObject({ status: 'DRAFT' })

      // 5. Clone creates a row, which the narrow role may not do, so it stays on the privileged path and is refused under the strict login.
      const clone = await api(operator).post(`/supply/rate-plans/${planId}/clone`, { code: `${suffix}-CL` })
      expect([403, 503]).toContain(clone.status)
    } finally {
      if (previousOps === undefined) delete process.env.RATE_PLAN_OPS_DATABASE_URL; else process.env.RATE_PLAN_OPS_DATABASE_URL = previousOps
      await ops.$disconnect()
    }
  }, 60000)
})
