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

describe('Derived rate plans (ADR 0058, S10b)', () => {
  const suffix = `derv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
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
      put: (path: string, body: object) => configure(request(app.getHttpServer()).put(`/api/v1${path}`)).send(body),
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
  const expectStatus = (r: request.Response, status: number) => { if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`); return r }

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
    await setContractStatusFixture(prisma, contractId, 'ACTIVE')
  }, 90000)

  afterAll(async () => {
    await app?.close()
    const tenants = { in: [tenantId, otherTenantId] }
    await prisma.auditEvent.deleteMany({ where: { tenantId: tenants } })
    await prisma.ratePlanPromotion.deleteMany({ where: { tenantId: tenants } })
    await prisma.ratePlan.updateMany({ where: { tenantId: tenants }, data: { derivedFromId: null, derivedMode: null, derivedAdjustment: null } })
    await prisma.ratePlanGuestPrice.deleteMany({ where: { tenantId: tenants } })
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


  const version = async (id: string) => (await api(operator).get(`/supply/rate-plans/${id}/derivation`).expect(200)).body.data.updatedAt as string
  const put = async (id: string, body: Record<string, unknown>, cookie = operator, expectedUpdatedAt?: string, tenant = tenantId) =>
    api(cookie, tenant).put(`/supply/rate-plans/${id}/derivation`, { expectedUpdatedAt: expectedUpdatedAt ?? await version(id), ...body })
  const percent = (parentId: string, adjustment = -1000) => ({ parentId, mode: 'PERCENT_BP', adjustment })
  const codeOf = (r: request.Response) => r.body.error?.code ?? r.body.code ?? r.body.message?.code ?? JSON.stringify(r.body)

  describe('set, read and clear', () => {
    it('a plain plan is not derived and lists its possible parents', async () => {
      const parent = await newPlan(true)
      const id = await newPlan(false)
      const view = (await api(operator).get(`/supply/rate-plans/${id}/derivation`).expect(200)).body.data
      expect(view).toMatchObject({ ratePlanId: id, derived: null, hasOwnRates: false, hasDerivedPlans: false, status: 'DRAFT' })
      expect(view.candidates.map((c: any) => c.id)).toContain(parent)
      expect(view.candidates.map((c: any) => c.id)).not.toContain(id)
    })
    it('derives a plan from a parent, moves its version and audits before and after', async () => {
      const parent = await newPlan(true)
      const id = await newPlan(false)
      const before = await version(id)
      const saved = (await put(id, percent(parent, -1500)).then((r) => expectStatus(r, 200))).body.data
      expect(saved.derived).toMatchObject({ parentId: parent, mode: 'PERCENT_BP', adjustment: -1500 })
      expect(new Date(saved.updatedAt).getTime()).toBeGreaterThan(new Date(before).getTime())
      const row = await prisma.ratePlan.findUniqueOrThrow({ where: { id } })
      expect([row.derivedFromId, row.derivedMode, row.derivedAdjustment]).toEqual([parent, 'PERCENT_BP', -1500])
      const events = await prisma.auditEvent.findMany({ where: { tenantId, entityId: id, action: 'supply.rate_plan.derivation_changed' } })
      expect(events).toHaveLength(1)
      expect(events[0]!.payload).toMatchObject({ before: { parentId: null }, after: { parentId: parent, mode: 'PERCENT_BP', adjustment: -1500 } })
      // a derived plan is no longer a candidate parent, and the parent now reports derived plans
      expect((await api(operator).get(`/supply/rate-plans/${parent}/derivation`).expect(200)).body.data.hasDerivedPlans).toBe(true)
      expect((await api(operator).get(`/supply/rate-plans/${await newPlan(false)}/derivation`).expect(200)).body.data.candidates.map((c: any) => c.id)).not.toContain(id)
    })
    it('changes the terms and clears the derivation', async () => {
      const parent = await newPlan(true)
      const id = await newPlan(false)
      await put(id, percent(parent)).then((r) => expectStatus(r, 200))
      expect((await put(id, { parentId: parent, mode: 'FIXED_MINOR', adjustment: 2500 }).then((r) => expectStatus(r, 200))).body.data.derived).toMatchObject({ mode: 'FIXED_MINOR', adjustment: 2500 })
      expect((await put(id, { parentId: null }).then((r) => expectStatus(r, 200))).body.data.derived).toBeNull()
      const row = await prisma.ratePlan.findUniqueOrThrow({ where: { id } })
      expect([row.derivedFromId, row.derivedMode, row.derivedAdjustment]).toEqual([null, null, null])
    })
  })

  describe('refusals write nothing', () => {
    it('refuses itself, a derived parent, bad terms, own rates, derived children, a live plan and a stale version', async () => {
      const parent = await newPlan(true)
      const child = await newPlan(false)
      await put(child, percent(parent)).then((r) => expectStatus(r, 200))
      const grand = await newPlan(false)
      expect(codeOf(await put(grand, percent(grand)).then((r) => expectStatus(r, 400)))).toBe('DERIVED_PARENT_MISSING')
      expect(codeOf(await put(grand, percent(child)).then((r) => expectStatus(r, 400)))).toBe('DERIVED_PARENT_IS_DERIVED')
      expect(codeOf(await put(grand, percent(parent, 100001)).then((r) => expectStatus(r, 400)))).toBe('DERIVED_TERMS_INVALID')
      expect(codeOf(await put(grand, percent(parent, -9001)).then((r) => expectStatus(r, 400)))).toBe('DERIVED_TERMS_INVALID')
      expect(codeOf(await put(grand, { parentId: parent, mode: 'FIXED_MINOR', adjustment: 1.5 }).then((r) => expectStatus(r, 400)))).toBe('DERIVED_TERMS_INVALID')
      expect(codeOf(await put(grand, { parentId: parent, mode: 'SQUARE', adjustment: 1 }).then((r) => expectStatus(r, 400)))).toBe('DERIVED_TERMS_INVALID')
      expect(codeOf(await put(grand, percent('no-such-plan')).then((r) => expectStatus(r, 400)))).toBe('DERIVED_PARENT_MISSING')
      // a plan with its own rates cannot become derived; a plan that has derived plans cannot become derived
      const withRates = await newPlan(true)
      expect(codeOf(await put(withRates, percent(parent)).then((r) => expectStatus(r, 409)))).toBe('RATE_PLAN_HAS_OWN_RATES')
      const emptyParent = await newPlan(false)
      const kid = await newPlan(false)
      await put(kid, percent(emptyParent)).then((r) => expectStatus(r, 200))
      expect(codeOf(await put(emptyParent, percent(parent)).then((r) => expectStatus(r, 409)))).toBe('RATE_PLAN_HAS_DERIVED_PLANS')
      // a live plan keeps its price source
      await prisma.ratePlan.update({ where: { id: grand }, data: { status: 'ACTIVE' } })
      expect(codeOf(await put(grand, percent(parent)).then((r) => expectStatus(r, 409)))).toBe('RATE_PLAN_NOT_EDITABLE')
      // a stale version
      const stale = await version(child)
      await put(child, percent(parent, -500)).then((r) => expectStatus(r, 200))
      expect(codeOf(await put(child, percent(parent, -700), operator, stale).then((r) => expectStatus(r, 409)))).toBe('RATE_PLAN_CHANGED')
      expect((await prisma.ratePlan.findUniqueOrThrow({ where: { id: grand } })).derivedFromId).toBeNull()
      expect((await prisma.ratePlan.findUniqueOrThrow({ where: { id: child } })).derivedAdjustment).toBe(-500)
    })
    it('a parent of another currency, occupancy or contract is refused', async () => {
      const id = await newPlan(false)
      const single = await newPlan(false, { occupancy: 1 })
      expect(codeOf(await put(id, percent(single)).then((r) => expectStatus(r, 400)))).toBe('DERIVED_PARENT_MISMATCH')
    })
    it('a read-only user can read but not change, and another tenant sees nothing', async () => {
      const parent = await newPlan(true)
      const id = await newPlan(false)
      await api(readOnly).get(`/supply/rate-plans/${id}/derivation`).expect(200)
      await put(id, percent(parent), readOnly).then((r) => expectStatus(r, 403))
      await put(id, percent(parent), outsider, new Date().toISOString(), otherTenantId).then((r) => expectStatus(r, 404))
      await api(outsider, otherTenantId).get(`/supply/rate-plans/${id}/derivation`).then((r) => expectStatus(r, 404))
      expect((await prisma.ratePlan.findUniqueOrThrow({ where: { id } })).derivedFromId).toBeNull()
    })
  })

  describe('the database holds the same rules', () => {
    it('refuses a rate row on a derived plan, a derived parent, a parent of another shape, and a plan as its own parent', async () => {
      const parent = await newPlan(true)
      const child = await newPlan(false)
      await put(child, percent(parent)).then((r) => expectStatus(r, 200))
      await expect(prisma.dailyRate.create({ data: { tenantId, ratePlanId: child, stayDate: new Date(nights[0]), occupancy: 2, amountMinor: 1000n, amountBasis: 'SELL', currency: 'AED' } })).rejects.toThrow(/RATE_PLAN_IS_DERIVED/)
      const other = await newPlan(false)
      await expect(prisma.ratePlan.update({ where: { id: other }, data: { derivedFromId: child, derivedMode: 'PERCENT_BP', derivedAdjustment: 0 } })).rejects.toThrow(/DERIVED_PARENT_IS_DERIVED/)
      const single = await newPlan(false, { occupancy: 1 })
      await expect(prisma.ratePlan.update({ where: { id: other }, data: { derivedFromId: single, derivedMode: 'PERCENT_BP', derivedAdjustment: 0 } })).rejects.toThrow(/DERIVED_PARENT_MISMATCH/)
      await expect(prisma.ratePlan.update({ where: { id: other }, data: { derivedFromId: other, derivedMode: 'PERCENT_BP', derivedAdjustment: 0 } })).rejects.toThrow(/derived_check/)
      await expect(prisma.ratePlan.update({ where: { id: other }, data: { derivedFromId: parent, derivedMode: 'PERCENT_BP', derivedAdjustment: 100_001 } })).rejects.toThrow(/derived_check/)
      await expect(prisma.ratePlan.update({ where: { id: other }, data: { derivedFromId: parent } })).rejects.toThrow(/derived_check/)
      await expect(prisma.ratePlan.update({ where: { id: parent }, data: { derivedFromId: other, derivedMode: 'PERCENT_BP', derivedAdjustment: 0 } })).rejects.toThrow(/DERIVED_PARENT_IS_DERIVED|RATE_PLAN_HAS_OWN_RATES|RATE_PLAN_HAS_DERIVED_PLANS/)
    })
    it('a plan with rates cannot be made derived and a parent cannot be deleted while it has derived plans', async () => {
      const parent = await newPlan(true)
      const rich = await newPlan(true)
      await expect(prisma.ratePlan.update({ where: { id: rich }, data: { derivedFromId: parent, derivedMode: 'PERCENT_BP', derivedAdjustment: 0 } })).rejects.toThrow(/RATE_PLAN_HAS_OWN_RATES/)
      const child = await newPlan(false)
      await put(child, percent(parent)).then((r) => expectStatus(r, 200))
      await expect(prisma.ratePlan.delete({ where: { id: parent } })).rejects.toThrow()
    })
  })

  describe('calendar edits', () => {
    it('refuse a rate edit, a bulk row and a Quick-Update-style import on a derived plan, but allow availability', async () => {
      const parent = await newPlan(true)
      const child = await newPlan(false)
      await put(child, percent(parent)).then((r) => expectStatus(r, 200))
      const row = { ratePlanId: child, stayDate: nights[0], occupancy: 2, amountMinor: '45000', amountBasis: 'SELL', currency: 'AED' }
      const bulk = await api(operator).post('/supply/daily-rates/bulk', { rows: [row] })
      expect(bulk.status).toBe(400); expect(codeOf(bulk)).toBe('RATE_PLAN_IS_DERIVED')
      const one = await api(operator).post('/supply/calendar/preview', { rates: [{ ...row, expectedUpdatedAt: null }] })
      expect([400, 404]).toContain(one.status)
      await api(operator).post('/supply/availability/bulk', { rows: nights.map((stayDate) => ({ ratePlanId: child, stayDate, allotment: 3, sold: 0, stopSell: false, minStay: 1 })) }).then((r) => expectStatus(r, 201))
      expect(await prisma.dailyRate.count({ where: { ratePlanId: child } })).toBe(0)
    })
  })

  describe('activation', () => {
    it('a derived plan is ready only when its parent is active and the derived rates are valid, and the approval fingerprint follows the parent', async () => {
      const parent = await newPlan(true)
      const child = await newPlan(false)
      await put(child, percent(parent, -2000)).then((r) => expectStatus(r, 200))
      await api(operator).post('/supply/availability/bulk', { rows: nights.map((stayDate) => ({ ratePlanId: child, stayDate, allotment: 3, sold: 0, stopSell: false, minStay: 1 })) }).then((r) => expectStatus(r, 201))
      const check = async (id: string) => (await api(operator).get(`/supply/rate-plans/${id}/readiness`).expect(200)).body.data as { ready: boolean; checks: Array<{ code: string; ok: boolean; message: string }> }
      // the parent is still a DRAFT: the derived plan has no usable parent
      let ready = await check(child)
      expect(ready.checks.find((c) => c.code === 'DERIVED_PARENT_VALID')).toMatchObject({ ok: false })
      expect(ready.ready).toBe(false)
      await prisma.ratePlan.update({ where: { id: parent }, data: { status: 'ACTIVE' } })
      ready = await check(child)
      expect(ready.checks.find((c) => c.code === 'DERIVED_PARENT_VALID')).toMatchObject({ ok: true })
      expect(ready.checks.filter((c) => !c.ok).map((c) => c.code)).toEqual([])
      expect(ready.ready).toBe(true)
      // an adjustment that takes a night to zero is refused by the same rate checks
      await put(child, { parentId: parent, mode: 'FIXED_MINOR', adjustment: -45000 }).then((r) => expectStatus(r, 200))
      ready = await check(child)
      expect(ready.checks.find((c) => c.code === 'RATES_POSITIVE')).toMatchObject({ ok: false })
      expect(ready.ready).toBe(false)
    })
  })

  describe('clone', () => {
    it('a clone of a derived plan stays derived from the same parent on the same terms', async () => {
      const parent = await newPlan(true)
      const child = await newPlan(false)
      await put(child, percent(parent, -1200)).then((r) => expectStatus(r, 200))
      const cloned = await api(operator).post(`/supply/rate-plans/${child}/clone`, { code: `${suffix}-dclone-${++n}` })
      if (cloned.status === 201) {
        const row = await prisma.ratePlan.findUniqueOrThrow({ where: { id: cloned.body.data.id } })
        expect([row.derivedFromId, row.derivedMode, row.derivedAdjustment, row.status]).toEqual([parent, 'PERCENT_BP', -1200, 'DRAFT'])
        expect(await prisma.dailyRate.count({ where: { ratePlanId: row.id } })).toBe(0)
      } else expect(cloned.status).toBe(403)
    })
  })
})
