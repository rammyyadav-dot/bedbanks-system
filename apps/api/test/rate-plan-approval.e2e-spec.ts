import { INestApplication, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import * as cookieParser from 'cookie-parser'
import * as request from 'supertest'
import { PrismaClient } from '@prisma/client'
import { AppModule } from '../src/app.module'
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor'
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter'
import { hashPassword } from '../src/auth/utils/password'
import { setContractStatusFixture } from './contract-status-fixture'

/**
 * ADR 0041: rate plan lifecycle status is written only by the readiness-gated activate/suspend routes. Everything here runs
 * through the real HTTP API against a disposable PostgreSQL; the owner Prisma client is used only to arrange and to observe.
 */
const prisma = new PrismaClient()
const DAY = 86_400_000
const iso = (offsetDays: number) => new Date(Math.floor(Date.now() / DAY) * DAY + offsetDays * DAY).toISOString().slice(0, 10)

describe('Rate plan four-eye activation (ADR 0057, S5)', () => {
  const suffix = `approval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const password = 'lifecycle-certification-password'
  const nights = Array.from({ length: 5 }, (_, offset) => iso(14 + offset))
  let app: INestApplication
  let tenantId: string, otherTenantId: string
  let operator: string, approver: string, readOnly: string, outsider: string
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

  beforeAll(async () => {
    await prisma.$connect()
    const [tenant, other] = await Promise.all([
      prisma.tenant.create({ data: { name: `${suffix} Tenant`, slug: suffix } }),
      prisma.tenant.create({ data: { name: `${suffix} Other`, slug: `${suffix}-other` } }),
    ])
    tenantId = tenant.id; otherTenantId = other.id
    const passwordHash = await hashPassword(password)
    const users = await Promise.all(['operator', 'approver', 'readonly', 'outsider'].map((name) => prisma.user.create({ data: { email: `${suffix}-${name}@example.test`, passwordHash } })))
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
    const approverRole = await grant(tenantId, 'approver', permissions)
    const readOnlyRole = await grant(tenantId, 'readonly', permissions.filter((permission) => permission.key.endsWith('.read')))
    const outsiderRole = await grant(otherTenantId, 'outsider', permissions)
    await prisma.membership.createMany({ data: [{ tenantId, userId: userIds[0], role: 'owner' }, { tenantId, userId: userIds[1], role: 'member' }, { tenantId, userId: userIds[2], role: 'member' }, { tenantId: otherTenantId, userId: userIds[3], role: 'owner' }] })
    await prisma.userRole.createMany({ data: [{ tenantId, userId: userIds[0], roleId: operatorRole }, { tenantId, userId: userIds[1], roleId: approverRole }, { tenantId, userId: userIds[2], roleId: readOnlyRole }, { tenantId: otherTenantId, userId: userIds[3], roleId: outsiderRole }] })

    const module = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = module.createNestApplication()
    app.use(cookieParser())
    app.setGlobalPrefix('api/v1')
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
    app.useGlobalFilters(new HttpExceptionFilter())
    app.useGlobalInterceptors(new ResponseInterceptor())
    await app.init()
    operator = await login(`${suffix}-operator@example.test`)
    approver = await login(`${suffix}-approver@example.test`)
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
    await setContractStatusFixture(prisma, contractId, 'ACTIVE')
  }, 90000)

  afterAll(async () => {
    await app?.close()
    const tenants = { in: [tenantId, otherTenantId] }
    await prisma.auditEvent.deleteMany({ where: { tenantId: tenants } })
    await prisma.approvalRequest.deleteMany({ where: { tenantId: tenants } })
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
    process.env.RATE_PLAN_ACTIVATION_APPROVAL = previousMode ?? 'off'
  })

  const previousMode = process.env.RATE_PLAN_ACTIVATION_APPROVAL
  beforeEach(() => { process.env.RATE_PLAN_ACTIVATION_APPROVAL = 'required' })

  let k = 0
  const requestBody = async (id: string, reason = 'Reviewed pricing and terms') => ({ requestId: `${suffix}-req-${++k}`, reason, expectedUpdatedAt: (await readiness(id)).updatedAt })
  const fileRequest = async (id: string, cookie = operator) => api(cookie).post(`/supply/rate-plans/${id}/activation-request`, await requestBody(id))
  const filed = async (id: string) => (await fileRequest(id).then((r) => expectStatus(r, 201))).body.data as { id: string; status: string; isRequester: boolean }
  const approve = (approvalId: string, cookie = approver) => api(cookie).post(`/supply/rate-plan-approvals/${approvalId}/approve`, { reason: 'Prices and terms look right' })
  const execute = (approvalId: string, cookie = approver) => api(cookie).post(`/supply/rate-plan-approvals/${approvalId}/execute`)
  const approvalRow = (id: string) => prisma.approvalRequest.findUniqueOrThrow({ where: { id } })

  describe('direct activation is closed', () => {
    it('refuses POST activate with a typed 409, writing nothing, and tells a read-only user 403', async () => {
      const id = await newPlan(true)
      const refused = await activate(id).then((r) => expectStatus(r, 409))
      expect(refused.body.error.code).toBe('RATE_PLAN_APPROVAL_REQUIRED')
      expect((await row(id)).status).toBe('DRAFT')
      expect(await statusAudits(id)).toHaveLength(0)
      await activate(id, readOnly).then((r) => expectStatus(r, 403))
    })
    it('the capabilities route reports the mode', async () => {
      const caps = await api(operator).get('/supply/rate-plans/capabilities').expect(200)
      expect(caps.body.data.activationApproval).toBe('required')
    })
  })

  describe('request', () => {
    it('files a PENDING request bound to the plan version; it is idempotent on requestId', async () => {
      const id = await newPlan(true)
      const body = await requestBody(id)
      const first = await api(operator).post(`/supply/rate-plans/${id}/activation-request`, body).then((r) => expectStatus(r, 201))
      expect(first.body.data).toMatchObject({ status: 'PENDING', isRequester: true, canDecide: false, canCancel: true, boundUpdatedAt: body.expectedUpdatedAt })
      const again = await api(operator).post(`/supply/rate-plans/${id}/activation-request`, body).then((r) => expectStatus(r, 201))
      expect(again.body.data.id).toBe(first.body.data.id)
      expect(await prisma.approvalRequest.count({ where: { tenantId, entityId: id } })).toBe(1)
    })
    it('refuses a plan that is not ready, a stale version, a second open request, a read-only user and another tenant', async () => {
      const bare = await newPlan(false)
      const notReady = await fileRequest(bare).then((r) => expectStatus(r, 409))
      expect(notReady.body.error.code).toBe('RATE_PLAN_NOT_READY')
      const id = await newPlan(true)
      const stale = await api(operator).post(`/supply/rate-plans/${id}/activation-request`, { requestId: `${suffix}-stale`, reason: 'x', expectedUpdatedAt: '2020-01-01T00:00:00.000Z' }).then((r) => expectStatus(r, 409))
      expect(stale.body.error.code).toBe('RATE_PLAN_CHANGED')
      await filed(id)
      expect((await fileRequest(id).then((r) => expectStatus(r, 409))).body.error.code).toBe('RATE_PLAN_APPROVAL_OPEN')
      await fileRequest(id, readOnly).then((r) => expectStatus(r, 403))
      await api(outsider, otherTenantId).post(`/supply/rate-plans/${id}/activation-request`, { requestId: `${suffix}-x`, reason: 'x', expectedUpdatedAt: new Date().toISOString() }).then((r) => expectStatus(r, 404))
      expect(await prisma.approvalRequest.count({ where: { tenantId, entityId: bare } })).toBe(0)
    })
  })

  describe('decision', () => {
    it('the requester cannot approve their own request, in the service or the database', async () => {
      const id = await newPlan(true); const a = await filed(id)
      await approve(a.id, operator).then((r) => expectStatus(r, 403))
      expect((await approvalRow(a.id)).status).toBe('PENDING')
      await expect(prisma.$executeRawUnsafe(`UPDATE "ApprovalRequest" SET status = 'APPROVED', decided_by_id = requested_by_id WHERE id = '${a.id}'`)).rejects.toThrow()
      expect((await approvalRow(a.id)).status).toBe('PENDING')
    })
    it('a different manager approves; a read-only user and another tenant cannot', async () => {
      const id = await newPlan(true); const a = await filed(id)
      await approve(a.id, readOnly).then((r) => expectStatus(r, 403))
      await api(outsider, otherTenantId).post(`/supply/rate-plan-approvals/${a.id}/approve`, { reason: 'x' }).then((r) => expectStatus(r, 404))
      const ok = await approve(a.id).then((r) => expectStatus(r, 201))
      expect(ok.body.data).toMatchObject({ status: 'APPROVED', canExecute: true })
      expect((await row(id)).status).toBe('DRAFT') // approval alone activates nothing
    })
    it('an edit after the request means it can no longer be approved', async () => {
      const id = await newPlan(true); const a = await filed(id)
      await api(operator).patch(`/supply/rate-plans/${id}`, { minStay: 2 }).then((r) => expectStatus(r, 200))
      const refused = await approve(a.id).then((r) => expectStatus(r, 409))
      expect(refused.body.error.code).toBe('RATE_PLAN_CHANGED_SINCE_REQUEST')
      expect((await approvalRow(a.id)).status).toBe('PENDING')
    })
    it('a rejection ends the request and the requester may file a new one; only the requester can cancel', async () => {
      const id = await newPlan(true); const a = await filed(id)
      await api(approver).post(`/supply/rate-plan-approvals/${a.id}/cancel`).then((r) => expectStatus(r, 403))
      await api(approver).post(`/supply/rate-plan-approvals/${a.id}/reject`, { reason: 'Rates look wrong' }).then((r) => expectStatus(r, 201))
      await execute(a.id).then((r) => expectStatus(r, 409))
      const second = await filed(id)
      await api(operator).post(`/supply/rate-plan-approvals/${second.id}/cancel`).then((r) => expectStatus(r, 201))
      expect((await approvalRow(second.id)).status).toBe('CANCELLED')
      expect((await row(id)).status).toBe('DRAFT')
    })
  })

  describe('execute', () => {
    it('activates exactly once, audits requester, approver and executor, and cannot be replayed', async () => {
      const id = await newPlan(true); const a = await filed(id)
      await execute(a.id).then((r) => expectStatus(r, 409)) // still pending
      await approve(a.id).then((r) => expectStatus(r, 201))
      const done = await execute(a.id).then((r) => expectStatus(r, 201))
      expect(done.body.data).toMatchObject({ ratePlanId: id, status: 'ACTIVE' })
      expect((await row(id)).status).toBe('ACTIVE')
      const events = await statusAudits(id)
      expect(events).toHaveLength(1)
      const payload = events[0].payload as { activation: { mode: string; approvalId: string; requestedById: string; approvedById: string } }
      expect(payload.activation).toMatchObject({ mode: 'approved', approvalId: a.id, requestedById: userIds[0], approvedById: userIds[1] })
      expect(events[0].userId).toBe(userIds[1]) // the executor
      expect((await approvalRow(a.id)).status).toBe('EXECUTED')
      await execute(a.id).then((r) => expectStatus(r, 409))
    })
    it('the requester may apply their own approved request; a read-only user may not', async () => {
      const id = await newPlan(true); const a = await filed(id)
      await approve(a.id).then((r) => expectStatus(r, 201))
      await execute(a.id, readOnly).then((r) => expectStatus(r, 403))
      await execute(a.id, operator).then((r) => expectStatus(r, 201))
      expect((await row(id)).status).toBe('ACTIVE')
    })
    it('two simultaneous executes: exactly one wins and one status change is recorded', async () => {
      const id = await newPlan(true); const a = await filed(id)
      await approve(a.id).then((r) => expectStatus(r, 201))
      const results = await Promise.all([execute(a.id), execute(a.id, operator), execute(a.id)])
      expect(results.filter((r) => r.status === 201)).toHaveLength(1)
      expect(await statusAudits(id)).toHaveLength(1)
    })
    it('a changed price after approval voids it: the plan stays DRAFT, and a new request supersedes the dead one', async () => {
      const id = await newPlan(true); const a = await filed(id)
      await approve(a.id).then((r) => expectStatus(r, 201))
      await api(operator).post('/supply/daily-rates/bulk', { rows: [{ ratePlanId: id, stayDate: nights[0], occupancy: 2, amountMinor: '99000', amountBasis: 'SELL', currency: 'AED' }], confirmLargeChanges: true }).expect(201)
      const refused = await execute(a.id).then((r) => expectStatus(r, 409))
      expect(refused.body.error.code).toBe('RATE_PLAN_CHANGED_SINCE_APPROVAL')
      expect((await row(id)).status).toBe('DRAFT')
      expect(await statusAudits(id)).toHaveLength(0)
      expect((await approvalRow(a.id)).status).toBe('APPROVED') // released, but it can never succeed
      const second = await filed(id)
      expect((await approvalRow(a.id)).status).toBe('CANCELLED')
      await approve(second.id).then((r) => expectStatus(r, 201))
      await execute(second.id).then((r) => expectStatus(r, 201))
      expect((await row(id)).status).toBe('ACTIVE')
    })
    it('an extra night loaded after approval also voids it', async () => {
      const id = await newPlan(true); const a = await filed(id)
      await approve(a.id).then((r) => expectStatus(r, 201))
      await api(operator).post('/supply/daily-rates/bulk', { rows: [{ ratePlanId: id, stayDate: iso(14 + 5), occupancy: 2, amountMinor: '45000', amountBasis: 'SELL', currency: 'AED' }] }).expect(201)
      expect((await execute(a.id).then((r) => expectStatus(r, 409))).body.error.code).toBe('RATE_PLAN_CHANGED_SINCE_APPROVAL')
    })
    it('approval never waives readiness: a contract suspended after approval blocks, and the same approval works once it is fixed', async () => {
      const id = await newPlan(true); const a = await filed(id)
      await approve(a.id).then((r) => expectStatus(r, 201))
      await prisma.contract.update({ where: { id: contractId }, data: { status: 'SUSPENDED' } })
      try {
        const refused = await execute(a.id).then((r) => expectStatus(r, 409))
        expect(refused.body.error.code).toBe('RATE_PLAN_NOT_READY')
        expect((await row(id)).status).toBe('DRAFT')
        expect((await approvalRow(a.id)).status).toBe('APPROVED')
      } finally { await prisma.contract.update({ where: { id: contractId }, data: { status: 'ACTIVE' } }) }
      await execute(a.id).then((r) => expectStatus(r, 201))
      expect((await row(id)).status).toBe('ACTIVE')
    })
    it('a request cannot be used on another plan or tenant', async () => {
      const id = await newPlan(true); const a = await filed(id)
      await approve(a.id).then((r) => expectStatus(r, 201))
      await api(outsider, otherTenantId).post(`/supply/rate-plan-approvals/${a.id}/execute`).then((r) => expectStatus(r, 404))
      expect((await row(id)).status).toBe('DRAFT')
    })
  })

  describe('scope of the control', () => {
    it('suspension stays single-actor', async () => {
      const id = await newPlan(true); const a = await filed(id)
      await approve(a.id).then((r) => expectStatus(r, 201)); await execute(a.id).then((r) => expectStatus(r, 201))
      const version = (await readiness(id)).updatedAt
      await api(operator).post(`/supply/rate-plans/${id}/suspend`, { expectedUpdatedAt: version, reason: 'Supplier asked to pause' }).then((r) => expectStatus(r, 201))
      expect((await row(id)).status).toBe('SUSPENDED')
    })
    it('a suspended plan comes back only through the same approval', async () => {
      const id = await newPlan(true); const first = await filed(id)
      await approve(first.id).then((r) => expectStatus(r, 201)); await execute(first.id).then((r) => expectStatus(r, 201))
      await api(operator).post(`/supply/rate-plans/${id}/suspend`, { expectedUpdatedAt: (await readiness(id)).updatedAt, reason: 'Pause for audit' }).then((r) => expectStatus(r, 201))
      await activate(id).then((r) => expectStatus(r, 409))
      const second = await filed(id)
      await approve(second.id).then((r) => expectStatus(r, 201)); await execute(second.id).then((r) => expectStatus(r, 201))
      expect((await row(id)).status).toBe('ACTIVE')
    })
    it('off is an explicit operator decision: requests are not needed, and the audit event says no approval was involved', async () => {
      process.env.RATE_PLAN_ACTIVATION_APPROVAL = 'off'
      const id = await newPlan(true)
      expect((await fileRequest(id).then((r) => expectStatus(r, 409))).body.error.code).toBe('RATE_PLAN_APPROVAL_NOT_REQUIRED')
      await activate(id).then((r) => expectStatus(r, 201))
      expect(((await statusAudits(id))[0].payload as { activation: { mode: string } }).activation).toEqual({ mode: 'off' })
    })
    it('a misspelt switch fails closed to required', async () => {
      process.env.RATE_PLAN_ACTIVATION_APPROVAL = 'disabled'
      const id = await newPlan(true)
      expect((await activate(id).then((r) => expectStatus(r, 409))).body.error.code).toBe('RATE_PLAN_APPROVAL_REQUIRED')
    })
    it('the latest approval is readable with per-user flags', async () => {
      const id = await newPlan(true); const a = await filed(id)
      const mine = (await api(operator).get(`/supply/rate-plans/${id}/activation-approval`).expect(200)).body.data
      const theirs = (await api(approver).get(`/supply/rate-plans/${id}/activation-approval`).expect(200)).body.data
      expect(mine).toMatchObject({ id: a.id, canDecide: false, canCancel: true })
      expect(theirs).toMatchObject({ id: a.id, canDecide: true, canCancel: false })
      await api(outsider, otherTenantId).get(`/supply/rate-plans/${id}/activation-approval`).then((r) => expectStatus(r, 200)).then((r) => expect(r.body.data).toBeNull())
    })
  })
})
