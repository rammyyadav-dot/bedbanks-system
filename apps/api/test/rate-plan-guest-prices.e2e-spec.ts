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

describe('Rate plan guest prices (ADR 0057, S6)', () => {
  const suffix = `guest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
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
    await prisma.approvalRequest.deleteMany({ where: { tenantId: { in: [tenantId, otherTenantId] } } })
    await prisma.user.deleteMany({ where: { id: { in: userIds } } })
    await prisma.tenant.deleteMany({ where: { id: tenants } })
    await prisma.$disconnect()
  })


  const version = async (id: string) => (await api(operator).get(`/supply/rate-plans/${id}/guest-prices`).expect(200)).body.data.updatedAt as string
  const put = async (id: string, lines: object[], cookie = operator, expectedUpdatedAt?: string, tenant = tenantId) =>
    api(cookie, tenant).put(`/supply/rate-plans/${id}/guest-prices`, { expectedUpdatedAt: expectedUpdatedAt ?? await version(id), lines })
  const child = (minAge: number, maxAge: number, amountMinor: string, amountBasis = 'SELL') => ({ kind: 'CHILD', minAge, maxAge, amountMinor, amountBasis, currency: 'AED' })
  const extraAdult = (amountMinor: string, amountBasis = 'SELL') => ({ kind: 'EXTRA_ADULT', amountMinor, amountBasis, currency: 'AED' })
  const lines = (id: string) => prisma.ratePlanGuestPrice.findMany({ where: { ratePlanId: id }, orderBy: [{ kind: 'asc' }, { minAge: 'asc' }] })

  describe('replace and read', () => {
    it('a new plan has no lines, which means the flat rule', async () => {
      const id = await newPlan(false)
      expect((await api(operator).get(`/supply/rate-plans/${id}/guest-prices`).expect(200)).body.data).toMatchObject({ ratePlanId: id, currency: 'AED', occupancy: 2, lines: [] })
    })
    it('stores child bands and one extra-adult line, returns them, and moves the plan version', async () => {
      const id = await newPlan(false)
      const before = await version(id)
      const saved = (await put(id, [child(3, 11, '15000'), child(0, 2, '0'), extraAdult('30000')]).then((r) => expectStatus(r, 200))).body.data
      expect(saved.lines).toEqual([
        { kind: 'CHILD', minAge: 0, maxAge: 2, amountMinor: '0', amountBasis: 'SELL', currency: 'AED' },
        { kind: 'CHILD', minAge: 3, maxAge: 11, amountMinor: '15000', amountBasis: 'SELL', currency: 'AED' },
        { kind: 'EXTRA_ADULT', minAge: 18, maxAge: 99, amountMinor: '30000', amountBasis: 'SELL', currency: 'AED' },
      ])
      expect(new Date(saved.updatedAt).getTime()).toBeGreaterThan(new Date(before).getTime())
    })
    it('replaces the whole set atomically and audits the amounts before and after', async () => {
      const id = await newPlan(false)
      await put(id, [child(0, 17, '10000')]).then((r) => expectStatus(r, 200))
      await put(id, [child(0, 5, '5000'), child(6, 17, '9000')]).then((r) => expectStatus(r, 200))
      expect((await lines(id)).map((l) => [l.minAge, l.maxAge, l.amountMinor])).toEqual([[0, 5, 5000n], [6, 17, 9000n]])
      const events = await prisma.auditEvent.findMany({ where: { tenantId, entityId: id, action: 'supply.rate_plan.guest_prices_changed' }, orderBy: { createdAt: 'asc' } })
      expect(events).toHaveLength(2)
      expect(events[1]!.payload).toMatchObject({ before: [{ kind: 'CHILD', minAge: 0, maxAge: 17, amountMinor: '10000', basis: 'SELL' }], after: [{ minAge: 0, maxAge: 5, amountMinor: '5000' }, { minAge: 6, maxAge: 17, amountMinor: '9000' }] })
    })
    it('an empty list removes every line, returning the plan to the flat rule', async () => {
      const id = await newPlan(false)
      await put(id, [child(0, 17, '10000')]).then((r) => expectStatus(r, 200))
      await put(id, []).then((r) => expectStatus(r, 200))
      expect(await lines(id)).toEqual([])
    })
  })

  describe('validation writes nothing', () => {
    it('reports overlapping bands, a bad currency, a negative amount, a duplicate extra adult, and bad ages, leaving the stored lines untouched', async () => {
      const id = await newPlan(false)
      await put(id, [child(0, 17, '10000')]).then((r) => expectStatus(r, 200))
      const bad = [child(0, 5, '100'), child(5, 8, '100'), { ...child(10, 12, '100'), currency: 'USD' }, extraAdult('1'), extraAdult('2'), { ...child(1, 2, '100'), amountMinor: '-5' }, child(10, 18, '1')]
      const refused = await put(id, bad).then((r) => expectStatus(r, 400))
      const codes = (refused.body.error.details as Array<{ code: string }>).map((d) => d.code)
      expect(codes).toEqual(expect.arrayContaining(['GUEST_PRICE_AGE_BANDS_OVERLAP', 'GUEST_PRICE_CURRENCY_MISMATCH', 'GUEST_PRICE_EXTRA_ADULT_DUPLICATE', 'GUEST_PRICE_AMOUNT_INVALID', 'GUEST_PRICE_AGE_BAND_INVALID']))
      expect((await lines(id)).map((l) => [l.minAge, l.maxAge])).toEqual([[0, 17]])
    })
    it('refuses a missing version, a stale version, too many lines, and a non-object body', async () => {
      const id = await newPlan(false)
      await api(operator).put(`/supply/rate-plans/${id}/guest-prices`, { lines: [] }).then((r) => expectStatus(r, 400))
      const stale = await version(id)
      await put(id, [child(0, 17, '1')]).then((r) => expectStatus(r, 200)) // moves the version
      expect((await put(id, [], operator, stale).then((r) => expectStatus(r, 409))).body.error.code).toBe('RATE_PLAN_CHANGED')
      await put(id, Array.from({ length: 41 }, (_, i) => child(0, 17, String(i)))).then((r) => expectStatus(r, 400))
    })
    it('the database itself refuses a bad row whatever the application does', async () => {
      const id = await newPlan(false)
      const insert = (kind: string, min: number, max: number, amount: number) => prisma.$executeRawUnsafe(`INSERT INTO "RatePlanGuestPrice" (id, tenant_id, rate_plan_id, kind, min_age, max_age, amount_minor, amount_basis, currency, updated_at) VALUES ('${suffix}-g${++n}', '${tenantId}', '${id}', '${kind}'::"GuestPriceKind", ${min}, ${max}, ${amount}, 'SELL', 'AED', now())`)
      await expect(insert('CHILD', 0, 18, 1)).rejects.toThrow(/shape_check/)
      await expect(insert('CHILD', 5, 3, 1)).rejects.toThrow(/shape_check/)
      await expect(insert('CHILD', 0, 5, -1)).rejects.toThrow(/shape_check/)
      await expect(insert('EXTRA_ADULT', 0, 17, 1)).rejects.toThrow(/shape_check/)
      await insert('CHILD', 0, 5, 1)
      await expect(insert('CHILD', 0, 5, 2)).rejects.toThrow(/23505|already exists/)
    })
  })

  describe('authorization and isolation', () => {
    it('a read-only user can read but not write, and the denial is audited; another tenant gets 404 for both', async () => {
      const id = await newPlan(false)
      await api(readOnly).get(`/supply/rate-plans/${id}/guest-prices`).then((r) => expectStatus(r, 200))
      await put(id, [child(0, 17, '1')], readOnly, await version(id)).then((r) => expectStatus(r, 403))
      expect(await lines(id)).toEqual([])
      expect(await prisma.auditEvent.count({ where: { tenantId, action: 'permission.denied' } })).toBeGreaterThan(0)
      await api(outsider, otherTenantId).get(`/supply/rate-plans/${id}/guest-prices`).then((r) => expectStatus(r, 404))
      await put(id, [child(0, 17, '1')], outsider, new Date().toISOString(), otherTenantId).then((r) => expectStatus(r, 404))
      await request(app.getHttpServer()).get(`/api/v1/supply/rate-plans/${id}/guest-prices`).then((r) => expectStatus(r, 401))
    })
  })

  describe('readiness, approval and clone', () => {
    it('activation readiness rejects a line whose basis differs from the rates, naming the check', async () => {
      const id = await newPlan(true) // rates are SELL
      await put(id, [child(0, 17, '1000', 'NET')]).then((r) => expectStatus(r, 200))
      const checks = (await api(operator).get(`/supply/rate-plans/${id}/readiness`).expect(200)).body.data.checks as Array<{ code: string; ok: boolean }>
      expect(checks.find((c) => c.code === 'GUEST_PRICES_VALID')?.ok).toBe(false)
      await put(id, [child(0, 17, '1000', 'SELL')]).then((r) => expectStatus(r, 200))
      expect(((await api(operator).get(`/supply/rate-plans/${id}/readiness`).expect(200)).body.data.checks as Array<{ code: string; ok: boolean }>).find((c) => c.code === 'GUEST_PRICES_VALID')?.ok).toBe(true)
    })
    it('changing a price after an activation request voids the approval', async () => {
      const previous = process.env.RATE_PLAN_ACTIVATION_APPROVAL
      process.env.RATE_PLAN_ACTIVATION_APPROVAL = 'required'
      try {
        const id = await newPlan(true)
        const ready = (await api(operator).get(`/supply/rate-plans/${id}/readiness`).expect(200)).body.data
        const filed = (await api(operator).post(`/supply/rate-plans/${id}/activation-request`, { requestId: `${suffix}-gp-${++n}`, reason: 'Reviewed the prices', expectedUpdatedAt: ready.updatedAt }).then((r) => expectStatus(r, 201))).body.data
        await put(id, [child(0, 17, '1000')]).then((r) => expectStatus(r, 200))
        const refused = await api(operator).post(`/supply/rate-plan-approvals/${filed.id}/approve`, { reason: 'ok' }).then((r) => expectStatus(r, 409))
        expect(refused.body.error.code).toBe('RATE_PLAN_CHANGED_SINCE_REQUEST')
        expect((await prisma.approvalRequest.findUniqueOrThrow({ where: { id: filed.id } })).status).toBe('PENDING')
      } finally { if (previous === undefined) delete process.env.RATE_PLAN_ACTIVATION_APPROVAL; else process.env.RATE_PLAN_ACTIVATION_APPROVAL = previous }
    })
    it('a clone does not copy prices', async () => {
      const id = await newPlan(false)
      await put(id, [child(0, 17, '1000')]).then((r) => expectStatus(r, 200))
      const cloned = await api(operator).post(`/supply/rate-plans/${id}/clone`, { code: `${suffix}-gclone-${++n}` })
      if (cloned.status === 201) expect(await lines(cloned.body.data.id)).toEqual([])
      else expect(cloned.status).toBe(403)
    })
  })
})
