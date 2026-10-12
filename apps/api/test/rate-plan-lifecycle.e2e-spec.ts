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
 * ADR 0041: rate plan lifecycle status is written only by the readiness-gated activate/suspend routes. Everything here runs
 * through the real HTTP API against a disposable PostgreSQL; the owner Prisma client is used only to arrange and to observe.
 */
const prisma = new PrismaClient()
const DAY = 86_400_000
const iso = (offsetDays: number) => new Date(Math.floor(Date.now() / DAY) * DAY + offsetDays * DAY).toISOString().slice(0, 10)

describe('Rate plan lifecycle (activation bypass closure)', () => {
  const suffix = `lifecycle-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const password = 'lifecycle-certification-password'
  const nights = Array.from({ length: 5 }, (_, offset) => iso(14 + offset))
  let app: INestApplication
  let tenantId: string, otherTenantId: string
  let operator: string, readOnly: string, outsider: string
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
  const readiness = async (id: string, cookie = operator) => (await api(cookie).get(`/supply/rate-plans/${id}/readiness`).expect(200)).body.data as { ready: boolean; status: string; updatedAt: string; checks: Array<{ code: string; ok: boolean }> }
  const activate = async (id: string, cookie = operator, version?: string) => api(cookie).post(`/supply/rate-plans/${id}/activate`, { expectedUpdatedAt: version ?? (await readiness(id)).updatedAt })
  const expectStatus = (r: request.Response, status: number) => { if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`); return r }
  const row = (id: string) => prisma.ratePlan.findUniqueOrThrow({ where: { id } })
  const statusAudits = (id: string) => prisma.auditEvent.findMany({ where: { tenantId, entityId: id, action: 'supply.rate_plan.status_changed' } })
  const failedCodes = (body: { error?: { details?: Array<{ code?: string }> } }) => (body.error?.details ?? []).map((c) => c.code)

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
    readOnly = await login(`${suffix}-readonly@example.test`)
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
  }, 90000)

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

  describe('generic PATCH and create can never write status (1-3)', () => {
    it('rejects status=ACTIVE and leaves the plan untouched', async () => {
      const id = await newPlan(true); const before = await row(id)
      const response = await api(operator).patch(`/supply/rate-plans/${id}`, { status: 'ACTIVE' }).expect(400)
      expect(response.body.error.code).toBe('RATE_PLAN_STATUS_VIA_LIFECYCLE_ONLY')
      await expect(row(id)).resolves.toMatchObject({ status: 'DRAFT', updatedAt: before.updatedAt })
      expect(await statusAudits(id)).toHaveLength(0)
    })

    it('rejects status=SUSPENDED (and EXPIRED, DRAFT) on an active plan', async () => {
      const id = await newPlan(true); await activate(id).then((r) => expectStatus(r, 201))
      const before = await row(id)
      for (const status of ['SUSPENDED', 'EXPIRED', 'DRAFT', 'ACTIVE']) await api(operator).patch(`/supply/rate-plans/${id}`, { status }).expect(400)
      await expect(row(id)).resolves.toMatchObject({ status: 'ACTIVE', updatedAt: before.updatedAt })
    })

    it('rejects a mixed body atomically: valid fields beside status are not applied', async () => {
      const id = await newPlan(true); const before = await row(id)
      await api(operator).patch(`/supply/rate-plans/${id}`, { status: 'ACTIVE', minStay: 4, releaseDays: 9 }).expect(400)
      await expect(row(id)).resolves.toMatchObject({ status: 'DRAFT', minStay: before.minStay, releaseDays: before.releaseDays, updatedAt: before.updatedAt })
    })

    it('refuses mass assignment: unknown fields are an error, never silently dropped', async () => {
      const id = await newPlan(true); const before = await row(id)
      const response = await api(operator).patch(`/supply/rate-plans/${id}`, { minStay: 3, tenantId: otherTenantId, inventoryPoolId: 'x', id: 'other' }).expect(400)
      expect(response.body.error.code).toBe('RATE_PLAN_UNKNOWN_FIELD')
      await expect(row(id)).resolves.toMatchObject({ tenantId, minStay: before.minStay })
    })

    it('still permits legitimate non-status edits', async () => {
      const id = await newPlan(true)
      await api(operator).patch(`/supply/rate-plans/${id}`, { minStay: 2, maxStay: 9, releaseDays: 1 }).expect(200)
      await expect(row(id)).resolves.toMatchObject({ status: 'DRAFT', minStay: 2, maxStay: 9, releaseDays: 1 })
    })

    it('does not accept a status on create, so nothing is born active', async () => {
      await api(operator).post('/supply/rate-plans', { contractId, roomTypeId: roomId, boardBasisId: boardId, code: `${suffix}-BORN`, occupancy: 2, currency: 'AED', status: 'ACTIVE' }).expect(400)
      expect(await prisma.ratePlan.count({ where: { tenantId, code: `${suffix}-BORN` } })).toBe(0)
    })

    it('refuses to edit an active plan into a state activation would reject', async () => {
      const id = await newPlan(true); await activate(id).then((r) => expectStatus(r, 201))
      const draftContract = (await api(operator).post('/supply/contracts', { supplierId, supplierHotelMappingId: mappingId, code: `${suffix}-C-DRAFT`, validFrom: iso(-30), validTo: iso(365), settlementCurrency: 'AED' }).expect(201)).body.data.id
      const before = await row(id)
      const response = await api(operator).patch(`/supply/rate-plans/${id}`, { contractId: draftContract }).expect(409)
      expect(response.body.error.code).toBe('RATE_PLAN_NOT_READY')
      await expect(row(id)).resolves.toMatchObject({ contractId, updatedAt: before.updatedAt })
    })
  })

  describe('activation is gated by readiness (4-6)', () => {
    it('refuses a plan with no rates and no availability, naming every failed check, and writes nothing', async () => {
      const id = await newPlan(false)
      const response = await activate(id).then((r) => expectStatus(r, 409))
      expect(response.body.error.code).toBe('RATE_PLAN_NOT_READY')
      expect(failedCodes(response.body)).toEqual(expect.arrayContaining(['RATES_PRESENT', 'INVENTORY_LINKED']))
      await expect(row(id)).resolves.toMatchObject({ status: 'DRAFT' })
      expect(await statusAudits(id)).toHaveLength(0)
    })

    it('refuses a rate gap inside the rated range', async () => {
      const id = await newPlan(true)
      await prisma.dailyRate.deleteMany({ where: { ratePlanId: id, stayDate: new Date(`${nights[2]}T00:00:00Z`) } })
      const response = await activate(id).then((r) => expectStatus(r, 409))
      expect(failedCodes(response.body)).toContain('RATES_CONTIGUOUS')
    })

    it('refuses when the contract has expired or is not active', async () => {
      const id = await newPlan(true)
      await prisma.contract.update({ where: { id: contractId }, data: { validTo: new Date(Date.now() - 3 * DAY) } })
      try {
        const expired = await activate(id).then((r) => expectStatus(r, 409))
        expect(failedCodes(expired.body)).toContain('CONTRACT_VALID')
      } finally { await prisma.contract.update({ where: { id: contractId }, data: { validTo: new Date(Date.now() + 365 * DAY) } }) }
      await prisma.contract.update({ where: { id: contractId }, data: { status: 'SUSPENDED' } })
      try {
        const suspended = await activate(id).then((r) => expectStatus(r, 409))
        expect(failedCodes(suspended.body)).toContain('CONTRACT_ACTIVE')
        await expect(row(id)).resolves.toMatchObject({ status: 'DRAFT' })
      } finally { await prisma.contract.update({ where: { id: contractId }, data: { status: 'ACTIVE' } }) }
    })

    it('revalidates a SUSPENDED plan from scratch before reactivating it', async () => {
      const id = await newPlan(true); await activate(id).then((r) => expectStatus(r, 201))
      await api(operator).post(`/supply/rate-plans/${id}/suspend`, { expectedUpdatedAt: (await readiness(id)).updatedAt, reason: 'Contract review' }).expect(201)
      await prisma.dailyRate.deleteMany({ where: { ratePlanId: id } })
      const refused = await activate(id).then((r) => expectStatus(r, 409))
      expect(failedCodes(refused.body)).toContain('RATES_PRESENT')
      await expect(row(id)).resolves.toMatchObject({ status: 'SUSPENDED' })
      await api(operator).post('/supply/daily-rates/bulk', { rows: nights.map((stayDate) => ({ ratePlanId: id, stayDate, occupancy: 2, amountMinor: '45000', amountBasis: 'SELL', currency: 'AED' })) }).expect(201)
      await activate(id).then((r) => expectStatus(r, 201))
      await expect(row(id)).resolves.toMatchObject({ status: 'ACTIVE' })
    })

    it('never reactivates an expired plan', async () => {
      const id = await newPlan(true); await prisma.ratePlan.update({ where: { id }, data: { status: 'EXPIRED' } })
      const response = await activate(id).then((r) => expectStatus(r, 409))
      expect(response.body.error.code).toBe('RATE_PLAN_TRANSITION_NOT_ALLOWED')
      await expect(row(id)).resolves.toMatchObject({ status: 'EXPIRED' })
    })

    it('never activates a clone', async () => {
      const source = await newPlan(true); await activate(source).then((r) => expectStatus(r, 201))
      const clone = await api(operator).post(`/supply/rate-plans/${source}/clone`, { code: `${suffix}-CLONE` }).expect(201)
      expect(clone.body.data).toMatchObject({ status: 'DRAFT', contractId })
      expect(await prisma.dailyRate.count({ where: { ratePlanId: clone.body.data.id } })).toBe(0)
      const dup = await api(operator).post(`/supply/rate-plans/${source}/clone`, { code: `${suffix}-CLONE` }).expect(409)
      expect(dup.body.error.code).toBe('RATE_PLAN_CODE_EXISTS')
    })

    it('rejects a stale version with a typed 409 and changes nothing', async () => {
      const id = await newPlan(true); const stale = (await readiness(id)).updatedAt
      await api(operator).patch(`/supply/rate-plans/${id}`, { minStay: 2 }).expect(200)
      const response = await activate(id, operator, stale).then((r) => expectStatus(r, 409))
      expect(response.body.error.code).toBe('RATE_PLAN_CHANGED')
      await expect(row(id)).resolves.toMatchObject({ status: 'DRAFT' })
      await api(operator).post(`/supply/rate-plans/${id}/activate`, {}).expect(400)
    })
  })

  describe('authorization and tenancy (7-9)', () => {
    it('denies a read-only user, leaves a denial audit, and does not change status', async () => {
      const id = await newPlan(true)
      await activate(id, readOnly, new Date().toISOString()).then((r) => expectStatus(r, 403))
      await api(readOnly).post(`/supply/rate-plans/${id}/suspend`, { expectedUpdatedAt: new Date().toISOString(), reason: 'nope' }).expect(403)
      await api(readOnly).post(`/supply/rate-plans/${id}/clone`, { code: `${suffix}-RO` }).expect(403)
      await expect(row(id)).resolves.toMatchObject({ status: 'DRAFT' })
      expect(await prisma.auditEvent.count({ where: { tenantId, action: 'permission.denied', entityId: 'supply.rates.manage' } })).toBeGreaterThan(0)
      await api(readOnly).get(`/supply/rate-plans/${id}/readiness`).expect(200)
    })

    it('hides other tenants\' plans from readiness, activate, suspend and clone', async () => {
      const id = await newPlan(true)
      await api(outsider, otherTenantId).get(`/supply/rate-plans/${id}/readiness`).expect(404)
      await api(outsider, otherTenantId).post(`/supply/rate-plans/${id}/activate`, { expectedUpdatedAt: (await row(id)).updatedAt.toISOString() }).expect(404)
      await api(outsider, otherTenantId).post(`/supply/rate-plans/${id}/suspend`, { expectedUpdatedAt: (await row(id)).updatedAt.toISOString(), reason: 'cross tenant' }).expect(404)
      await api(outsider, otherTenantId).post(`/supply/rate-plans/${id}/clone`, { code: `${suffix}-X` }).expect(404)
      await api(outsider, tenantId).get(`/supply/rate-plans/${id}/readiness`).expect(403) // forged tenant header: not a member
      await expect(row(id)).resolves.toMatchObject({ status: 'DRAFT', tenantId })
    })

    it('audits a successful activation and suspension with before/after status, actor and request id', async () => {
      const id = await newPlan(true)
      await api(operator).post(`/supply/rate-plans/${id}/activate`, { expectedUpdatedAt: (await readiness(id)).updatedAt }).set('x-request-id', `${suffix}-act`).expect(201)
      await api(operator).post(`/supply/rate-plans/${id}/suspend`, { expectedUpdatedAt: (await readiness(id)).updatedAt, reason: 'Allotment dispute' }).set('x-request-id', `${suffix}-sus`).expect(201)
      const events = (await statusAudits(id)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      expect(events.map((e) => e.payload)).toEqual([
        expect.objectContaining({ requestId: `${suffix}-act`, before: { status: 'DRAFT' }, after: { status: 'ACTIVE' } }),
        expect.objectContaining({ requestId: `${suffix}-sus`, before: { status: 'ACTIVE' }, after: { status: 'SUSPENDED' }, reason: 'Allotment dispute' }),
      ])
      expect(events.every((e) => e.userId === userIds[0] && e.entityType === 'rate_plan')).toBe(true)
      expect(await prisma.auditEvent.count({ where: { tenantId, entityId: id, action: { in: ['supply.rate_plan.activated', 'supply.rate_plan.suspended'] } } })).toBe(2)
    })

    it('requires a reason to suspend and refuses to suspend a plan that is not active', async () => {
      const id = await newPlan(true)
      const version = () => readiness(id).then((r) => r.updatedAt)
      await api(operator).post(`/supply/rate-plans/${id}/suspend`, { expectedUpdatedAt: await version() }).expect(400)
      const response = await api(operator).post(`/supply/rate-plans/${id}/suspend`, { expectedUpdatedAt: await version(), reason: 'Not active yet' }).expect(409)
      expect(response.body.error.code).toBe('RATE_PLAN_TRANSITION_NOT_ALLOWED')
      await expect(row(id)).resolves.toMatchObject({ status: 'DRAFT' })
    })
  })

  describe('concurrency (10-11)', () => {
    it('lets exactly one of many simultaneous activations win and records one transition', async () => {
      const id = await newPlan(true); const version = (await readiness(id)).updatedAt
      const results = await Promise.all(Array.from({ length: 6 }, () => api(operator).post(`/supply/rate-plans/${id}/activate`, { expectedUpdatedAt: version })))
      const statuses = results.map((r) => r.status).sort()
      expect(statuses.filter((s) => s === 201)).toHaveLength(1)
      expect(statuses.filter((s) => s !== 201 && s !== 409)).toEqual([])
      const codes = results.filter((r) => r.status === 409).map((r) => r.body.error.code)
      expect(codes.every((c: string) => ['RATE_PLAN_CHANGED', 'RATE_PLAN_TRANSITION_NOT_ALLOWED'].includes(c))).toBe(true)
      await expect(row(id)).resolves.toMatchObject({ status: 'ACTIVE' })
      expect(await statusAudits(id)).toHaveLength(1)
    })

    it('never leaves an active plan whose contract was suspended concurrently with its activation', async () => {
      const id = await newPlan(true); const version = (await readiness(id)).updatedAt
      const [result] = await Promise.all([
        api(operator).post(`/supply/rate-plans/${id}/activate`, { expectedUpdatedAt: version }),
        prisma.contract.update({ where: { id: contractId }, data: { status: 'SUSPENDED' } }),
      ])
      await prisma.contract.update({ where: { id: contractId }, data: { status: 'ACTIVE' } })
      // Either ordering is acceptable, but the outcome must be self-consistent and typed.
      expect([201, 409]).toContain(result.status)
      const events = await statusAudits(id)
      const current = await row(id)
      expect(current.status).toBe(result.status === 201 ? 'ACTIVE' : 'DRAFT')
      expect(events).toHaveLength(result.status === 201 ? 1 : 0)
      if (result.status === 409) expect(['RATE_PLAN_NOT_READY', 'RATE_PLAN_CHANGED']).toContain(result.body.error.code)
    })

    it('does not partially mutate on a refused transition', async () => {
      const id = await newPlan(false); const before = await row(id)
      await activate(id).then((r) => expectStatus(r, 409))
      const after = await row(id)
      expect(after).toMatchObject({ status: before.status, updatedAt: before.updatedAt })
      expect(await prisma.auditEvent.count({ where: { tenantId, entityId: id, action: { startsWith: 'supply.rate_plan.' } } })).toBe(1) // only .created
    })
  })
  describe('plan sale window and payment type (ADR 0057)', () => {
    const planRow = (id: string) => prisma.ratePlan.findUniqueOrThrow({ where: { id } })
    const planCount = () => prisma.ratePlan.count({ where: { tenantId } })

    it('stores an in-term window and payment type, and returns them', async () => {
      const id = await newPlan(false, { validFrom: iso(10), validTo: iso(100), paymentType: 'PREPAID' })
      const stored = await planRow(id)
      expect(stored.validFrom?.toISOString().slice(0, 10)).toBe(iso(10))
      expect(stored.validTo?.toISOString().slice(0, 10)).toBe(iso(100))
      expect(stored.paymentType).toBe('PREPAID')
      const read = await api(operator).get(`/supply/rate-plans/${id}`).expect(200)
      expect(read.body.data.paymentType).toBe('PREPAID')
    })

    it('records nothing by default: no window, no invented payment type', async () => {
      const stored = await planRow(await newPlan(false))
      expect(stored).toMatchObject({ validFrom: null, validTo: null, paymentType: null })
    })

    it('refuses a window that extends the contract, an inverted window, a bad day and an unknown payment type, writing nothing', async () => {
      const before = await planCount()
      const attempt = (body: Record<string, unknown>) => api(operator).post('/supply/rate-plans', { contractId, roomTypeId: roomId, boardBasisId: boardId, code: `${suffix}-X${++n}`, occupancy: 2, currency: 'AED', ...body })
      expect((await attempt({ validTo: iso(400) }).then((r) => expectStatus(r, 400))).body.error.code).toBe('RATE_PLAN_VALIDITY_OUTSIDE_CONTRACT')
      expect((await attempt({ validFrom: iso(-60) }).then((r) => expectStatus(r, 400))).body.error.code).toBe('RATE_PLAN_VALIDITY_OUTSIDE_CONTRACT')
      expect((await attempt({ validFrom: iso(50), validTo: iso(40) }).then((r) => expectStatus(r, 400))).body.error.code).toBe('RATE_PLAN_VALIDITY_INVALID')
      expect((await attempt({ validFrom: '2026-02-30' }).then((r) => expectStatus(r, 400))).body.error.code).toBe('RATE_PLAN_VALIDITY_INVALID')
      expect((await attempt({ paymentType: 'DEPOSIT' }).then((r) => expectStatus(r, 400))).body.error.code).toBe('RATE_PLAN_PAYMENT_TYPE_INVALID')
      expect(await planCount()).toBe(before)
    })

    it('edits keep a stored value when the key is absent and clear it on an explicit null', async () => {
      const id = await newPlan(false, { validFrom: iso(10), validTo: iso(100), paymentType: 'PAY_AT_HOTEL' })
      await api(operator).patch(`/supply/rate-plans/${id}`, { code: `${suffix}-renamed-${++n}` }).then((r) => expectStatus(r, 200))
      expect(await planRow(id)).toMatchObject({ paymentType: 'PAY_AT_HOTEL' })
      await api(operator).patch(`/supply/rate-plans/${id}`, { validTo: null, paymentType: null }).then((r) => expectStatus(r, 200))
      const cleared = await planRow(id)
      expect(cleared.validTo).toBeNull()
      expect(cleared.paymentType).toBeNull()
      expect(cleared.validFrom?.toISOString().slice(0, 10)).toBe(iso(10))
    })

    it('a read-only user cannot change the window', async () => {
      const id = await newPlan(false)
      await api(readOnly).patch(`/supply/rate-plans/${id}`, { validTo: iso(50) }).then((r) => expectStatus(r, 403))
      expect((await planRow(id)).validTo).toBeNull()
    })

    it('a window that is already over fails readiness and blocks activation', async () => {
      const id = await newPlan(true, { validFrom: iso(-20), validTo: iso(-1) })
      const result = await readiness(id)
      expect(result.checks.filter((c) => !c.ok).map((c) => c.code)).toContain('PLAN_VALIDITY')
      const refused = await activate(id).then((r) => expectStatus(r, 409))
      expect(refused.body.error.code).toBe('RATE_PLAN_NOT_READY')
      expect(failedCodes(refused.body)).toContain('PLAN_VALIDITY')
      expect((await planRow(id)).status).toBe('DRAFT')
    })

    it('an active plan cannot be edited into an expired window', async () => {
      const id = await newPlan(true, { validFrom: iso(-10), validTo: iso(60) })
      await activate(id).then((r) => expectStatus(r, 201))
      const refused = await api(operator).patch(`/supply/rate-plans/${id}`, { validTo: iso(-1) }).then((r) => expectStatus(r, 409))
      expect(refused.body.error.code).toBe('RATE_PLAN_NOT_READY')
      expect((await planRow(id)).validTo?.toISOString().slice(0, 10)).toBe(iso(60))
    })

    it('Admin diagnostics honour the window per night', async () => {
      const id = await newPlan(true, { validFrom: iso(16), validTo: iso(30) })
      const verdict = (stayDate: string) => api(operator).post('/supply/sellability', { ratePlanId: id, stayDate, occupancy: 2 }).expect(201).then((r) => r.body.data)
      const outside = await verdict(nights[0])
      expect(JSON.stringify(outside)).toContain('OUTSIDE_RATE_PLAN_VALIDITY')
    })

    it('clone keeps the window and payment type but never the status', async () => {
      const id = await newPlan(false, { validFrom: iso(10), validTo: iso(100), paymentType: 'PREPAID' })
      const cloned = await api(operator).post(`/supply/rate-plans/${id}/clone`, { code: `${suffix}-clone-${++n}` })
      if (cloned.status === 201) {
        const copy = await planRow(cloned.body.data.id)
        expect(copy).toMatchObject({ status: 'DRAFT', paymentType: 'PREPAID' })
        expect(copy.validFrom?.toISOString().slice(0, 10)).toBe(iso(10))
      } else {
        expect([403]).toContain(cloned.status) // strict runtime login: clone has no writer (ADR 0041 Amendment 3)
      }
    })
  })
  describe('plan cancellation rule sets (ADR 0057)', () => {
    const planRow = (id: string) => prisma.ratePlan.findUniqueOrThrow({ where: { id } })
    const addRule = (policySet: string | null, daysBeforeCheckin: number) => api(operator).post(`/supply/contracts/${contractId}/policies/cancellation`, { daysBeforeCheckin, penaltyPercent: 100, ...(policySet === null ? {} : { policySet }) })
    const createWith = (body: Record<string, unknown>) => api(operator).post('/supply/rate-plans', { contractId, roomTypeId: roomId, boardBasisId: boardId, code: `${suffix}-S${++n}`, occupancy: 2, currency: 'AED', ...body })

    it('stores rules in a named set, leaving the contract default untouched', async () => {
      await addRule('FLEX-7', 7).then((r) => expectStatus(r, 201))
      await addRule('FLEX-7', 2).then((r) => expectStatus(r, 201))
      const rows = await prisma.cancellationPolicy.findMany({ where: { contractId, policySet: 'FLEX-7' } })
      expect(rows).toHaveLength(2)
      expect(await prisma.cancellationPolicy.count({ where: { contractId, policySet: null } })).toBeGreaterThanOrEqual(1)
      const listed = await api(operator).get(`/supply/contracts/${contractId}/policies`).expect(200)
      expect(JSON.stringify(listed.body.data)).toContain('FLEX-7')
    })

    it('refuses a bad set name on a rule', async () => {
      await addRule('bad/name', 3).then((r) => expectStatus(r, 400))
      await addRule(' lead', 3).then((r) => expectStatus(r, 400))
    })

    it('attaches an existing set to a refundable plan and reads it back', async () => {
      const id = (await createWith({ cancellationPolicySet: 'FLEX-7' }).then((r) => expectStatus(r, 201))).body.data.id
      expect((await planRow(id)).cancellationPolicySet).toBe('FLEX-7')
    })

    it('refuses an unknown set, a bad name, and a set on a non-refundable plan, writing nothing', async () => {
      const before = await prisma.ratePlan.count({ where: { tenantId } })
      expect((await createWith({ cancellationPolicySet: 'NOPE' }).then((r) => expectStatus(r, 400))).body.error.code).toBe('RATE_PLAN_CANCELLATION_SET_UNKNOWN')
      expect((await createWith({ cancellationPolicySet: 'flex-7' }).then((r) => expectStatus(r, 400))).body.error.code).toBe('RATE_PLAN_CANCELLATION_SET_UNKNOWN') // case-sensitive
      expect((await createWith({ cancellationPolicySet: '../x' }).then((r) => expectStatus(r, 400))).body.error.code).toBe('RATE_PLAN_CANCELLATION_SET_INVALID')
      expect((await createWith({ cancellationPolicySet: 'FLEX-7', refundable: false }).then((r) => expectStatus(r, 400))).body.error.code).toBe('RATE_PLAN_CANCELLATION_SET_ON_NON_REFUNDABLE')
      expect(await prisma.ratePlan.count({ where: { tenantId } })).toBe(before)
    })

    it('editing: absent keeps, null clears, and making a plan non-refundable while it names a set is refused', async () => {
      const id = (await createWith({ cancellationPolicySet: 'FLEX-7' }).then((r) => expectStatus(r, 201))).body.data.id
      await api(operator).patch(`/supply/rate-plans/${id}`, { minStay: 2 }).then((r) => expectStatus(r, 200))
      expect((await planRow(id)).cancellationPolicySet).toBe('FLEX-7')
      expect((await api(operator).patch(`/supply/rate-plans/${id}`, { refundable: false }).then((r) => expectStatus(r, 400))).body.error.code).toBe('RATE_PLAN_CANCELLATION_SET_ON_NON_REFUNDABLE')
      await api(operator).patch(`/supply/rate-plans/${id}`, { cancellationPolicySet: null, refundable: false }).then((r) => expectStatus(r, 200))
      expect(await planRow(id)).toMatchObject({ cancellationPolicySet: null, refundable: false })
    })

    it('a read-only user cannot attach a set', async () => {
      const id = await newPlan(false)
      await api(readOnly).patch(`/supply/rate-plans/${id}`, { cancellationPolicySet: 'FLEX-7' }).then((r) => expectStatus(r, 403))
      expect((await planRow(id)).cancellationPolicySet).toBeNull()
    })

    it('readiness counts the plan set, not the contract default; an emptied set blocks activation naming the set', async () => {
      const id = await newPlan(true, { cancellationPolicySet: 'FLEX-7' })
      expect((await readiness(id)).checks.find((c) => c.code === 'CANCELLATION_POLICY')?.ok).toBe(true)
      await prisma.cancellationPolicy.updateMany({ where: { contractId, policySet: 'FLEX-7' }, data: { policySet: 'RENAMED' } })
      try {
        const refused = await activate(id).then((r) => expectStatus(r, 409))
        expect(refused.body.error.code).toBe('RATE_PLAN_NOT_READY')
        expect(JSON.stringify(refused.body.error.details)).toContain('FLEX-7')
        expect((await planRow(id)).status).toBe('DRAFT')
      } finally { await prisma.cancellationPolicy.updateMany({ where: { contractId, policySet: 'RENAMED' }, data: { policySet: 'FLEX-7' } }) }
      await activate(id).then((r) => expectStatus(r, 201))
    })
  })
})
