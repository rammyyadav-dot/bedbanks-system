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
import { API_RUNTIME_LOGIN_ROLE, provisionApiRuntimeRole, verifyApiRuntimeRole } from '../src/database/api-runtime-role'

const ownerUrl = process.env.DATABASE_URL
if (!ownerUrl) throw new Error('DATABASE_URL (the disposable owner connection) is required')

/**
 * The whole HTTP application running on the restricted API runtime login role (never an owner, superuser or BYPASSRLS role):
 * Agent search and recheck and the Admin inventory read views work and stay tenant-scoped; every inventory mutation fails closed
 * and writes nothing, because that role has no write grant on pool, stock or plan tables.
 */
describe('inventory over HTTP on the restricted API runtime role (PostgreSQL)', () => {
  const owner = new PrismaClient({ datasourceUrl: ownerUrl })
  const suffix = `rh-${Date.now()}-${randomBytes(3).toString('hex')}`
  const password = 'runtime-http-password'
  const runtimePassword = randomBytes(24).toString('hex')
  const origin = 'http://localhost:3001'
  const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)
  let app: INestApplication; let previousUrl: string | undefined
  let tenantA = '', tenantB = '', hotelId = '', poolId = ''
  const planIds: string[] = []; const userIds: string[] = []; const cookies: Record<string, string> = {}

  async function user(label: string, tenantId: string, keys: string[]) {
    const email = `${suffix}-${label}@example.test`
    const u = await owner.user.create({ data: { email, name: label, passwordHash: await hashPassword(password), status: 'ACTIVE' } }); userIds.push(u.id)
    await owner.membership.create({ data: { tenantId, userId: u.id, role: 'agent' } })
    const r = await owner.role.create({ data: { tenantId, name: `${suffix}-${label}` } })
    for (const key of keys) { const p = await owner.permission.upsert({ where: { key }, update: {}, create: { key, description: key } }); await owner.rolePermission.create({ data: { roleId: r.id, permissionId: p.id } }) }
    await owner.userRole.create({ data: { tenantId, userId: u.id, roleId: r.id } })
    return email
  }
  const call = (method: 'get' | 'post' | 'patch', path: string, who: string, body?: object) => { const r = request(app.getHttpServer())[method](`/api/v1${path}`).set('Cookie', cookies[who]).set('Origin', origin); return body ? r.send(body) : r }

  beforeAll(async () => {
    await owner.$connect()
    tenantA = (await owner.tenant.create({ data: { name: `${suffix}a`, slug: `${suffix}a` } })).id
    tenantB = (await owner.tenant.create({ data: { name: `${suffix}b`, slug: `${suffix}b` } })).id
    const supplierId = (await owner.supplier.create({ data: { tenantId: tenantA, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${suffix}`, displayName: 'S', countryCode: 'AE', defaultCurrency: 'AED' } })).id
    const boardId = (await owner.boardBasis.create({ data: { tenantId: tenantA, code: 'BB', name: 'B&B' } })).id
    hotelId = (await owner.hotel.create({ data: { tenantId: tenantA, name: `${suffix} Hotel`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', contentStatus: 'COMPLETE', starRating: 5 } })).id
    const roomId = (await owner.roomType.create({ data: { hotelId, name: 'Deluxe', code: suffix, maxAdults: 2, maxOccupancy: 2 } })).id
    const mapping = await owner.supplierHotelMapping.create({ data: { tenantId: tenantA, supplierId, hotelId, supplierHotelId: `${suffix}-h`, status: 'MAPPED' } })
    await owner.supplierRoomMapping.create({ data: { tenantId: tenantA, supplierHotelMappingId: mapping.id, hotelId, supplierRoomId: `${suffix}-r`, roomTypeId: roomId, status: 'MAPPED' } })
    const contractId = (await owner.contract.create({ data: { tenantId: tenantA, supplierId, supplierHotelMappingId: mapping.id, code: suffix, status: 'ACTIVE', validFrom: new Date('2026-01-01'), validTo: new Date('2099-12-31'), settlementCurrency: 'AED' } as never })).id
    const creator = (await owner.user.create({ data: { email: `${suffix}-c@example.test` } })).id; userIds.push(creator)
    poolId = (await owner.inventoryPool.create({ data: { tenantId: tenantA, hotelId, supplierId, name: 'Shared', createdById: creator } })).id
    const nights = [day(20), day(21), day(22)].map((d) => new Date(d))
    await owner.inventoryPoolDay.createMany({ data: nights.map((stayDate) => ({ tenantId: tenantA, poolId, stayDate, capacity: 5 })) })
    for (const code of ['P1', 'P2', 'P3']) {
      const id = (await owner.ratePlan.create({ data: { tenantId: tenantA, contractId, roomTypeId: roomId, boardBasisId: boardId, code, status: 'ACTIVE', occupancy: 2, currency: 'AED', inventoryPoolId: poolId } })).id; planIds.push(id)
      await owner.dailyRate.createMany({ data: nights.map((stayDate) => ({ tenantId: tenantA, ratePlanId: id, stayDate, occupancy: 2, amountMinor: 49_900n, currency: 'AED', amountBasis: 'SELL' as const })) })
      await owner.dailyAvailability.createMany({ data: nights.map((stayDate) => ({ tenantId: tenantA, ratePlanId: id, stayDate, allotment: 9 })) })
    }
    const agent = await user('agent', tenantA, ['hotel.search'])
    const admin = await user('admin', tenantA, ['agency.read', 'supply.hotels.read', 'supply.rates.read', 'supply.availability.read', 'supply.availability.manage'])
    const other = await user('other', tenantB, ['supply.hotels.read', 'supply.rates.read', 'supply.availability.read', 'supply.availability.manage'])
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
    for (const [label, email] of Object.entries({ agent, admin, other })) {
      const r = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', origin).send({ email, password }).expect(200)
      cookies[label] = (r.headers['set-cookie'][0] as string).split(';')[0]
    }
  })

  afterAll(async () => {
    await app?.close()
    if (previousUrl) process.env.DATABASE_URL = previousUrl
    for (const t of [tenantA, tenantB].filter(Boolean)) {
      await owner.auditEvent.deleteMany({ where: { tenantId: t } }); await owner.dailyRate.deleteMany({ where: { tenantId: t } }); await owner.dailyAvailability.deleteMany({ where: { tenantId: t } }); await owner.ratePlan.deleteMany({ where: { tenantId: t } })
      await owner.inventoryPoolDay.deleteMany({ where: { tenantId: t } }); await owner.inventoryPool.deleteMany({ where: { tenantId: t } }); await owner.contract.deleteMany({ where: { tenantId: t } })
      await owner.supplierRoomMapping.deleteMany({ where: { tenantId: t } }); await owner.supplierHotelMapping.deleteMany({ where: { tenantId: t } }); await owner.boardBasis.deleteMany({ where: { tenantId: t } })
      await owner.roomType.deleteMany({ where: { hotel: { tenantId: t } } }); await owner.hotel.deleteMany({ where: { tenantId: t } }); await owner.supplier.deleteMany({ where: { tenantId: t } })
      await owner.userRole.deleteMany({ where: { tenantId: t } }); await owner.rolePermission.deleteMany({ where: { role: { tenantId: t } } }); await owner.role.deleteMany({ where: { tenantId: t } }); await owner.membership.deleteMany({ where: { tenantId: t } })
    }
    await owner.session.deleteMany({ where: { userId: { in: userIds } } }); await owner.user.deleteMany({ where: { id: { in: userIds } } }); await owner.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB].filter(Boolean) } } })
    await owner.$disconnect()
  })

  it('RH-01 the application really is connected as the restricted role and the role verifier passes', async () => {
    const [who] = await owner.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM pg_stat_activity WHERE usename = '${API_RUNTIME_LOGIN_ROLE}' AND datname = current_database()`)
    expect(Number(who.n)).toBeGreaterThan(0)
    const probe = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL })
    try { expect(await verifyApiRuntimeRole(probe)).toEqual({ ok: true, failures: [] }) } finally { await probe.$disconnect() }
  })

  it('RH-01b stay diagnostics read buyer controls under the restricted role and show pooled stock, without writes', async () => {
    const agency = await owner.agency.create({ data: { tenantId: tenantA, code: `${suffix}-diag`.toUpperCase(), name: 'Diagnostic agency', countryCode: 'AE', createdById: userIds[0] } })
    const before = await owner.inventoryPoolDay.findMany({ where: { poolId }, orderBy: { stayDate: 'asc' } })
    const q = `/admin/operations/hotels/${hotelId}/sellability?checkIn=${day(20)}&checkOut=${day(22)}&adults=2&currency=AED&nationality=IN&agencyId=${agency.id}`
    try {
      const inspected = (await call('get', q, 'admin').expect(200)).body.data
      expect(inspected.readiness.buyer).toMatchObject({ assessed: true, market: 'AE', nationality: 'IN' })
      expect(inspected.plans).toHaveLength(3)
      for (const plan of inspected.plans) expect(plan.nights.map((n: { remaining: number }) => n.remaining)).toEqual([5, 5])
      expect(inspected.readiness.certification).toBe('NOT_VERIFIED')
      expect(await owner.inventoryPoolDay.findMany({ where: { poolId }, orderBy: { stayDate: 'asc' } })).toEqual(before)
      await owner.agency.update({ where: { id: agency.id }, data: { status: 'SUSPENDED' } })
      const suspended = (await call('get', q, 'admin').expect(200)).body.data
      expect(suspended.sellable).toBe(false)
      expect(suspended.plans.every((p: { reasons: string[] }) => p.reasons.includes('AGENCY_SUSPENDED'))).toBe(true)
    } finally { await owner.agency.delete({ where: { id: agency.id } }) }
  })

  it('RH-02 Agent search shows the three pooled plans, recheck is authoritative, and neither consumes stock', async () => {
    const searched = await call('post', '/agent/search', 'agent', { destination: 'Dubai', checkIn: day(20), checkOut: day(22), rooms: 1, adults: 2, children: 0, childAges: [], nationality: 'IN', currency: 'AED', limit: 100 }).expect(201)
    const rates = (searched.body.data.hotels as Array<{ rooms: Array<{ rates: Array<{ ratePlanId: string; availability: string; offerId: string; sellAmountMinor: number }> }> }>).flatMap((h) => h.rooms.flatMap((r) => r.rates))
    expect(rates.filter((r) => planIds.includes(r.ratePlanId))).toHaveLength(3)
    const offer = rates.find((r) => r.ratePlanId === planIds[0])!
    const rc = await call('post', '/agent/rates/recheck', 'agent', { offerId: offer.offerId, searchId: searched.body.data.searchId, expectedCurrency: 'AED', expectedSellAmountMinor: offer.sellAmountMinor })
    expect(rc.status).toBe(200); expect(rc.body.data.status).toBe('rechecked')
    expect(await owner.inventoryPoolDay.findMany({ where: { poolId }, select: { sold: true, held: true } })).toEqual([{ sold: 0, held: 0 }, { sold: 0, held: 0 }, { sold: 0, held: 0 }])
  })

  it('RH-03 the Admin inventory summary and calendar read through the role and show one shared stock of 5', async () => {
    const summary = (await call('get', `/admin/hotels/${hotelId}/inventory/summary?from=${day(20)}&days=3`, 'admin').expect(200)).body.data
    expect(summary.pools[0].nights.map((n: { capacity: number; remaining: number }) => [n.capacity, n.remaining])).toEqual([[5, 5], [5, 5], [5, 5]])
    expect(summary.totals).toMatchObject({ plans: 3, pooledPlans: 3, pools: 1 })
    const cal = (await call('get', `/admin/operations/hotels/${hotelId}/calendar?from=${day(20)}&days=3`, 'admin').expect(200)).body.data
    expect(cal.rows.flatMap((r: { cells: unknown[] }) => r.cells)).toHaveLength(9)
  })

  it('RH-04 pool creation and release-rule edits fail closed and write nothing; Quick Update provenance writes remain privileged; another tenant sees nothing', async () => {
    const created = await call('post', `/admin/hotels/${hotelId}/inventory/pools`, 'admin', { name: 'Nope', supplierId: (await owner.inventoryPool.findUniqueOrThrow({ where: { id: poolId } })).supplierId, ratePlanIds: [], idempotencyKey: `${suffix}-create-key` })
    expect(created.status).toBeGreaterThanOrEqual(400)
    const scope = { ratePlanIds: [planIds[0]], ranges: [{ from: day(20), to: day(20) }] }
    const changes = { availability: { allotment: 3 } }
    const preview = await call('post', `/admin/hotels/${hotelId}/quick-update/preview`, 'admin', { scope, changes })
    const fingerprint = preview.status === 200 ? preview.body.data.fingerprint : 'a'.repeat(64)
    const beforeQuickUpdate = await owner.inventoryPoolDay.findMany({ where: { poolId }, orderBy: { stayDate: 'asc' } })
    const applied = await call('post', `/admin/hotels/${hotelId}/quick-update/apply`, 'admin', { scope, changes, idempotencyKey: `${suffix}-apply-key`, expectedFingerprint: fingerprint, reason: 'runtime role attempt' })
    expect(applied.status).toBe(403) // ADR 0037: Quick Update stamps provenance; only the capacity editor has the two-column write path.
    expect(applied.body.error.code).toBe('RUNTIME_ROLE_OPERATION_PROHIBITED')
    expect(await owner.inventoryPoolDay.findMany({ where: { poolId }, orderBy: { stayDate: 'asc' } })).toEqual(beforeQuickUpdate)
    const release = await call('patch', `/admin/hotels/${hotelId}/inventory/rate-plans/${planIds[0]}/release`, 'admin', { releaseDays: 3, releaseTimeLocal: '10:00', expectedUpdatedAt: new Date().toISOString(), reason: 'runtime role attempt', idempotencyKey: `${suffix}-rel-key` })
    expect(release.status).toBeGreaterThanOrEqual(400)
    expect(await owner.inventoryPool.count({ where: { tenantId: tenantA } })).toBe(1)
    expect((await owner.inventoryPoolDay.findMany({ where: { poolId }, select: { capacity: true } })).map((d) => d.capacity)).toEqual([5, 5, 5])
    expect(await owner.ratePlan.count({ where: { tenantId: tenantA, releaseDays: 3 } })).toBe(0)
    await call('get', `/admin/hotels/${hotelId}/inventory/summary`, 'other').expect(404)
    await call('post', `/admin/hotels/${hotelId}/inventory/pools`, 'other', { name: 'x', supplierId: 'x', idempotencyKey: `${suffix}-other-key` }).expect(404)
  })
})
