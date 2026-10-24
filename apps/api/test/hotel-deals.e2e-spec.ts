import { INestApplication, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import * as cookieParser from 'cookie-parser'
import * as request from 'supertest'
import { PrismaClient } from '@prisma/client'
import type { SearchCriteria, SearchRateOffer } from '@bedbanks/domain'
import { AppModule } from '../src/app.module'
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor'
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter'
import { hashPassword } from '../src/auth/utils/password'
import { PrismaService } from '../src/database/prisma.service'
import { ContractedInventoryAdapter } from '../src/agent/contracted-inventory.adapter'
import { HotelDealService } from '../src/promotions/hotel-deal.service'

/**
 * ADR 0089: hotel deals and promotions, end to end. The real HTTP API, the real PostgreSQL (triggers, constraints, forced RLS) and the real Agent search and
 * recheck adapter. The owner Prisma client is used only to arrange the catalogue and to observe or attack at the database.
 */
const prisma = new PrismaClient()
const HOTEL_TIME_ZONE = 'Asia/Dubai'
const DAY = 86_400_000
const hotelDay = (offset: number) => new Date(Date.parse(`${new Date().toLocaleDateString('en-CA', { timeZone: HOTEL_TIME_ZONE })}T00:00:00.000Z`) + offset * DAY).toISOString().slice(0, 10)

describe('Hotel deals and promotions (ADR 0089)', () => {
  const suffix = `deal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const password = 'deal-certification-password'
  const checkIn = hotelDay(20)
  const checkOut = hotelDay(23) // three nights
  const nights = [hotelDay(20), hotelDay(21), hotelDay(22)]
  let app: INestApplication
  let appPrisma: PrismaService
  let adapter: ContractedInventoryAdapter
  let deals: HotelDealService
  let tenantId: string, otherTenantId: string
  let maker: string, checker: string, reader: string, outsider: string
  const userIds: string[] = []
  const roleIds: string[] = []
  let makerId: string, checkerId: string, agentUserId: string, plainAgentId: string
  let supplierId: string, hotelId: string, otherHotelId: string, otherTenantHotelId: string, roomId: string, otherRoomId: string, boardId: string, contractId: string, otherContractId: string, agencyId: string
  let sellPlan: string, netPlan: string, otherHotelPlan: string, draftPlan: string
  let n = 0

  const api = (cookie: string, tenant = tenantId) => {
    const configure = (test: request.Test) => test.set('Cookie', cookie).set('x-fbeds-tenant-id', tenant)
    return {
      get: (path: string) => configure(request(app.getHttpServer()).get(`/api/v1${path}`)),
      post: (path: string, body: object = {}) => configure(request(app.getHttpServer()).post(`/api/v1${path}`)).send(body),
      put: (path: string, body: object) => configure(request(app.getHttpServer()).put(`/api/v1${path}`)).send(body),
    }
  }
  const login = async (email: string) => {
    const response = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', 'http://localhost:3001').send({ email, password }).expect(200)
    return (response.headers['set-cookie'][0] as string).split(';')[0]
  }
  const ROUTE = '/admin/commercial/promotions'
  const expectStatus = (r: request.Response, status: number) => { if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`); return r }
  const errorCode = (r: request.Response): string | undefined => r.body?.error?.code
  const unique = (label: string) => `${suffix}-${label}-${++n}`

  const body = (over: Record<string, unknown> = {}) => ({
    hotelId, idempotencyKey: unique('key').padEnd(12, 'x'), code: `D${Date.now().toString(36)}${++n}`.toUpperCase(), name: `Deal ${n}`, kind: 'PERCENT_OFF', percentBp: 2000, ratePlanIds: [sellPlan], ...over,
  })
  const create = async (over: Record<string, unknown> = {}, cookie = maker) => (await expectStatus(await api(cookie).post(ROUTE, body(over)), 201)).body.data
  /** draft -> submit -> approve by the checker -> activate by the maker. */
  const goLive = async (over: Record<string, unknown> = {}) => {
    const draft = await create(over)
    const submitted = (await expectStatus(await api(maker).post(`${ROUTE}/${draft.id}/submit`, { expectedVersion: draft.version, requestId: unique('req').padEnd(12, 'x'), reason: 'Reviewed and ready' }), 200)).body.data
    await expectStatus(await api(checker).post(`${ROUTE}/approvals/${submitted.approval.id}/approve`, { reason: 'Terms checked' }), 200)
    const live = (await expectStatus(await api(maker).post(`${ROUTE}/approvals/${submitted.approval.id}/execute`), 200)).body.data
    return { id: draft.id as string, approvalId: submitted.approval.id as string, live }
  }

  const criteria = (patch: Partial<SearchCriteria> = {}): SearchCriteria => ({ destination: 'Dubai', checkIn, checkOut, rooms: 1, adults: 2, children: 0, childAges: [], nationality: 'AE', currency: 'AED', ...patch })
  const offers = async (userId?: string, patch: Partial<SearchCriteria> = {}): Promise<SearchRateOffer[]> => {
    const result = await adapter.search(criteria(patch), { tenantId, requestId: 'r', ...(userId ? { userId } : {}) })
    return result.offers.flatMap((h) => h.rooms.flatMap((r) => r.rates))
  }
  const priceOf = async (plan: string, userId?: string): Promise<{ total: number; promotion?: { name: string; kind: string } } | undefined> => {
    const offer = (await offers(userId)).find((rate) => rate.ratePlanId === plan)
    return offer ? { total: offer.sellAmountMinor, promotion: offer.promotion } : undefined
  }

  beforeAll(async () => {
    await prisma.$connect()
    const [tenant, other] = await Promise.all([prisma.tenant.create({ data: { name: `${suffix} Tenant`, slug: suffix } }), prisma.tenant.create({ data: { name: `${suffix} Other`, slug: `${suffix}-other` } })])
    tenantId = tenant.id; otherTenantId = other.id
    const passwordHash = await hashPassword(password)
    const names = ['maker', 'checker', 'reader', 'outsider', 'agent', 'plainagent']
    const users = await Promise.all(names.map((name) => prisma.user.create({ data: { email: `${suffix}-${name}@example.test`, passwordHash } })))
    userIds.push(...users.map((user) => user.id))
    ;[makerId, checkerId, , , agentUserId, plainAgentId] = userIds
    const keys = ['supply.rates.read', 'supply.rates.manage', 'supply.hotels.read', 'supply.hotels.manage', 'supply.rooms.read', 'supply.rooms.manage']
    const permissions = await Promise.all(keys.map((key) => prisma.permission.upsert({ where: { key }, update: {}, create: { key, description: key } })))
    const grant = async (tenant: string, name: string, granted: typeof permissions) => {
      const role = await prisma.role.create({ data: { tenantId: tenant, name: `${suffix}-${name}` } })
      roleIds.push(role.id)
      await prisma.rolePermission.createMany({ data: granted.map((permission) => ({ roleId: role.id, permissionId: permission.id })) })
      return role.id
    }
    const full = await grant(tenantId, 'full', permissions)
    const readRole = await grant(tenantId, 'read', permissions.filter((permission) => permission.key.endsWith('.read')))
    const outsiderRole = await grant(otherTenantId, 'outsider', permissions)
    await prisma.membership.createMany({ data: [{ tenantId, userId: userIds[0], role: 'owner' }, { tenantId, userId: userIds[1], role: 'owner' }, { tenantId, userId: userIds[2], role: 'member' }, { tenantId: otherTenantId, userId: userIds[3], role: 'owner' }, { tenantId, userId: userIds[4], role: 'member' }, { tenantId, userId: userIds[5], role: 'member' }] })
    await prisma.userRole.createMany({ data: [{ tenantId, userId: userIds[0], roleId: full }, { tenantId, userId: userIds[1], roleId: full }, { tenantId, userId: userIds[2], roleId: readRole }, { tenantId: otherTenantId, userId: userIds[3], roleId: outsiderRole }] })

    // Catalogue, arranged straight at the owner connection: a published, mapped, contracted hotel with two ACTIVE plans (one SELL, one NET with a 10 percent markup).
    supplierId = (await prisma.supplier.create({ data: { tenantId, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${suffix} s`, displayName: 'S', countryCode: 'AE', defaultCurrency: 'AED' } })).id
    const hotel = async (name: string, tenant = tenantId) => (await prisma.hotel.create({ data: { tenantId: tenant, name, propertyType: 'HOTEL', starRating: 5, city: 'Dubai', countryCode: 'AE', timeZone: HOTEL_TIME_ZONE, contentStatus: 'COMPLETE' } })).id
    hotelId = await hotel(`${suffix} hotel`); otherHotelId = await hotel(`${suffix} hotel two`); otherTenantHotelId = await hotel(`${suffix} foreign hotel`, otherTenantId)
    roomId = (await prisma.roomType.create({ data: { hotelId, name: 'Room', code: `${suffix}-a`, maxAdults: 2, maxOccupancy: 2 } })).id
    otherRoomId = (await prisma.roomType.create({ data: { hotelId: otherHotelId, name: 'Room', code: `${suffix}-b`, maxAdults: 2, maxOccupancy: 2 } })).id
    boardId = (await prisma.boardBasis.create({ data: { tenantId, code: 'ROH', name: `ROH ${suffix}` } })).id
    const map = async (hotel: string, room: string, code: string) => {
      const hm = (await prisma.supplierHotelMapping.create({ data: { tenantId, supplierId, hotelId: hotel, supplierHotelId: `${suffix}-${code}`, status: 'MAPPED' } })).id
      await prisma.supplierRoomMapping.create({ data: { tenantId, supplierHotelMappingId: hm, hotelId: hotel, supplierRoomId: `${suffix}-r${code}`, roomTypeId: room, status: 'MAPPED' } })
      return (await prisma.contract.create({ data: { tenantId, supplierId, supplierHotelMappingId: hm, code: `${suffix}-${code}`, status: 'ACTIVE', validFrom: new Date('2026-01-01'), validTo: new Date('2099-12-31'), settlementCurrency: 'AED' } })).id
    }
    contractId = await map(hotelId, roomId, 'a'); otherContractId = await map(otherHotelId, otherRoomId, 'b')
    const plan = async (contract: string, room: string, code: string, basis: 'SELL' | 'NET', amount: bigint, status: 'ACTIVE' | 'DRAFT' = 'ACTIVE') => {
      const id = (await prisma.ratePlan.create({ data: { tenantId, contractId: contract, roomTypeId: room, boardBasisId: boardId, code: `${suffix}-${code}`, status, occupancy: 2, currency: 'AED', releaseDays: 0, releaseTimeLocal: '00:00' } })).id
      await prisma.dailyRate.createMany({ data: nights.map((d) => ({ tenantId, ratePlanId: id, stayDate: new Date(d), occupancy: 2, amountMinor: amount, amountBasis: basis, currency: 'AED' })) })
      await prisma.dailyAvailability.createMany({ data: [...nights, checkOut].map((d) => ({ tenantId, ratePlanId: id, stayDate: new Date(d), allotment: 5 })) })
      return id
    }
    sellPlan = await plan(contractId, roomId, 'sell', 'SELL', 50000n)
    netPlan = await plan(contractId, roomId, 'net', 'NET', 40000n)
    draftPlan = await plan(contractId, roomId, 'draft', 'SELL', 50000n, 'DRAFT')
    otherHotelPlan = await plan(otherContractId, otherRoomId, 'other', 'SELL', 50000n)
    await prisma.commercialMarkupRule.create({ data: { tenantId, scope: 'TENANT_DEFAULT', basisPoints: 1000, validFrom: new Date('2026-01-01'), status: 'ACTIVE', activatedAt: new Date(), reason: 'test', createdById: makerId } })
    agencyId = (await prisma.agency.create({ data: { tenantId, code: `AG${Date.now().toString(36)}`.toUpperCase(), name: `${suffix} agency`, countryCode: 'IN', createdById: makerId } })).id
    await prisma.agencyMember.create({ data: { tenantId, agencyId, userId: agentUserId } })

    const module = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = module.createNestApplication()
    app.use(cookieParser())
    app.setGlobalPrefix('api/v1')
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
    app.useGlobalFilters(new HttpExceptionFilter())
    app.useGlobalInterceptors(new ResponseInterceptor())
    await app.init()
    deals = app.get(HotelDealService)
    appPrisma = new PrismaService()
    await appPrisma.$connect()
    adapter = new ContractedInventoryAdapter(appPrisma)
    ;[maker, checker, reader, outsider] = await Promise.all(['maker', 'checker', 'reader', 'outsider'].map((name) => login(`${suffix}-${name}@example.test`)))
  }, 120000)

  afterAll(async () => {
    await app?.close()
    await appPrisma?.$disconnect()
    const tenants = { in: [tenantId, otherTenantId] }
    // Deals are never deleted in production (they are archived), so the scope trigger refuses it; the disposable test data is removed with it switched off.
    await prisma.$executeRawUnsafe('ALTER TABLE "HotelDealRatePlan" DISABLE TRIGGER "HotelDealRatePlan_guard"')
    try { await prisma.hotelDealRatePlan.deleteMany({ where: { tenantId: tenants } }) } finally { await prisma.$executeRawUnsafe('ALTER TABLE "HotelDealRatePlan" ENABLE TRIGGER "HotelDealRatePlan_guard"') }
    await prisma.hotelDeal.deleteMany({ where: { tenantId: tenants } })
    await prisma.approvalRequest.deleteMany({ where: { tenantId: tenants } })
    await prisma.auditEvent.deleteMany({ where: { tenantId: tenants } })
    await prisma.commercialMarkupRule.deleteMany({ where: { tenantId: tenants } })
    await prisma.dailyAvailability.deleteMany({ where: { tenantId: tenants } }); await prisma.dailyRate.deleteMany({ where: { tenantId: tenants } }); await prisma.ratePlan.deleteMany({ where: { tenantId: tenants } })
    await prisma.contract.deleteMany({ where: { tenantId: tenants } }); await prisma.supplierRoomMapping.deleteMany({ where: { tenantId: tenants } }); await prisma.supplierHotelMapping.deleteMany({ where: { tenantId: tenants } })
    await prisma.agencyMember.deleteMany({ where: { tenantId: tenants } }); await prisma.agency.deleteMany({ where: { tenantId: tenants } })
    await prisma.boardBasis.deleteMany({ where: { tenantId: tenants } }); await prisma.roomType.deleteMany({ where: { hotelId: { in: [hotelId, otherHotelId] } } }); await prisma.hotel.deleteMany({ where: { tenantId: tenants } })
    await prisma.supplier.deleteMany({ where: { tenantId: tenants } })
    await prisma.userRole.deleteMany({ where: { tenantId: tenants } }); await prisma.rolePermission.deleteMany({ where: { roleId: { in: roleIds } } }); await prisma.role.deleteMany({ where: { id: { in: roleIds } } })
    await prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => undefined)
    await prisma.membership.deleteMany({ where: { tenantId: tenants } })
    await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined)
    await prisma.tenant.deleteMany({ where: { id: tenants } }).catch(() => undefined)
    await prisma.$disconnect()
  })

  /** A deal row written straight at the owner connection (the only way to arrange states the API will never create). The code key is the lower-case code. */
  const rawDeal = (data: Record<string, unknown> & { code: string }) => prisma.hotelDeal.create({ data: { codeKey: data.code.toLowerCase(), ...data } as never })
  const FULL = 50000 * 3
  describe('authentication and authorization', () => {
    it('refuses unauthenticated calls', async () => {
      expect((await request(app.getHttpServer()).get(`/api/v1${ROUTE}`)).status).toBe(401)
      expect((await request(app.getHttpServer()).post(`/api/v1${ROUTE}`).send(body())).status).toBe(401)
    })

    it('a read-only user can list and read but cannot create, edit, submit, approve, pause or reconcile (403, and the denial is audited)', async () => {
      const deal = await create()
      expect((await api(reader).get(ROUTE)).status).toBe(200)
      expect((await api(reader).get(`${ROUTE}/${deal.id}`)).status).toBe(200)
      expect((await api(reader).get(`${ROUTE}/summary`)).status).toBe(200)
      expect((await api(reader).post(`${ROUTE}/${deal.id}/validate`)).status).toBe(200)
      for (const call of [
        () => api(reader).post(ROUTE, body()), () => api(reader).put(`${ROUTE}/${deal.id}`, { ...body(), expectedVersion: 1 }),
        () => api(reader).post(`${ROUTE}/${deal.id}/submit`, { expectedVersion: 1, requestId: 'abcdefgh12', reason: 'because' }), () => api(reader).post(`${ROUTE}/${deal.id}/pause`, { reason: 'because' }),
        () => api(reader).post(`${ROUTE}/${deal.id}/suspend`, { reason: 'because' }), () => api(reader).post(`${ROUTE}/${deal.id}/archive`, {}), () => api(reader).post(`${ROUTE}/reconcile`),
        () => api(reader).post(`${ROUTE}/approvals/anything/approve`, { reason: 'because' }), () => api(reader).post(`${ROUTE}/approvals/anything/execute`),
      ]) expect((await call()).status).toBe(403)
      expect(await prisma.auditEvent.count({ where: { tenantId, action: 'permission.denied', userId: userIds[2] } })).toBeGreaterThan(0)
      expect((await prisma.hotelDeal.findFirst({ where: { id: deal.id, tenantId } }))?.status).toBe('DRAFT')
    })
  })

  describe('authoring and validation', () => {
    it('creates a draft with its scope, audit and a version, and never activates it', async () => {
      const deal = await create({ kind: 'FIXED_OFF', percentBp: undefined, amountMinor: '2500', currency: 'AED', amountScope: 'PER_NIGHT', ratePlanIds: [sellPlan, netPlan], weekdays: [4, 5], channels: ['PORTAL'], sourceMarkets: ['IN'], minSellFloorMinor: '20000', internalNotes: 'secret note', publicDescription: 'Great' })
      expect(deal).toMatchObject({ status: 'DRAFT', effectiveStatus: 'DRAFT', version: 1, planCount: 2, hotelId, terms: { kind: 'FIXED_OFF', amountMinor: '2500', currency: 'AED', weekdays: [4, 5], channels: ['PORTAL'], sourceMarkets: ['IN'], minSellFloorMinor: '20000' } })
      expect(deal.capabilities).toMatchObject({ canEdit: true, canSubmit: true, canApprove: false, canActivate: false })
      expect(deal.termsFingerprint).toBeNull()
      expect(await priceOf(sellPlan)).toMatchObject({ total: FULL })
      const events = await prisma.auditEvent.findMany({ where: { tenantId, entityType: 'hotel_deal', entityId: deal.id } })
      expect(events.map((e) => e.action)).toEqual(['promotion.deal.created'])
      expect(JSON.stringify(events[0].payload)).not.toContain('secret note')
    })

    it('refuses mass assignment, unsupported kinds and unknown fields, naming every problem', async () => {
      for (const field of ['status', 'tenantId', 'approvalId', 'activatedAt', 'version', 'allowBelowNet', 'termsFingerprint']) {
        const r = await api(maker).post(ROUTE, body({ [field]: field === 'status' ? 'ACTIVE' : 'x' }))
        expect([r.status, errorCode(r)]).toEqual([400, 'DEAL_FIELD_NOT_ALLOWED'])
      }
      const unsupported = await api(maker).post(ROUTE, body({ kind: 'PACKAGE_ADD_ON' }))
      expect([unsupported.status, errorCode(unsupported)]).toEqual([400, 'PROMOTION_TYPE_UNSUPPORTED'])
      const many = await api(maker).post(ROUTE, { hotelId, idempotencyKey: 'abcdefgh12', kind: 'FIXED_OFF', code: '!', name: '', ratePlanIds: [] })
      expect(many.status).toBe(400)
      expect(many.body.error.details.length).toBeGreaterThan(3)
      expect(await prisma.hotelDeal.count({ where: { tenantId, idempotencyKey: 'abcdefgh12' } })).toBe(0)
    })

    it('rejects platform-funded discounts and a below-net override flag', async () => {
      expect(errorCode(await api(maker).post(ROUTE, body({ fundingSource: 'PLATFORM' })))).toBe('DEAL_FUNDING_UNSUPPORTED')
      expect(errorCode(await api(maker).post(ROUTE, body({ belowNetOverride: true })))).toBe('DEAL_FIELD_NOT_ALLOWED')
    })

    it('keeps the code unique per tenant, ignoring case, and replays an idempotent create without a second row', async () => {
      const code = `UNIQ${Date.now().toString(36)}A`
      const first = await create({ code })
      const clash = await api(maker).post(ROUTE, body({ code: code.toLowerCase() }))
      expect([clash.status, errorCode(clash)]).toEqual([409, 'DEAL_CODE_TAKEN'])
      const key = unique('idem').padEnd(14, 'k')
      const payload = body({ idempotencyKey: key })
      const a = await expectStatus(await api(maker).post(ROUTE, payload), 201)
      const b = await expectStatus(await api(maker).post(ROUTE, payload), 201)
      expect(b.body.data.id).toBe(a.body.data.id)
      expect(await prisma.hotelDeal.count({ where: { tenantId, idempotencyKey: key } })).toBe(1)
      const reused = await api(maker).post(ROUTE, { ...payload, code: `OTHER${Date.now().toString(36)}`.toUpperCase(), percentBp: 500 })
      expect([reused.status, errorCode(reused)]).toEqual([409, 'IDEMPOTENCY_KEY_REUSED'])
      expect((await api(checker).post(ROUTE, payload)).status).toBe(409)
      expect(first.id).toBeTruthy()
    })

    it('answers two concurrent creates with one idempotency key with the same deal and one row', async () => {
      const key = unique('race').padEnd(14, 'k')
      const payload = body({ idempotencyKey: key })
      const [a, b] = await Promise.all([api(maker).post(ROUTE, payload), api(maker).post(ROUTE, payload)])
      expect([a.status, b.status]).toEqual([201, 201])
      expect(a.body.data.id).toBe(b.body.data.id)
      expect(await prisma.hotelDeal.count({ where: { tenantId, idempotencyKey: key } })).toBe(1)
      expect(await prisma.auditEvent.count({ where: { tenantId, entityType: 'hotel_deal', entityId: a.body.data.id, action: 'promotion.deal.created' } })).toBe(1)
    })

    it('keeps every selected plan inside the hotel and the tenant', async () => {
      expect(errorCode(await api(maker).post(ROUTE, body({ ratePlanIds: [sellPlan, otherHotelPlan] })))).toBe('DEAL_PLAN_NOT_IN_HOTEL')
      expect(errorCode(await api(maker).post(ROUTE, body({ ratePlanIds: ['does-not-exist'] })))).toBe('DEAL_PLAN_NOT_IN_HOTEL')
      expect(errorCode(await api(maker).post(ROUTE, body({ agencyIds: ['nope'] })))).toBe('AGENCY_NOT_FOUND')
      expect(errorCode(await api(maker).post(ROUTE, body({ incompatibleDealIds: ['nope'] })))).toBe('INCOMPATIBLE_DEAL_NOT_FOUND')
      expect((await api(maker).post(ROUTE, body({ hotelId: 'nope' }))).status).toBe(404)
    })

    it('replaces a draft with a version check, and a second writer holding the old version conflicts', async () => {
      const draft = await create()
      const edited = (await expectStatus(await api(maker).put(`${ROUTE}/${draft.id}`, { ...body({ code: draft.code, name: 'Renamed', percentBp: 1500 }), idempotencyKey: undefined, hotelId: undefined, expectedVersion: 1 }), 200)).body.data
      expect(edited).toMatchObject({ version: 2, name: 'Renamed', percentBp: 1500 })
      const stale = await api(checker).put(`${ROUTE}/${draft.id}`, { ...body({ code: draft.code }), idempotencyKey: undefined, hotelId: undefined, expectedVersion: 1 })
      expect([stale.status, errorCode(stale)]).toEqual([409, 'DEAL_CHANGED'])
      const events = await prisma.auditEvent.findMany({ where: { tenantId, entityType: 'hotel_deal', entityId: draft.id }, orderBy: { createdAt: 'asc' } })
      expect(events.map((e) => e.action)).toEqual(['promotion.deal.created', 'promotion.deal.updated'])
      expect(JSON.stringify(events[1].payload)).toContain('percentBp')
      const moved = await api(maker).put(`${ROUTE}/${draft.id}`, { ...body({ code: draft.code }), idempotencyKey: undefined, expectedVersion: 2, hotelId: otherHotelId })
      expect(errorCode(moved)).toBe('DEAL_FIELD_NOT_ALLOWED')
    })

    it('validates against the catalogue: no active plan, currency mismatch and overlaps are reported, errors block submission', async () => {
      const onlyDraft = await create({ ratePlanIds: [draftPlan] })
      const v = (await expectStatus(await api(maker).post(`${ROUTE}/${onlyDraft.id}/validate`), 200)).body.data
      expect(v.valid).toBe(false)
      expect(v.issues.map((i: { code: string }) => i.code)).toContain('NO_ACTIVE_RATE_PLAN')
      const submit = await api(maker).post(`${ROUTE}/${onlyDraft.id}/submit`, { expectedVersion: 1, requestId: unique('req').padEnd(12, 'x'), reason: 'try it' })
      expect([submit.status, errorCode(submit)]).toEqual([409, 'DEAL_VALIDATION_FAILED'])
      expect((await prisma.hotelDeal.findFirst({ where: { id: onlyDraft.id, tenantId } }))?.status).toBe('DRAFT')
      expect(await prisma.approvalRequest.count({ where: { tenantId, entityId: onlyDraft.id } })).toBe(0)

      const fixed = await create({ kind: 'FIXED_OFF', percentBp: undefined, amountMinor: '100', currency: 'AED', amountScope: 'PER_NIGHT', ratePlanIds: [sellPlan] })
      await prisma.ratePlan.update({ where: { id: sellPlan }, data: { currency: 'USD' } })
      const mismatch = (await api(maker).post(`${ROUTE}/${fixed.id}/validate`)).body.data
      await prisma.ratePlan.update({ where: { id: sellPlan }, data: { currency: 'AED' } })
      expect(mismatch.issues.map((i: { code: string }) => i.code)).toContain('PLAN_CURRENCY_MISMATCH')

      const live = await goLive({ code: `OVL${Date.now().toString(36)}`.toUpperCase() })
      const overlapping = await create({ ratePlanIds: [sellPlan] })
      const warns = (await api(maker).post(`${ROUTE}/${overlapping.id}/validate`)).body.data.issues
      expect(warns.find((i: { code: string }) => i.code === 'OVERLAPS_DEAL')).toMatchObject({ severity: 'WARNING' })
      await api(maker).post(`${ROUTE}/${live.id}/suspend`, { reason: 'cleanup after the overlap test' })
    })
  })

  describe('approval, activation and separation of duties', () => {
    it('walks draft, submit, approve, activate; the maker cannot decide their own request; approval alone sells nothing', async () => {
      const draft = await create({ percentBp: 2000 })
      const submitted = (await expectStatus(await api(maker).post(`${ROUTE}/${draft.id}/submit`, { expectedVersion: 1, requestId: unique('req').padEnd(12, 'x'), reason: 'Ready for review' }), 200)).body.data
      expect(submitted).toMatchObject({ status: 'PENDING_APPROVAL', version: 1, approval: { status: 'PENDING', canDecide: false, canCancel: true } })
      expect(submitted.termsFingerprint).toMatch(/^[0-9a-f]{64}$/)
      // The maker may not decide, whatever their permissions.
      const self = await api(maker).post(`${ROUTE}/approvals/${submitted.approval.id}/approve`, { reason: 'I approve myself' })
      expect(self.status).toBe(403)
      // A deal that is waiting for approval is locked.
      const locked = await api(maker).put(`${ROUTE}/${draft.id}`, { ...body({ code: draft.code, percentBp: 9000, minSellFloorMinor: '100' }), idempotencyKey: undefined, hotelId: undefined, expectedVersion: 1 })
      expect([locked.status, errorCode(locked)]).toEqual([409, 'DEAL_TERMS_LOCKED'])
      // A decision needs a reason.
      expect((await api(checker).post(`${ROUTE}/approvals/${submitted.approval.id}/approve`, {})).status).toBe(400)
      const approved = (await expectStatus(await api(checker).post(`${ROUTE}/approvals/${submitted.approval.id}/approve`, { reason: 'Terms checked' }), 200)).body.data
      expect(approved).toMatchObject({ status: 'APPROVED', approval: { status: 'APPROVED', decidedById: checkerId, canExecute: true }, capabilities: { canActivate: true } })
      // Approved is not live: nothing is discounted yet.
      expect(await priceOf(sellPlan)).toMatchObject({ total: FULL })
      const live = (await expectStatus(await api(maker).post(`${ROUTE}/approvals/${submitted.approval.id}/execute`), 200)).body.data
      expect(live).toMatchObject({ status: 'ACTIVE', effectiveStatus: 'ACTIVE', approval: { status: 'EXECUTED' } })
      expect(live.activatedAt).toBeTruthy()
      // Single use.
      expect((await api(maker).post(`${ROUTE}/approvals/${submitted.approval.id}/execute`)).status).toBe(409)
      expect(await prisma.hotelDeal.findFirst({ where: { id: draft.id, tenantId }, select: { activatedById: true, approvalId: true } })).toEqual({ activatedById: makerId, approvalId: submitted.approval.id })
      const trail = (await api(reader).get(`${ROUTE}/${draft.id}/audit-log`)).body.data
      expect(trail.events.map((e: { action: string }) => e.action)).toEqual(['promotion.deal.created', 'promotion.deal.submitted', 'promotion.deal.approved', 'promotion.deal.activated'])
      expect(trail.events.find((e: { action: string }) => e.action === 'promotion.deal.activated').actorUserId).toBe(makerId)
      expect(trail.approvals[0]).toMatchObject({ status: 'EXECUTED', requestedById: makerId, decidedById: checkerId })
      await api(maker).post(`${ROUTE}/${draft.id}/suspend`, { reason: 'cleanup after the walk-through' })
    })

    it('records a rejection with its reason, and the maker returns it to a new draft version', async () => {
      const draft = await create()
      const sub = (await api(maker).post(`${ROUTE}/${draft.id}/submit`, { expectedVersion: 1, requestId: unique('req').padEnd(12, 'x'), reason: 'Please review' })).body.data
      const rejected = (await expectStatus(await api(checker).post(`${ROUTE}/approvals/${sub.approval.id}/reject`, { reason: 'Discount too deep for the season' }), 200)).body.data
      expect(rejected).toMatchObject({ status: 'REJECTED', statusReason: 'Discount too deep for the season', approval: { status: 'REJECTED', decisionReason: 'Discount too deep for the season' } })
      expect((await api(maker).post(`${ROUTE}/approvals/${sub.approval.id}/execute`)).status).toBe(409)
      const again = (await expectStatus(await api(maker).post(`${ROUTE}/${draft.id}/return-to-draft`, { expectedVersion: 1 }), 200)).body.data
      expect(again).toMatchObject({ status: 'DRAFT', version: 2, termsFingerprint: null, statusReason: null })
      expect((await prisma.approvalRequest.findFirst({ where: { id: sub.approval.id, tenantId } }))?.decisionReason).toBe('Discount too deep for the season')
    })

    it('lets only the maker withdraw a pending request, returning the deal to a new draft version', async () => {
      const draft = await create()
      const sub = (await api(maker).post(`${ROUTE}/${draft.id}/submit`, { expectedVersion: 1, requestId: unique('req').padEnd(12, 'x'), reason: 'Please review' })).body.data
      expect((await api(checker).post(`${ROUTE}/${draft.id}/withdraw`)).status).toBe(403)
      const back = (await expectStatus(await api(maker).post(`${ROUTE}/${draft.id}/withdraw`), 200)).body.data
      expect(back).toMatchObject({ status: 'DRAFT', version: 2 })
      expect((await api(checker).post(`${ROUTE}/approvals/${sub.approval.id}/approve`, { reason: 'Too late for this one' })).status).toBe(409)
    })

    it('binds approval to the exact terms: the database refuses a change to anything not a draft and any skipped step', async () => {
      const live = await goLive()
      const row = () => prisma.hotelDeal.findFirstOrThrow({ where: { id: live.id, tenantId } })
      await expect(prisma.$executeRawUnsafe(`UPDATE "HotelDeal" SET "percent_bp" = 9000 WHERE "id" = '${live.id}'`)).rejects.toThrow(/HOTEL_DEAL_TERMS_LOCKED/)
      await expect(prisma.$executeRawUnsafe(`UPDATE "HotelDeal" SET "name" = 'Sneaky' WHERE "id" = '${live.id}'`)).rejects.toThrow(/HOTEL_DEAL_TERMS_LOCKED/)
      await expect(prisma.$executeRawUnsafe(`DELETE FROM "HotelDealRatePlan" WHERE "deal_id" = '${live.id}'`)).rejects.toThrow(/HOTEL_DEAL_SCOPE_LOCKED/)
      await expect(prisma.$executeRawUnsafe(`INSERT INTO "HotelDealRatePlan" ("tenant_id", "deal_id", "rate_plan_id") VALUES ('${tenantId}', '${live.id}', '${netPlan}')`)).rejects.toThrow(/HOTEL_DEAL_SCOPE_LOCKED/)
      await expect(prisma.$executeRawUnsafe(`UPDATE "HotelDeal" SET "status" = 'DRAFT' WHERE "id" = '${live.id}'`)).rejects.toThrow(/HOTEL_DEAL_TRANSITION_NOT_ALLOWED/)
      expect((await row()).percentBp).toBe(2000)
      await api(maker).post(`${ROUTE}/${live.id}/suspend`, { reason: 'cleanup after the lock test' })
    })

    it('the database refuses a deal that starts live, a skipped approval and a bad shape, whatever wrote it', async () => {
      const base = { tenantId, hotelId, code: `DB${Date.now().toString(36)}${++n}`.toUpperCase(), name: 'DB', idempotencyKey: unique('db').padEnd(12, 'x'), createdById: makerId }
      const draft = (extra: Record<string, unknown>) => rawDeal({ ...base, code: `DB${Date.now().toString(36)}${++n}`.toUpperCase(), idempotencyKey: unique('db').padEnd(12, 'x'), kind: 'PERCENT_OFF', percentBp: 1000, ...extra })
      await expect(draft({ status: 'ACTIVE' })).rejects.toThrow(/HOTEL_DEAL_MUST_START_AS_DRAFT/)
      await expect(draft({ percentBp: 9500 })).rejects.toThrow(/HotelDeal_kind_check/)
      await expect(draft({ kind: 'FLASH_SALE' })).rejects.toThrow(/HotelDeal_kind_fields_check/)
      await expect(draft({ kind: 'FIXED_OFF', percentBp: null, amountMinor: 5n, currency: 'aed', amountScope: 'PER_NIGHT' })).rejects.toThrow(/HotelDeal_kind_check/)
      await expect(draft({ channels: ['GDS'] })).rejects.toThrow(/HotelDeal_shape_check/)
      await expect(draft({ sourceMarkets: ['india'] })).rejects.toThrow(/HotelDeal_shape_check/)
      await expect(draft({ fundingSource: 'PLATFORM' })).rejects.toThrow(/HotelDeal_shape_check/)
      await expect(draft({ minMarginBp: 0 })).rejects.toThrow(/HotelDeal_shape_check/)
      const ok = await draft({})
      await expect(prisma.$executeRawUnsafe(`UPDATE "HotelDeal" SET "status" = 'ACTIVE' WHERE "id" = '${ok.id}'`)).rejects.toThrow(/HOTEL_DEAL_TRANSITION_NOT_ALLOWED/)
      await expect(prisma.$executeRawUnsafe(`UPDATE "HotelDeal" SET "status" = 'PENDING_APPROVAL' WHERE "id" = '${ok.id}'`)).rejects.toThrow(/HotelDeal_lifecycle_check/)
      await expect(prisma.$executeRawUnsafe(`UPDATE "HotelDeal" SET "tenant_id" = '${otherTenantId}' WHERE "id" = '${ok.id}'`)).rejects.toThrow()
      await expect(prisma.hotelDealRatePlan.create({ data: { tenantId, dealId: ok.id, ratePlanId: otherHotelPlan } })).rejects.toThrow(/HOTEL_DEAL_PLAN_OTHER_HOTEL/)
      await expect(rawDeal({ ...base, code: `X${Date.now().toString(36)}`.toUpperCase(), idempotencyKey: unique('db').padEnd(12, 'x'), hotelId: otherTenantHotelId, kind: 'PERCENT_OFF', percentBp: 1000 })).rejects.toThrow()
      expect(await prisma.hotelDeal.count({ where: { id: ok.id } })).toBe(1)
    })
  })

  describe('pricing: search, recheck and the one evaluator', () => {
    it('an ACTIVE deal prices search and recheck identically, and stops when paused, resumed and suspended', async () => {
      const full = await priceOf(sellPlan)
      expect(full).toMatchObject({ total: FULL })
      expect(full?.promotion).toBeUndefined()
      const live = await goLive({ name: 'Twenty off', percentBp: 2000 })
      const discounted = await priceOf(sellPlan)
      expect(discounted).toMatchObject({ total: 120000, promotion: { name: 'Twenty off', kind: 'PERCENT_OFF' } })
      // Search and recheck agree on the price.
      const offer = (await offers()).find((rate) => rate.ratePlanId === sellPlan)!
      const recheck = await adapter.recheck({ offerId: offer.offerId, searchId: 's' }, { tenantId, userId: makerId, requestId: 'r' })
      expect(recheck).toMatchObject({ status: 'available', offer: { sellAmountMinor: 120000 } })
      // The NET plan is not in this deal's scope.
      expect(await priceOf(netPlan)).toMatchObject({ total: Math.round(40000 * 3 * 1.1) })
      // A live deal cannot be archived: it must be stopped first.
      expect(errorCode(await api(maker).post(`${ROUTE}/${live.id}/archive`, {}))).toBe('DEAL_TRANSITION_NOT_ALLOWED')
      await expectStatus(await api(maker).post(`${ROUTE}/${live.id}/pause`, { reason: 'Hold while we review' }), 200)
      expect(await priceOf(sellPlan)).toMatchObject({ total: FULL })
      // Recheck reprices through the same evaluator, so the base rate comes back and the caller sees the difference from the 120000 it was shown.
      expect(await adapter.recheck({ offerId: offer.offerId, searchId: 's' }, { tenantId, userId: makerId, requestId: 'r' })).toMatchObject({ status: 'available', offer: { sellAmountMinor: FULL } })
      await expectStatus(await api(maker).post(`${ROUTE}/${live.id}/resume`, { expectedVersion: 1 }), 200)
      expect(await priceOf(sellPlan)).toMatchObject({ total: 120000 })
      await expectStatus(await api(maker).post(`${ROUTE}/${live.id}/suspend`, { reason: 'Integrity check failed' }), 200)
      expect(await priceOf(sellPlan)).toMatchObject({ total: FULL })
      // A suspended deal needs a new version and a new approval: it cannot simply resume.
      expect((await api(maker).post(`${ROUTE}/${live.id}/resume`, {})).status).toBe(409)
    })

    it('discounts the supplier net of a NET plan and the markup follows it', async () => {
      const live = await goLive({ ratePlanIds: [netPlan], percentBp: 1000 })
      // 3 x 40000 net, 10% off = 36000 net per night, +10% markup = 39600 per night
      expect(await priceOf(netPlan)).toMatchObject({ total: 39600 * 3, promotion: { kind: 'PERCENT_OFF' } })
      await api(maker).post(`${ROUTE}/${live.id}/suspend`, { reason: 'cleanup after the net test' })
    })

    it('a sell floor and a maximum discount keep the base price rather than undercut the protection', async () => {
      const floor = await goLive({ ratePlanIds: [sellPlan], percentBp: 5000, minSellFloorMinor: '30000' })
      // 50% of 50000 = 25000 per night, below the floor of 30000: the deal does not apply
      expect(await priceOf(sellPlan)).toMatchObject({ total: FULL })
      await api(maker).post(`${ROUTE}/${floor.id}/suspend`, { reason: 'cleanup after the floor test' })
      const cap = await goLive({ ratePlanIds: [sellPlan], percentBp: 3000, maxDiscountBp: 2000 })
      expect(await priceOf(sellPlan)).toMatchObject({ total: FULL })
      await api(maker).post(`${ROUTE}/${cap.id}/suspend`, { reason: 'cleanup after the cap test' })
      const ok = await goLive({ ratePlanIds: [sellPlan], percentBp: 3000, maxDiscountBp: 3000, minSellFloorMinor: '35000' })
      expect(await priceOf(sellPlan)).toMatchObject({ total: 35000 * 3 })
      await api(maker).post(`${ROUTE}/${ok.id}/suspend`, { reason: 'cleanup after the guard test' })
    })

    it('a market-restricted deal reaches only buyers of that market; an unknown buyer never gets it', async () => {
      const live = await goLive({ ratePlanIds: [sellPlan], percentBp: 1000, sourceMarkets: ['IN'] })
      expect(await priceOf(sellPlan, agentUserId)).toMatchObject({ total: 135000, promotion: { kind: 'PERCENT_OFF' } })
      expect(await priceOf(sellPlan, plainAgentId)).toMatchObject({ total: FULL })
      expect(await priceOf(sellPlan)).toMatchObject({ total: FULL })
      await api(maker).post(`${ROUTE}/${live.id}/suspend`, { reason: 'cleanup after the market test' })
      const agency = await goLive({ ratePlanIds: [sellPlan], percentBp: 1000, agencyIds: [agencyId] })
      expect(await priceOf(sellPlan, agentUserId)).toMatchObject({ total: 135000 })
      expect(await priceOf(sellPlan, plainAgentId)).toMatchObject({ total: FULL })
      await api(maker).post(`${ROUTE}/${agency.id}/suspend`, { reason: 'cleanup after the agency test' })
    })

    it('a channel-restricted deal applies to the portal and never to an unknown or API channel', async () => {
      const portal = await goLive({ ratePlanIds: [sellPlan], percentBp: 1000, channels: ['PORTAL'] })
      expect(await priceOf(sellPlan)).toMatchObject({ total: 135000 })
      await api(maker).post(`${ROUTE}/${portal.id}/suspend`, { reason: 'cleanup after the portal test' })
      const apiOnly = await goLive({ ratePlanIds: [sellPlan], percentBp: 1000, channels: ['API'] })
      expect(await priceOf(sellPlan)).toMatchObject({ total: FULL })
      await api(maker).post(`${ROUTE}/${apiOnly.id}/suspend`, { reason: 'cleanup after the api test' })
    })

    it('Stay X pay Y, subsequent nights, every Nth free and fixed amounts price through search', async () => {
      const kinds: Array<[Record<string, unknown>, number]> = [
        [{ kind: 'STAY_X_PAY_Y', percentBp: undefined, minNights: 3, freeNights: 1 }, 100000],
        [{ kind: 'SUBSEQUENT_NIGHTS', percentBp: 2000, fromNight: 2 }, 50000 + 40000 * 2],
        [{ kind: 'EVERY_NTH_FREE', percentBp: undefined, minNights: 3 }, 100000],
        [{ kind: 'FIXED_OFF', percentBp: undefined, amountMinor: '5000', currency: 'AED', amountScope: 'PER_NIGHT' }, 135000],
        [{ kind: 'FIXED_OFF', percentBp: undefined, amountMinor: '9000', currency: 'AED', amountScope: 'PER_STAY' }, 141000],
        [{ kind: 'PERCENT_OFF', percentBp: 1000, weekdays: [0, 1, 2, 3, 4, 5, 6].filter((day) => day !== (new Date(`${nights[0]}T00:00:00Z`).getUTCDay() + 6) % 7) }, 150000 - 5000 * 2],
      ]
      for (const [terms, expected] of kinds) {
        const live = await goLive({ ratePlanIds: [sellPlan], ...terms })
        expect({ kind: terms.kind, total: (await priceOf(sellPlan))?.total }).toEqual({ kind: terms.kind, total: expected })
        await api(maker).post(`${ROUTE}/${live.id}/suspend`, { reason: 'cleanup after the kind test' })
      }
    })

    it('a deal in the wrong currency never applies, and a plan outside the scope is untouched', async () => {
      const live = await goLive({ ratePlanIds: [sellPlan], kind: 'FIXED_OFF', percentBp: undefined, amountMinor: '5000', currency: 'AED', amountScope: 'PER_NIGHT' })
      expect(await priceOf(netPlan)).toMatchObject({ total: 132000 })
      await api(maker).post(`${ROUTE}/${live.id}/suspend`, { reason: 'cleanup after the scope test' })
    })

    it('an expired or not-yet-started deal in the database never prices a stay, whatever its stored label says', async () => {
      const insert = async (activeFrom: string | null, activeTo: string | null, status: 'ACTIVE' | 'SCHEDULED') => {
        const deal = await rawDeal({ tenantId, hotelId, code: `WIN${Date.now().toString(36)}${++n}`.toUpperCase(), name: 'Window', idempotencyKey: unique('win').padEnd(12, 'x'), createdById: makerId, kind: 'PERCENT_OFF', percentBp: 4000, activeFrom: activeFrom ? new Date(activeFrom) : null, activeTo: activeTo ? new Date(activeTo) : null })
        await prisma.hotelDealRatePlan.create({ data: { tenantId, dealId: deal.id, ratePlanId: sellPlan } })
        const fp = 'a'.repeat(64)
        await prisma.hotelDeal.update({ where: { id: deal.id }, data: { status: 'PENDING_APPROVAL', termsFingerprint: fp, approvalId: 'appr' } })
        await prisma.hotelDeal.update({ where: { id: deal.id }, data: { status: 'APPROVED' } })
        await prisma.hotelDeal.update({ where: { id: deal.id }, data: { status, activatedAt: new Date(), activatedById: makerId } })
        return deal.id
      }
      const expired = await insert(hotelDay(-30), hotelDay(-1), 'ACTIVE')
      expect(await priceOf(sellPlan)).toMatchObject({ total: FULL })
      const future = await insert(hotelDay(5), null, 'SCHEDULED')
      expect(await priceOf(sellPlan)).toMatchObject({ total: FULL })
      const startedButLabelledScheduled = await insert(hotelDay(-1), null, 'SCHEDULED')
      expect(await priceOf(sellPlan)).toMatchObject({ total: 90000 })
      // A SCHEDULED row with no start date is malformed data: the control fails closed instead of guessing.
      await prisma.hotelDeal.update({ where: { id: startedButLabelledScheduled }, data: { status: 'SUSPENDED', statusReason: 'test cleanup' } })
      for (const id of [expired, future]) await prisma.hotelDeal.update({ where: { id }, data: { status: 'SUSPENDED', statusReason: 'test cleanup' } }).catch(() => undefined)
      expect(await priceOf(sellPlan)).toMatchObject({ total: FULL })
    })

    it('reconciles stored labels with the hotel calendar, idempotently, and audits each change', async () => {
      const startedLabelledScheduled = await rawDeal({ tenantId, hotelId, code: `REC${Date.now().toString(36)}${++n}`.toUpperCase(), name: 'Rec', idempotencyKey: unique('rec').padEnd(12, 'x'), createdById: makerId, kind: 'PERCENT_OFF', percentBp: 1000, activeFrom: new Date(hotelDay(-2)) })
      const endedLabelledActive = await rawDeal({ tenantId, hotelId, code: `REC${Date.now().toString(36)}${++n}`.toUpperCase(), name: 'Rec2', idempotencyKey: unique('rec').padEnd(12, 'x'), createdById: makerId, kind: 'PERCENT_OFF', percentBp: 1000, activeTo: new Date(hotelDay(-1)) })
      for (const [id, status] of [[startedLabelledScheduled.id, 'SCHEDULED'], [endedLabelledActive.id, 'ACTIVE']] as const) {
        await prisma.hotelDealRatePlan.create({ data: { tenantId, dealId: id, ratePlanId: sellPlan } })
        await prisma.hotelDeal.update({ where: { id }, data: { status: 'PENDING_APPROVAL', termsFingerprint: 'b'.repeat(64), approvalId: 'appr' } })
        await prisma.hotelDeal.update({ where: { id }, data: { status: 'APPROVED' } })
        await prisma.hotelDeal.update({ where: { id }, data: { status, activatedAt: new Date(), activatedById: makerId } })
      }
      const list = (await api(reader).get(`${ROUTE}?status=EXPIRED`)).body.data
      expect(list.items.map((d: { id: string }) => d.id)).toContain(endedLabelledActive.id)
      const first = (await expectStatus(await api(maker).post(`${ROUTE}/reconcile`), 200)).body.data
      expect(first.ids.activated).toContain(startedLabelledScheduled.id)
      expect(first.ids.expired).toContain(endedLabelledActive.id)
      const second = (await api(maker).post(`${ROUTE}/reconcile`)).body.data
      expect(second.ids.activated).not.toContain(startedLabelledScheduled.id)
      expect(second.ids.expired).not.toContain(endedLabelledActive.id)
      expect((await prisma.hotelDeal.findFirst({ where: { id: startedLabelledScheduled.id, tenantId } }))?.status).toBe('ACTIVE')
      expect((await prisma.hotelDeal.findFirst({ where: { id: endedLabelledActive.id, tenantId } }))?.status).toBe('EXPIRED')
      expect(await prisma.auditEvent.count({ where: { tenantId, entityId: endedLabelledActive.id, action: 'promotion.deal.expired' } })).toBe(1)
      await prisma.hotelDeal.update({ where: { id: startedLabelledScheduled.id }, data: { status: 'SUSPENDED', statusReason: 'test cleanup' } })
    })

    it('a deal activated for a future start is SCHEDULED and prices nothing until its day', async () => {
      const live = await goLive({ activeFrom: hotelDay(3), ratePlanIds: [sellPlan] })
      expect(live.live).toMatchObject({ status: 'SCHEDULED', effectiveStatus: 'SCHEDULED', activeFrom: hotelDay(3) })
      expect(await priceOf(sellPlan)).toMatchObject({ total: FULL })
      await api(maker).post(`${ROUTE}/${live.id}/suspend`, { reason: 'cleanup after the schedule test' })
    })

    it('the same deal cannot be applied twice to one plan, and a combinable pair stacks through search', async () => {
      const a = await goLive({ ratePlanIds: [sellPlan], percentBp: 1000, combinable: true, code: `STKA${Date.now().toString(36)}`.toUpperCase() })
      const b = await goLive({ ratePlanIds: [sellPlan], percentBp: 1000, combinable: true, code: `STKB${Date.now().toString(36)}`.toUpperCase() })
      expect(await priceOf(sellPlan)).toMatchObject({ total: Math.round(150000 * 0.9 * 0.9) })
      await api(maker).post(`${ROUTE}/${b.id}/suspend`, { reason: 'cleanup after the stack test' })
      await api(maker).post(`${ROUTE}/${a.id}/suspend`, { reason: 'cleanup after the stack test' })
    })
  })

  describe('read-only simulator', () => {
    it('prices a stay with and without the deal, writes nothing, and says why a deal did not apply', async () => {
      const deal = await create({ ratePlanIds: [sellPlan, netPlan], percentBp: 2000 })
      const counts = async () => ({ rates: await prisma.dailyRate.count({ where: { tenantId } }), avail: await prisma.dailyAvailability.count({ where: { tenantId } }), deals: await prisma.hotelDeal.count({ where: { tenantId } }), audit: await prisma.auditEvent.count({ where: { tenantId, action: { not: 'tenant.context.selected' } } }), holds: await prisma.inventoryHold.count({ where: { tenantId } }), version: (await prisma.hotelDeal.findFirstOrThrow({ where: { id: deal.id, tenantId } })).updatedAt.toISOString() })
      const before = await counts()
      const stay = { checkIn, nights: 3, adults: 2 }
      const sell = (await expectStatus(await api(reader).post(`${ROUTE}/${deal.id}/preview`, { ratePlanId: sellPlan, ...stay }), 200)).body.data
      expect(sell).toMatchObject({ eligible: true, writes: 'none', dealApplied: true, withoutDeal: { sellMinor: '150000' }, withDeal: { sellMinor: '120000' }, savingSellMinor: '30000', marginWithBp: null })
      expect(sell.nights).toHaveLength(3)
      expect(sell.nights[0]).toMatchObject({ baseNetMinor: '50000', promotionMinor: '10000', netMinor: '40000', sellMinor: '40000' })
      const net = (await api(reader).post(`${ROUTE}/${deal.id}/preview`, { ratePlanId: netPlan, ...stay })).body.data
      expect(net).toMatchObject({ eligible: true, dealApplied: true, withoutDeal: { netMinor: '120000', sellMinor: '132000' }, withDeal: { netMinor: '96000', sellMinor: '105600' }, savingSellMinor: '26400', marginWithoutBp: 909, marginWithBp: 909 })
      expect(net.nights[0]).toMatchObject({ baseNetMinor: '40000', promotionMinor: '8000', netMinor: '32000', markupMinor: '3200', sellMinor: '35200' })
      expect(net.trace).toEqual([expect.objectContaining({ id: deal.id, outcome: 'APPLIED' })])
      expect(await counts()).toEqual(before)
      // The same preview for a market the deal does not serve says so instead of inventing a discount.
      const restricted = await create({ sourceMarkets: ['GB'], ratePlanIds: [sellPlan] })
      const none = (await api(reader).post(`${ROUTE}/${restricted.id}/preview`, { ratePlanId: sellPlan, ...stay, market: 'IN' })).body.data
      expect(none).toMatchObject({ eligible: true, dealApplied: false, savingSellMinor: '0' })
      expect(none.trace.find((entry: { id: string }) => entry.id === restricted.id)).toMatchObject({ outcome: 'NOT_ELIGIBLE' })
      const served = (await api(reader).post(`${ROUTE}/${restricted.id}/preview`, { ratePlanId: sellPlan, ...stay, market: 'GB' })).body.data
      expect(served).toMatchObject({ dealApplied: true })
    })

    it('shows the guard that stopped a deal, never a base rate that cannot be sold, and refuses bad input and foreign plans', async () => {
      const guarded = await create({ ratePlanIds: [sellPlan], percentBp: 5000, minSellFloorMinor: '30000' })
      const out = (await api(reader).post(`${ROUTE}/${guarded.id}/preview`, { ratePlanId: sellPlan, checkIn, nights: 3, adults: 2 })).body.data
      expect(out).toMatchObject({ dealApplied: false, savingSellMinor: '0' })
      expect(out.trace.find((entry: { id: string }) => entry.id === guarded.id)).toMatchObject({ outcome: 'GUARD_BREACHED', guard: 'SELL_FLOOR_BREACHED' })
      const noRates = (await api(reader).post(`${ROUTE}/${guarded.id}/preview`, { ratePlanId: sellPlan, checkIn: hotelDay(200), nights: 2, adults: 2 })).body.data
      expect(noRates).toMatchObject({ eligible: false, nights: [], withDeal: null, savingSellMinor: null })
      expect(noRates.reasons).toContain('DAILY_RATE_MISSING_OR_INVALID')
      expect((await api(reader).post(`${ROUTE}/${guarded.id}/preview`, { ratePlanId: sellPlan, checkIn: 'x', nights: 0 })).status).toBe(400)
      expect(errorCode(await api(reader).post(`${ROUTE}/${guarded.id}/preview`, { ratePlanId: otherHotelPlan, checkIn, nights: 3 }))).toBe('PLAN_NOT_IN_DEAL')
      expect((await api(reader).post(`${ROUTE}/${guarded.id}/preview`, { ratePlanId: sellPlan, checkIn, nights: 3, channel: 'GDS' })).status).toBe(400)
    })
  })

  describe('tenant isolation', () => {
    it('another tenant cannot see, read, edit, validate, preview, submit, approve, pause or audit a deal, and learns nothing from the answer', async () => {
      const deal = await create()
      const sub = (await api(maker).post(`${ROUTE}/${deal.id}/submit`, { expectedVersion: 1, requestId: unique('req').padEnd(12, 'x'), reason: 'Please review' })).body.data
      const foreign = api(outsider, otherTenantId)
      // A deal of another tenant must answer exactly like a deal that does not exist; an approval of another tenant exactly like an approval that does not exist.
      const missingDeal = await foreign.get(`${ROUTE}/does-not-exist`)
      const missingApproval = await foreign.post(`${ROUTE}/approvals/does-not-exist/approve`, { reason: 'because' })
      const same = (r: request.Response, baseline: request.Response) => expect([r.status, errorCode(r)]).toEqual([baseline.status, errorCode(baseline)])
      for (const call of [
        () => foreign.get(`${ROUTE}/${deal.id}`), () => foreign.put(`${ROUTE}/${deal.id}`, { ...body(), expectedVersion: 1 }), () => foreign.post(`${ROUTE}/${deal.id}/validate`),
        () => foreign.post(`${ROUTE}/${deal.id}/preview`, { ratePlanId: sellPlan, checkIn, nights: 3 }), () => foreign.post(`${ROUTE}/${deal.id}/submit`, { expectedVersion: 1, requestId: 'abcdefgh12', reason: 'because' }),
        () => foreign.post(`${ROUTE}/${deal.id}/pause`, { reason: 'because' }), () => foreign.post(`${ROUTE}/${deal.id}/suspend`, { reason: 'because' }), () => foreign.post(`${ROUTE}/${deal.id}/withdraw`),
        () => foreign.get(`${ROUTE}/${deal.id}/audit-log`), () => foreign.get(`${ROUTE}/${deal.id}/performance`),
      ]) same(await call(), missingDeal)
      for (const verb of ['approve', 'reject', 'execute'] as const) {
        const body = verb === 'execute' ? {} : { reason: 'because' }
        same(await foreign.post(`${ROUTE}/approvals/${sub.approval.id}/${verb}`, body), await foreign.post(`${ROUTE}/approvals/does-not-exist/${verb}`, body))
      }
      expect(missingApproval.status).toBe(404)
      expect((await foreign.get(ROUTE)).body.data.items).toEqual([])
      expect((await foreign.get(`${ROUTE}/summary`)).body.data.total).toBe(0)
      expect((await foreign.get(`${ROUTE}/approval-queue`)).body.data).toEqual([])
      expect((await prisma.hotelDeal.findFirstOrThrow({ where: { id: deal.id, tenantId } })).status).toBe('PENDING_APPROVAL')
      expect((await prisma.approvalRequest.findFirstOrThrow({ where: { id: sub.approval.id } })).status).toBe('PENDING')
    })

    it('cannot create into, or reach plans, hotels and agencies of, another tenant', async () => {
      const foreign = api(outsider, otherTenantId)
      const r = await foreign.post(ROUTE, body({ hotelId, ratePlanIds: [sellPlan] }))
      expect(r.status).toBe(404)
      expect(errorCode(r)).toBe('HOTEL_NOT_FOUND')
      const own = await foreign.post(ROUTE, body({ hotelId: otherTenantHotelId, ratePlanIds: [sellPlan] }))
      expect([own.status, errorCode(own)]).toEqual([400, 'DEAL_PLAN_NOT_IN_HOTEL'])
      expect(await prisma.hotelDeal.count({ where: { tenantId: otherTenantId } })).toBe(0)
    })

    it('a caller cannot choose a tenant they do not belong to', async () => {
      const r = await api(outsider, tenantId).get(ROUTE)
      expect(r.status).toBeGreaterThanOrEqual(400)
      expect(JSON.stringify(r.body)).not.toContain(suffix)
      const create = await api(outsider, tenantId).post(ROUTE, body())
      expect(create.status).toBeGreaterThanOrEqual(400)
    })

    it('forced row-level security hides another tenant\'s deals from a restricted role even without an application filter', async () => {
      const deal = await create()
      const role = `deal_probe_${Date.now().toString(36)}`
      await prisma.$executeRawUnsafe(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB`)
      await prisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO "${role}"`)
      await prisma.$executeRawUnsafe(`GRANT SELECT ON "HotelDeal", "HotelDealRatePlan" TO "${role}"`)
      await prisma.$executeRawUnsafe(`GRANT EXECUTE ON FUNCTION "fbeds_current_tenant_id"() TO "${role}"`)
      const url = new URL(process.env.DATABASE_URL!)
      url.username = role; url.password = ''
      const probe = new PrismaClient({ datasourceUrl: url.toString() })
      try {
        const visibleTo = async (tenant: string | null) => probe.$transaction(async (tx) => {
          if (tenant) await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenant}, true)`
          return tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "HotelDeal" WHERE id = ${deal.id}`
        })
        expect(await visibleTo(otherTenantId)).toEqual([])
        expect(await visibleTo(null)).toEqual([])
        expect(await visibleTo(tenantId)).toEqual([{ id: deal.id }])
        await expect(probe.$transaction(async (tx) => { await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${otherTenantId}, true)`; return tx.$executeRawUnsafe(`INSERT INTO "HotelDeal" ("id") VALUES ('x')`) })).rejects.toThrow()
      } finally {
        await probe.$disconnect()
        await prisma.$executeRawUnsafe(`REVOKE ALL ON "HotelDeal", "HotelDealRatePlan" FROM "${role}"`)
        await prisma.$executeRawUnsafe(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM "${role}"`)
        await prisma.$executeRawUnsafe(`REVOKE USAGE ON SCHEMA public FROM "${role}"`)
        await prisma.$executeRawUnsafe(`DROP ROLE "${role}"`)
      }
      const rls = await prisma.$queryRaw<Array<{ relforcerowsecurity: boolean; relname: string }>>`SELECT relname, relforcerowsecurity FROM pg_class WHERE relname IN ('HotelDeal', 'HotelDealRatePlan') ORDER BY relname`
      expect(rls).toEqual([{ relname: 'HotelDeal', relforcerowsecurity: true }, { relname: 'HotelDealRatePlan', relforcerowsecurity: true }])
    })
  })

  describe('concurrency and idempotency', () => {
    it('two simultaneous executions of one approval activate the deal exactly once', async () => {
      const draft = await create()
      const sub = (await api(maker).post(`${ROUTE}/${draft.id}/submit`, { expectedVersion: 1, requestId: unique('req').padEnd(12, 'x'), reason: 'Please review' })).body.data
      await expectStatus(await api(checker).post(`${ROUTE}/approvals/${sub.approval.id}/approve`, { reason: 'Checked and fine' }), 200)
      const results = await Promise.all([api(maker).post(`${ROUTE}/approvals/${sub.approval.id}/execute`), api(checker).post(`${ROUTE}/approvals/${sub.approval.id}/execute`), api(maker).post(`${ROUTE}/approvals/${sub.approval.id}/execute`)])
      expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409])
      expect(await prisma.auditEvent.count({ where: { tenantId, entityId: draft.id, action: 'promotion.deal.activated' } })).toBe(1)
      await api(maker).post(`${ROUTE}/${draft.id}/suspend`, { reason: 'cleanup after the race test' })
    })

    it('two simultaneous edits of one version let one win and the other conflict', async () => {
      const draft = await create()
      const edit = (name: string) => api(maker).put(`${ROUTE}/${draft.id}`, { ...body({ code: draft.code, name }), idempotencyKey: undefined, hotelId: undefined, expectedVersion: 1 })
      const results = await Promise.all([edit('First'), edit('Second')])
      expect(results.map((r) => r.status).sort()).toEqual([200, 409])
      expect((await prisma.hotelDeal.findFirstOrThrow({ where: { id: draft.id, tenantId } })).version).toBe(2)
    })

    it('a repeated submit with the same request id is one approval request and one transition', async () => {
      const draft = await create()
      const payload = { expectedVersion: 1, requestId: unique('req').padEnd(12, 'x'), reason: 'Please review' }
      const first = await expectStatus(await api(maker).post(`${ROUTE}/${draft.id}/submit`, payload), 200)
      const second = await api(maker).post(`${ROUTE}/${draft.id}/submit`, payload)
      expect(second.status).toBe(409)
      expect(await prisma.approvalRequest.count({ where: { tenantId, entityId: draft.id } })).toBe(1)
      expect(first.body.data.approval.id).toBeTruthy()
      expect(await prisma.auditEvent.count({ where: { tenantId, entityId: draft.id, action: 'promotion.deal.submitted' } })).toBe(1)
    })

    it('stopping sales is idempotent: pausing a paused deal changes nothing', async () => {
      const live = await goLive()
      await expectStatus(await api(maker).post(`${ROUTE}/${live.id}/pause`, { reason: 'First pause here' }), 200)
      await expectStatus(await api(maker).post(`${ROUTE}/${live.id}/pause`, { reason: 'Second pause here' }), 200)
      expect(await prisma.auditEvent.count({ where: { tenantId, entityId: live.id, action: 'promotion.deal.paused' } })).toBe(1)
      expect(errorCode(await api(maker).post(`${ROUTE}/${live.id}/pause`, {}))).toBe('DEAL_REASON_REQUIRED')
      await api(maker).post(`${ROUTE}/${live.id}/suspend`, { reason: 'cleanup after the pause test' })
    })
  })

  describe('lists, queue, summary and operations', () => {
    it('lists with filters and pagination, counts by what applies today, and shows the approval queue to a second person', async () => {
      const draft = await create({ name: 'Queued deal for review' })
      await api(maker).post(`${ROUTE}/${draft.id}/submit`, { expectedVersion: 1, requestId: unique('req').padEnd(12, 'x'), reason: 'Please review' })
      const list = (await api(reader).get(`${ROUTE}?hotelId=${hotelId}&status=PENDING_APPROVAL&q=queued&pageSize=5`)).body.data
      expect(list.items.map((d: { id: string }) => d.id)).toContain(draft.id)
      expect(list.items.every((d: { effectiveStatus: string }) => d.effectiveStatus === 'PENDING_APPROVAL')).toBe(true)
      expect((await api(reader).get(`${ROUTE}?status=NOPE`)).status).toBe(400)
      expect((await api(reader).get(`${ROUTE}?q=%25`)).body.data.items).toEqual([])
      const summary = (await api(reader).get(`${ROUTE}/summary?hotelId=${hotelId}`)).body.data
      expect(summary.byStatus.PENDING_APPROVAL).toBeGreaterThan(0)
      expect(summary.total).toBe(Object.values(summary.byStatus as Record<string, number>).reduce((a, b) => a + b, 0))
      const queue = (await api(checker).get(`${ROUTE}/approval-queue`)).body.data
      const item = queue.find((q: { deal: { id: string } }) => q.deal.id === draft.id)
      expect(item).toMatchObject({ ratePlanCount: 1, summary: '20% off every eligible night', approval: { canDecide: true } })
      expect(item.validation.some((issue: { severity: string }) => issue.severity === 'ERROR')).toBe(false)
      const own = (await api(maker).get(`${ROUTE}/approval-queue`)).body.data.find((q: { deal: { id: string } }) => q.deal.id === draft.id)
      expect(own.approval).toMatchObject({ canDecide: false, canCancel: true })
    })

    it('reports performance honestly: redemptions are unavailable and the API channel is not published', async () => {
      const live = await goLive()
      const perf = (await api(reader).get(`${ROUTE}/${live.id}/performance`)).body.data
      expect(perf.redemptions).toMatchObject({ available: false })
      expect(perf.channels).toEqual([expect.objectContaining({ channel: 'PORTAL', published: true }), expect.objectContaining({ channel: 'API', published: false })])
      expect(perf.activation.activatedAt).toBeTruthy()
      await api(maker).post(`${ROUTE}/${live.id}/suspend`, { reason: 'cleanup after the performance test' })
    })

    it('resuming re-validates: a deal whose plan is no longer active cannot be resumed', async () => {
      const lonely = await prisma.ratePlan.create({ data: { tenantId, contractId, roomTypeId: roomId, boardBasisId: boardId, code: `${suffix}-lonely`, status: 'ACTIVE', occupancy: 2, currency: 'AED' } })
      const live = await goLive({ ratePlanIds: [lonely.id] })
      await expectStatus(await api(maker).post(`${ROUTE}/${live.id}/pause`, { reason: 'Hold for a check' }), 200)
      await prisma.ratePlan.update({ where: { id: lonely.id }, data: { status: 'SUSPENDED' } })
      const resume = await api(maker).post(`${ROUTE}/${live.id}/resume`, {})
      expect([resume.status, errorCode(resume)]).toEqual([409, 'DEAL_VALIDATION_FAILED'])
      expect((await prisma.hotelDeal.findFirstOrThrow({ where: { id: live.id, tenantId } })).status).toBe('PAUSED')
      await api(maker).post(`${ROUTE}/${live.id}/suspend`, { reason: 'cleanup after the resume test' })
    })

    it('activation refuses a deal whose window has ended and releases the approval for another try', async () => {
      const draft = await create({ activeTo: hotelDay(0) })
      const sub = (await api(maker).post(`${ROUTE}/${draft.id}/submit`, { expectedVersion: 1, requestId: unique('req').padEnd(12, 'x'), reason: 'Please review' })).body.data
      await api(checker).post(`${ROUTE}/approvals/${sub.approval.id}/approve`, { reason: 'Checked and fine' })
      const tomorrow = new Date(Date.now() + 2 * DAY)
      deals.now = () => tomorrow
      try {
        const r = await api(maker).post(`${ROUTE}/approvals/${sub.approval.id}/execute`)
        expect([r.status, errorCode(r)]).toEqual([409, 'DEAL_VALIDATION_FAILED'])
      } finally { deals.now = () => new Date() }
      expect((await prisma.approvalRequest.findFirstOrThrow({ where: { id: sub.approval.id } })).status).toBe('APPROVED')
      expect((await prisma.hotelDeal.findFirstOrThrow({ where: { id: draft.id, tenantId } })).status).toBe('APPROVED')
    })

    it('a deal with a changed scope cannot be activated on an old approval: the approval is bound to the terms and the version', async () => {
      const draft = await create()
      const sub = (await api(maker).post(`${ROUTE}/${draft.id}/submit`, { expectedVersion: 1, requestId: unique('req').padEnd(12, 'x'), reason: 'Please review' })).body.data
      await api(checker).post(`${ROUTE}/approvals/${sub.approval.id}/approve`, { reason: 'Checked and fine' })
      // The only way to change terms is to return to draft; the old approval can then never activate the new version.
      await expectStatus(await api(maker).post(`${ROUTE}/${draft.id}/return-to-draft`, { expectedVersion: 1 }), 200)
      await expectStatus(await api(maker).put(`${ROUTE}/${draft.id}`, { ...body({ code: draft.code, percentBp: 4000, minSellFloorMinor: '1000' }), idempotencyKey: undefined, hotelId: undefined, expectedVersion: 2 }), 200)
      const r = await api(maker).post(`${ROUTE}/approvals/${sub.approval.id}/execute`)
      expect([r.status, errorCode(r)]).toEqual([409, 'DEAL_NOT_AWAITING_ACTIVATION'])
      expect((await prisma.hotelDeal.findFirstOrThrow({ where: { id: draft.id, tenantId } })).status).toBe('DRAFT')
      expect(await priceOf(sellPlan)).toMatchObject({ total: FULL })
    })
  })
})
