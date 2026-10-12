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

describe('Rate plan promotions (ADR 0058, S10a)', () => {
  const suffix = `promo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
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
    await api(operator).patch(`/supply/contracts/${contractId}`, { status: 'ACTIVE' }).expect(200)
  }, 90000)

  afterAll(async () => {
    await app?.close()
    const tenants = { in: [tenantId, otherTenantId] }
    await prisma.auditEvent.deleteMany({ where: { tenantId: tenants } })
    await prisma.ratePlanPromotion.deleteMany({ where: { tenantId: tenants } })
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


  const version = async (id: string) => (await api(operator).get(`/supply/rate-plans/${id}/promotions`).expect(200)).body.data.updatedAt as string
  const put = async (id: string, promotions: object[], cookie = operator, expectedUpdatedAt?: string, tenant = tenantId) =>
    api(cookie, tenant).put(`/supply/rate-plans/${id}/promotions`, { expectedUpdatedAt: expectedUpdatedAt ?? await version(id), promotions })
  const none = { percentBp: null, minLeadDays: null, maxLeadDays: null, minNights: null, freeNights: null, bookFrom: null, bookTo: null, stayFrom: null, stayTo: null }
  const early = (name: string, percentBp = 1000, minLeadDays = 7) => ({ ...none, kind: 'EARLY_BIRD', name, percentBp, minLeadDays })
  const free = (name: string, freeNights = 1, minNights = 4) => ({ ...none, kind: 'FREE_NIGHTS', name, freeNights, minNights })
  const stored = (id: string) => prisma.ratePlanPromotion.findMany({ where: { ratePlanId: id }, orderBy: { nameKey: 'asc' } })

  describe('replace and read', () => {
    it('a new plan has no promotions', async () => {
      const id = await newPlan(false)
      expect((await api(operator).get(`/supply/rate-plans/${id}/promotions`).expect(200)).body.data).toMatchObject({ ratePlanId: id, promotions: [] })
    })
    it('stores promotions, returns them, and moves the plan version', async () => {
      const id = await newPlan(false)
      const before = await version(id)
      const saved = (await put(id, [early('Book early'), { ...free('Stay 4 pay 3'), stayFrom: iso(10), stayTo: iso(400) }]).then((r) => expectStatus(r, 200))).body.data
      expect(saved.promotions.map((p: any) => [p.kind, p.name, p.percentBp, p.freeNights, p.minNights, p.minLeadDays])).toEqual([['EARLY_BIRD', 'Book early', 1000, null, null, 7], ['FREE_NIGHTS', 'Stay 4 pay 3', null, 1, 4, null]])
      expect(saved.promotions[1]).toMatchObject({ stayFrom: iso(10), stayTo: iso(400), bookFrom: null })
      expect(new Date(saved.updatedAt).getTime()).toBeGreaterThan(new Date(before).getTime())
    })
    it('replaces the whole set and audits before and after', async () => {
      const id = await newPlan(false)
      await put(id, [early('A')]).then((r) => expectStatus(r, 200))
      await put(id, [early('B', 2000, 14)]).then((r) => expectStatus(r, 200))
      expect((await stored(id)).map((p) => [p.name, p.percentBp, p.minLeadDays])).toEqual([['B', 2000, 14]])
      const events = await prisma.auditEvent.findMany({ where: { tenantId, entityId: id, action: 'supply.rate_plan.promotions_changed' }, orderBy: { createdAt: 'asc' } })
      expect(events).toHaveLength(2)
      expect(events[1]!.payload).toMatchObject({ before: [{ kind: 'EARLY_BIRD', name: 'A', percentBp: 1000 }], after: [{ name: 'B', percentBp: 2000, minLeadDays: 14 }] })
    })
    it('an empty list removes every promotion', async () => {
      const id = await newPlan(false)
      await put(id, [early('A')]).then((r) => expectStatus(r, 200))
      await put(id, []).then((r) => expectStatus(r, 200))
      expect(await stored(id)).toEqual([])
    })
  })

  describe('validation writes nothing', () => {
    it('reports every problem and leaves the stored promotions untouched', async () => {
      const id = await newPlan(false)
      await put(id, [early('Keep')]).then((r) => expectStatus(r, 200))
      const bad = [early('X', 9500), early('x'), { ...free('F', 4, 4) }, { ...early('W'), bookFrom: '2030-02-30' }, { ...none, kind: 'MYSTERY', name: 'M' }, { ...early('Both'), freeNights: 1 }]
      const r = await put(id, bad).then((res) => expectStatus(res, 400))
      const codes = (r.body.error?.details ?? r.body.details ?? r.body.message?.details ?? []).map((d: any) => d.code)
      expect(new Set(codes)).toEqual(new Set(['PROMOTION_PERCENT_INVALID', 'PROMOTION_NAME_DUPLICATE', 'PROMOTION_FREE_NIGHTS_INVALID', 'PROMOTION_WINDOW_INVALID', 'PROMOTION_KIND_INVALID']))
      expect((await stored(id)).map((p) => p.name)).toEqual(['Keep'])
    })
    it('refuses a stale version with the standard conflict', async () => {
      const id = await newPlan(false)
      const stale = await version(id)
      await put(id, [early('A')]).then((r) => expectStatus(r, 200))
      const r = await put(id, [early('B')], operator, stale).then((res) => expectStatus(res, 409))
      expect(JSON.stringify(r.body)).toContain('RATE_PLAN_CHANGED')
      expect((await stored(id)).map((p) => p.name)).toEqual(['A'])
    })
    it('the database itself rejects a promotion the validator would refuse', async () => {
      const id = await newPlan(false)
      const insert = (kind: string, percent: number | null, free: number | null, nights: number | null, lead: number | null) => prisma.$executeRawUnsafe(
        `INSERT INTO "RatePlanPromotion" ("id","tenant_id","rate_plan_id","kind","name","name_key","percent_bp","free_nights","min_nights","min_lead_days","updated_at") VALUES ($1,$2,$3,$4::"PromotionKind",'n','n',$5,$6,$7,$8,now())`,
        `chk-${++n}-${Date.now()}`, tenantId, id, kind, percent, free, nights, lead)
      await expect(insert('EARLY_BIRD', 9500, null, null, 7)).rejects.toThrow(/shape_check/)
      await expect(insert('EARLY_BIRD', 1000, null, null, 0)).rejects.toThrow(/shape_check/)
      await expect(insert('FREE_NIGHTS', null, 4, 4, null)).rejects.toThrow(/shape_check/)
      await expect(insert('FREE_NIGHTS', 1000, 1, 4, null)).rejects.toThrow(/shape_check/)
      await expect(insert('EARLY_BIRD', 1000, null, null, 7)).resolves.toBe(1)
    })
  })

  describe('permissions and tenant isolation', () => {
    it('a read-only user can read but not replace', async () => {
      const id = await newPlan(false)
      await api(readOnly).get(`/supply/rate-plans/${id}/promotions`).expect(200)
      await put(id, [early('A')], readOnly).then((r) => expectStatus(r, 403))
      expect(await stored(id)).toEqual([])
    })
    it("another tenant's plan is not found, for reading and for writing", async () => {
      const id = await newPlan(false)
      await put(id, [early('A')], outsider, new Date().toISOString(), otherTenantId).then((r) => expectStatus(r, 404))
      await api(outsider, otherTenantId).get(`/supply/rate-plans/${id}/promotions`).then((r) => expectStatus(r, 404))
    })
  })

  describe('activation', () => {
    it('a plan with promotions reports the PROMOTIONS_VALID check, and editing them moves the version an approval is bound to', async () => {
      const id = await newPlan(true)
      const readiness = (await api(operator).get(`/supply/rate-plans/${id}/readiness`).expect(200)).body.data
      expect(readiness.checks.find((c: any) => c.code === 'PROMOTIONS_VALID')).toMatchObject({ ok: true })
      const before = readiness.updatedAt
      await put(id, [early('A')]).then((r) => expectStatus(r, 200))
      const after = (await api(operator).get(`/supply/rate-plans/${id}/readiness`).expect(200)).body.data
      expect(after.checks.find((c: any) => c.code === 'PROMOTIONS_VALID')).toMatchObject({ ok: true })
      expect(new Date(after.updatedAt).getTime()).toBeGreaterThan(new Date(before).getTime())
    })
  })
})
