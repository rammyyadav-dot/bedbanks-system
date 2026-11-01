import { randomBytes } from 'crypto'
import { INestApplication, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { PrismaClient } from '@prisma/client'
import * as cookieParser from 'cookie-parser'
import * as request from 'supertest'
import { AppModule } from '../src/app.module'
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter'
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor'
import { hashPassword } from '../src/auth/utils/password'
import { API_RUNTIME_GROUP_ROLE, API_RUNTIME_LOGIN_ROLE, provisionApiRuntimeRole, verifyApiRuntimeRole } from '../src/database/api-runtime-role'

const ownerUrl = process.env.DATABASE_URL
if (!ownerUrl) throw new Error('DATABASE_URL (the disposable owner connection) is required')

/**
 * ADR 0089 on the strict API runtime role (ADR 0031, ADR 0032). The whole HTTP application runs as the provisioned, non-superuser, non-BYPASSRLS login.
 * Hotel deals are authored, approved, activated and priced by search with only the grants the runtime contract lists; the legacy per-plan promotion editor,
 * which the contract leaves a privileged path, is refused; and a deal control that cannot be read stops search instead of selling at an unchecked price.
 */
describe('strict runtime role: hotel deals (PostgreSQL)', () => {
  const owner = new PrismaClient({ datasourceUrl: ownerUrl })
  const suffix = `sd-${Date.now()}-${randomBytes(3).toString('hex')}`
  const password = 'strict-deal-password'
  const runtimePassword = randomBytes(24).toString('hex')
  const origin = 'http://localhost:3001'
  const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)
  const ROUTE = '/admin/commercial/promotions'
  let app: INestApplication; let previousUrl: string | undefined
  let tenantA = '', tenantB = '', hotelId = '', planId = '', agencyUserId = ''
  const userIds: string[] = []; const cookies: Record<string, string> = {}

  async function user(label: string, tenantId: string, keys: string[]) {
    const u = await owner.user.create({ data: { email: `${suffix}-${label}@example.test`, name: label, passwordHash: await hashPassword(password), status: 'ACTIVE' } }); userIds.push(u.id)
    await owner.membership.create({ data: { tenantId, userId: u.id, role: 'agent' } })
    const r = await owner.role.create({ data: { tenantId, name: `${suffix}-${label}` } })
    for (const key of keys) { const p = await owner.permission.upsert({ where: { key }, update: {}, create: { key, description: key } }); await owner.rolePermission.create({ data: { roleId: r.id, permissionId: p.id } }) }
    await owner.userRole.create({ data: { tenantId, userId: u.id, roleId: r.id } })
    return u.id
  }
  const call = (method: 'get' | 'post' | 'put', path: string, who: string, body?: object) => {
    const r = request(app.getHttpServer())[method](`/api/v1${path}`).set('Origin', origin).set('Cookie', cookies[who])
    return body ? r.send(body) : r
  }
  const search = (who: string) => call('post', '/agent/search', who, { destination: 'Dubai', checkIn: day(20), checkOut: day(22), rooms: 1, adults: 2, children: 0, childAges: [], nationality: 'IN', currency: 'AED', limit: 100 })
  type Rate = { ratePlanId: string; sellAmountMinor: number; promotion?: { name: string; kind: string } }
  const rateOf = (body: { data: { hotels: Array<{ rooms: Array<{ rates: Rate[] }> }> } }): Rate | undefined => body.data.hotels.flatMap((h) => h.rooms.flatMap((r) => r.rates)).find((rate) => rate.ratePlanId === planId)
  const key = (label: string) => `${suffix}-${label}`.padEnd(14, 'x')
  const body = (over: Record<string, unknown> = {}) => ({ hotelId, idempotencyKey: key(`k${Math.random().toString(36).slice(2, 8)}`), code: `SD${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`.toUpperCase(), name: 'Strict deal', kind: 'PERCENT_OFF', percentBp: 2000, ratePlanIds: [planId], ...over })

  beforeAll(async () => {
    await owner.$connect()
    tenantA = (await owner.tenant.create({ data: { name: `${suffix}a`, slug: `${suffix}a` } })).id
    tenantB = (await owner.tenant.create({ data: { name: `${suffix}b`, slug: `${suffix}b` } })).id
    const supplierId = (await owner.supplier.create({ data: { tenantId: tenantA, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: suffix, displayName: 'S', countryCode: 'AE', defaultCurrency: 'AED' } })).id
    const boardId = (await owner.boardBasis.create({ data: { tenantId: tenantA, code: 'BB', name: 'B&B' } })).id
    hotelId = (await owner.hotel.create({ data: { tenantId: tenantA, name: `${suffix} hotel`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', contentStatus: 'COMPLETE', starRating: 5 } })).id
    const roomId = (await owner.roomType.create({ data: { hotelId, name: 'Deluxe', code: suffix, maxAdults: 2, maxOccupancy: 2 } })).id
    const mapping = await owner.supplierHotelMapping.create({ data: { tenantId: tenantA, supplierId, hotelId, supplierHotelId: `${suffix}-h`, status: 'MAPPED' } })
    await owner.supplierRoomMapping.create({ data: { tenantId: tenantA, supplierHotelMappingId: mapping.id, hotelId, supplierRoomId: `${suffix}-r`, roomTypeId: roomId, status: 'MAPPED' } })
    const contractId = (await owner.contract.create({ data: { tenantId: tenantA, supplierId, supplierHotelMappingId: mapping.id, code: suffix, status: 'ACTIVE', validFrom: new Date('2026-01-01'), validTo: new Date('2099-12-31'), settlementCurrency: 'AED' } as never })).id
    planId = (await owner.ratePlan.create({ data: { tenantId: tenantA, contractId, roomTypeId: roomId, boardBasisId: boardId, code: 'P1', status: 'ACTIVE', occupancy: 2, currency: 'AED' } })).id
    const nights = [day(20), day(21)].map((d) => new Date(d))
    await owner.dailyRate.createMany({ data: nights.map((stayDate) => ({ tenantId: tenantA, ratePlanId: planId, stayDate, occupancy: 2, amountMinor: 50_000n, currency: 'AED', amountBasis: 'SELL' as const })) })
    await owner.dailyAvailability.createMany({ data: nights.map((stayDate) => ({ tenantId: tenantA, ratePlanId: planId, stayDate, allotment: 9 })) })
    const admin = ['supply.hotels.read', 'supply.hotels.manage', 'supply.rates.read', 'supply.rates.manage']
    const maker = await user('maker', tenantA, admin); await user('checker', tenantA, admin); await user('reader', tenantA, ['supply.rates.read'])
    agencyUserId = await user('agent', tenantA, ['hotel.search'])
    const agencyId = (await owner.agency.create({ data: { tenantId: tenantA, code: `AG-${suffix.slice(-6).toUpperCase()}`, name: 'Agency', countryCode: 'IN', createdById: maker } })).id
    await owner.agencyMember.create({ data: { tenantId: tenantA, agencyId, userId: agencyUserId } })
    await user('outsider', tenantB, admin)

    await provisionApiRuntimeRole(owner, { password: runtimePassword })
    previousUrl = process.env.DATABASE_URL
    const u = new URL(ownerUrl!); u.username = API_RUNTIME_LOGIN_ROLE; u.password = runtimePassword
    process.env.DATABASE_URL = u.toString(); process.env.ADMIN_ORIGIN = origin
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication()
    app.use(cookieParser()); app.setGlobalPrefix('api/v1')
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
    app.useGlobalFilters(new HttpExceptionFilter()); app.useGlobalInterceptors(new ResponseInterceptor())
    await app.init()
    for (const label of ['maker', 'checker', 'reader', 'agent', 'outsider']) {
      const r = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', origin).send({ email: `${suffix}-${label}@example.test`, password }).expect(200)
      cookies[label] = (r.headers['set-cookie'][0] as string).split(';')[0]
    }
  }, 180_000)

  afterAll(async () => {
    await app?.close()
    if (previousUrl) process.env.DATABASE_URL = previousUrl
    await owner.$executeRawUnsafe(`GRANT SELECT ON "HotelDeal", "HotelDealRatePlan" TO ${API_RUNTIME_GROUP_ROLE}`).catch(() => undefined)
    await owner.$executeRawUnsafe('ALTER TABLE "HotelDealRatePlan" DISABLE TRIGGER "HotelDealRatePlan_guard"')
    try { await owner.hotelDealRatePlan.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } }) } finally { await owner.$executeRawUnsafe('ALTER TABLE "HotelDealRatePlan" ENABLE TRIGGER "HotelDealRatePlan_guard"') }
    for (const t of [tenantA, tenantB].filter(Boolean)) {
      await owner.hotelDeal.deleteMany({ where: { tenantId: t } }); await owner.approvalRequest.deleteMany({ where: { tenantId: t } }); await owner.auditEvent.deleteMany({ where: { tenantId: t } })
      await owner.agencyMember.deleteMany({ where: { tenantId: t } }); await owner.agency.deleteMany({ where: { tenantId: t } })
      await owner.dailyRate.deleteMany({ where: { tenantId: t } }); await owner.dailyAvailability.deleteMany({ where: { tenantId: t } }); await owner.ratePlan.deleteMany({ where: { tenantId: t } }); await owner.contract.deleteMany({ where: { tenantId: t } })
      await owner.supplierRoomMapping.deleteMany({ where: { tenantId: t } }); await owner.supplierHotelMapping.deleteMany({ where: { tenantId: t } }); await owner.boardBasis.deleteMany({ where: { tenantId: t } })
      await owner.roomType.deleteMany({ where: { hotel: { tenantId: t } } }); await owner.hotel.deleteMany({ where: { tenantId: t } }); await owner.supplier.deleteMany({ where: { tenantId: t } })
      await owner.userRole.deleteMany({ where: { tenantId: t } }); await owner.rolePermission.deleteMany({ where: { role: { tenantId: t } } }); await owner.role.deleteMany({ where: { tenantId: t } }); await owner.membership.deleteMany({ where: { tenantId: t } })
    }
    await owner.session.deleteMany({ where: { userId: { in: userIds } } }); await owner.user.deleteMany({ where: { id: { in: userIds } } }); await owner.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB].filter(Boolean) } } })
    await owner.$disconnect()
  }, 60_000)

  it('SD-01 the app is connected as the strict API login and the live catalogue matches the contract, including the deal tables', async () => {
    const probe = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL })
    try {
      expect(await verifyApiRuntimeRole(probe)).toEqual({ ok: true, failures: [] })
      const rows = await probe.$queryRawUnsafe<Array<{ table_name: string; privilege_type: string }>>(`SELECT table_name, privilege_type FROM information_schema.role_table_grants WHERE grantee = '${API_RUNTIME_GROUP_ROLE}' AND table_name IN ('HotelDeal', 'HotelDealRatePlan') ORDER BY table_name, privilege_type`)
      expect(rows.map((row) => `${row.table_name}:${row.privilege_type}`)).toEqual(['HotelDeal:INSERT', 'HotelDeal:SELECT', 'HotelDealRatePlan:DELETE', 'HotelDealRatePlan:INSERT', 'HotelDealRatePlan:SELECT'])
    } finally { await probe.$disconnect() }
  })

  it('SD-02 a deal is drafted, approved by a second person and activated on the strict role, and search prices it', async () => {
    const before = rateOf((await search('agent')).body)
    expect(before).toMatchObject({ sellAmountMinor: 100_000 })
    const draft = (await call('post', ROUTE, 'maker', body({ name: 'Strict twenty' })).expect(201)).body.data
    const sub = (await call('post', `${ROUTE}/${draft.id}/submit`, 'maker', { expectedVersion: 1, requestId: key('submit'), reason: 'Ready for review' }).expect(200)).body.data
    expect((await call('post', `${ROUTE}/approvals/${sub.approval.id}/approve`, 'maker', { reason: 'I approve my own deal' })).status).toBe(403)
    await call('post', `${ROUTE}/approvals/${sub.approval.id}/approve`, 'checker', { reason: 'Terms checked' }).expect(200)
    expect(rateOf((await search('agent')).body)).toMatchObject({ sellAmountMinor: 100_000 })
    const live = (await call('post', `${ROUTE}/approvals/${sub.approval.id}/execute`, 'maker').expect(200)).body.data
    expect(live).toMatchObject({ status: 'ACTIVE', approval: { status: 'EXECUTED' } })
    expect(rateOf((await search('agent')).body)).toMatchObject({ sellAmountMinor: 80_000, promotion: { name: 'Strict twenty', kind: 'PERCENT_OFF' } })
    expect(await owner.auditEvent.count({ where: { tenantId: tenantA, entityType: 'hotel_deal', entityId: draft.id } })).toBe(4)
    await call('post', `${ROUTE}/${draft.id}/pause`, 'maker', { reason: 'Stop for this check' }).expect(200)
    expect(rateOf((await search('agent')).body)).toMatchObject({ sellAmountMinor: 100_000 })
  })

  it('SD-03 reads and denials work on the strict role: read-only users read, cannot write, and another tenant sees nothing', async () => {
    const draft = (await call('post', ROUTE, 'maker', body()).expect(201)).body.data
    expect((await call('get', `${ROUTE}/${draft.id}`, 'reader')).status).toBe(200)
    expect((await call('post', ROUTE, 'reader', body())).status).toBe(403)
    expect((await call('post', `${ROUTE}/${draft.id}/pause`, 'reader', { reason: 'because' })).status).toBe(403)
    expect((await call('get', `${ROUTE}/${draft.id}`, 'outsider')).status).toBe(404)
    expect((await call('get', ROUTE, 'outsider')).body.data.items).toEqual([])
    const preview = (await call('post', `${ROUTE}/${draft.id}/preview`, 'reader', { ratePlanId: planId, checkIn: day(20), nights: 2, adults: 2 }).expect(200)).body.data
    expect(preview).toMatchObject({ eligible: true, dealApplied: true, writes: 'none', withoutDeal: { sellMinor: '100000' }, withDeal: { sellMinor: '80000' } })
  })

  it('SD-04 the runtime role cannot do what the contract withholds: delete a deal, rewrite its identity or terms outside the column set, or write a plan promotion', async () => {
    const probe = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL })
    try {
      const deny = async (sql: string) => { await expect(probe.$executeRawUnsafe(sql)).rejects.toThrow(/permission denied/i) }
      await deny(`DELETE FROM "HotelDeal" WHERE false`)
      await deny(`UPDATE "HotelDeal" SET "tenant_id" = "tenant_id" WHERE false`)
      await deny(`UPDATE "HotelDeal" SET "hotel_id" = "hotel_id" WHERE false`)
      await deny(`UPDATE "HotelDeal" SET "created_by_id" = "created_by_id" WHERE false`)
      await deny(`UPDATE "HotelDeal" SET "idempotency_key" = "idempotency_key" WHERE false`)
      await deny(`INSERT INTO "RatePlanPromotion" ("id") SELECT 'x' WHERE false`)
      await deny(`UPDATE "HotelDealRatePlan" SET "rate_plan_id" = "rate_plan_id" WHERE false`)
    } finally { await probe.$disconnect() }
  })

  it('SD-05 the legacy per-plan promotion editor stays a privileged path on the strict role (audit finding R1, verified)', async () => {
    const read = await call('get', `/supply/rate-plans/${planId}/promotions`, 'maker')
    expect(read.status).toBe(200)
    const write = await call('put', `/supply/rate-plans/${planId}/promotions`, 'maker', { expectedUpdatedAt: read.body.data.updatedAt, promotions: [] })
    expect([403, 503]).toContain(write.status)
    expect(['RUNTIME_ROLE_OPERATION_PROHIBITED', 'DATABASE_ROLE_NOT_PERMITTED']).toContain(write.body.error.code)
    expect(await owner.ratePlanPromotion.count({ where: { tenantId: tenantA } })).toBe(0)
  })

  it('SD-06 an unreadable deal control stops search instead of selling at an unchecked price, and restoring the grant restores it', async () => {
    expect((await search('agent')).status).toBe(201)
    await owner.$executeRawUnsafe(`REVOKE SELECT ON "HotelDealRatePlan" FROM ${API_RUNTIME_GROUP_ROLE}`)
    try {
      const blocked = await search('agent')
      // Like every mandatory commercial control (ADR 0031): no offer and no price, reported as an unavailable provider.
      expect(blocked.body.data.status).toBe('provider_unavailable')
      expect(blocked.body.data.hotels).toEqual([])
    } finally { await owner.$executeRawUnsafe(`GRANT SELECT ON "HotelDealRatePlan" TO ${API_RUNTIME_GROUP_ROLE}`) }
    expect(rateOf((await search('agent')).body)).toBeDefined()
  })
})
