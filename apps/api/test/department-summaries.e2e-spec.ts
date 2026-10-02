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
import { PrismaService } from '../src/database/prisma.service'
import { OPERATIONS_READ_DENIED } from '@bedbanks/contracts'
import { provisionApiRuntimeRole, API_RUNTIME_LOGIN_ROLE } from '../src/database/api-runtime-role'
import { OperationsGovernanceService } from '../src/admin-operations/operations-governance.service'
import { OperationsTransactionsService } from '../src/admin-operations/operations-transactions.service'
import { OperationsHotelsService } from '../src/admin-operations/operations-hotels.service'

jest.setTimeout(120_000)

/** Markets, reliability and access review over HTTP against PostgreSQL, two tenants. Dates relative to today (UTC). */
describe('markets, reliability and access review (PostgreSQL, HTTP, two tenants)', () => {
  const prisma = new PrismaClient()
  const suffix = `ds-${Date.now()}-${randomBytes(3).toString('hex')}`
  const password = 'department-summaries-password'
  const midnight = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z').getTime()
  const utc = (offset: number) => new Date(midnight + offset * 86_400_000)
  let app: INestApplication
  let tenantA = '', tenantB = '', supplierA = '', supplierB = '', boardA = '', boardB = ''
  const userIds: string[] = []; const roleIds: string[] = []
  const cookies: Record<string, string> = {}
  const ids: Record<string, string> = {}

  async function makeHotel(tenant: 'A' | 'B', key: string, city: string, sellable: boolean) {
    const tenantId = tenant === 'A' ? tenantA : tenantB; const supplierId = tenant === 'A' ? supplierA : supplierB; const boardBasisId = tenant === 'A' ? boardA : boardB
    const hotel = await prisma.hotel.create({ data: { tenantId, name: `${suffix} ${key}`, externalRef: `${key}-${suffix.slice(-6)}`, propertyType: 'HOTEL', city, countryCode: 'AE', contentStatus: 'COMPLETE', starRating: 5 } })
    if (!sellable) return hotel
    const room = await prisma.roomType.create({ data: { hotelId: hotel.id, name: 'Deluxe', code: `D-${key}`.slice(0, 40), maxAdults: 2, maxChildren: 0, maxOccupancy: 2 } })
    const mapping = await prisma.supplierHotelMapping.create({ data: { tenantId, supplierId, hotelId: hotel.id, supplierHotelId: `${suffix}-${key}`, status: 'MAPPED' } })
    await prisma.supplierRoomMapping.create({ data: { tenantId, supplierHotelMappingId: mapping.id, hotelId: hotel.id, supplierRoomId: `${suffix}-${key}-r`, roomTypeId: room.id, status: 'MAPPED' } })
    const contract = await prisma.contract.create({ data: { tenantId, supplierId, supplierHotelMappingId: mapping.id, code: `${suffix}-${key}`, status: 'ACTIVE', validFrom: utc(-400), validTo: utc(4000), settlementCurrency: 'AED' } as never })
    const plan = await prisma.ratePlan.create({ data: { tenantId, contractId: contract.id, roomTypeId: room.id, boardBasisId, code: `${key}-BB`.slice(0, 40), status: 'ACTIVE', occupancy: 2, currency: 'AED', minStay: 1 } })
    const range = Array.from({ length: 45 }, (_, i) => utc(i - 2))
    await prisma.dailyRate.createMany({ data: range.map((stayDate) => ({ tenantId, ratePlanId: plan.id, stayDate, occupancy: 2, amountMinor: 45_000n, currency: 'AED', amountBasis: 'SELL' as const })) })
    await prisma.dailyAvailability.createMany({ data: range.map((stayDate) => ({ tenantId, ratePlanId: plan.id, stayDate, allotment: 5, sold: 0, stopSell: false })) })
    return hotel
  }
  async function user(label: string, tenantId: string, keys: string[] | null, extra: { status?: 'ACTIVE' | 'SUSPENDED'; lastLoginAt?: Date } = {}) {
    const email = `${suffix}-${label}@example.test`
    const u = await prisma.user.create({ data: { email, passwordHash: await hashPassword(password), status: extra.status ?? 'ACTIVE', ...(extra.lastLoginAt && { lastLoginAt: extra.lastLoginAt }) } })
    userIds.push(u.id); ids[label] = u.id
    await prisma.membership.create({ data: { tenantId, userId: u.id, role: 'agent' } })
    if (keys?.length) {
      const r = await prisma.role.create({ data: { tenantId, name: `${suffix}-${label}` } }); roleIds.push(r.id)
      for (const key of keys) {
        const p = await prisma.permission.upsert({ where: { key }, update: {}, create: { key, description: key } })
        await prisma.rolePermission.create({ data: { roleId: r.id, permissionId: p.id } })
      }
      await prisma.userRole.create({ data: { tenantId, userId: u.id, roleId: r.id } })
    }
    return email
  }
  async function login(email: string) {
    const response = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', 'http://localhost:3001').send({ email, password }).expect(200)
    return (response.headers['set-cookie'][0] as string).split(';')[0]
  }
  const get = (path: string, who = 'owner') => { const r = request(app.getHttpServer()).get(`/api/v1/admin/operations${path}`); return who === 'anon' ? r : r.set('Cookie', cookies[who]) }

  beforeAll(async () => {
    await prisma.$connect()
    tenantA = (await prisma.tenant.create({ data: { name: `${suffix} A`, slug: `${suffix}-a` } })).id
    tenantB = (await prisma.tenant.create({ data: { name: `${suffix} B`, slug: `${suffix}-b` } })).id
    supplierA = (await prisma.supplier.create({ data: { tenantId: tenantA, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${suffix} sA`, displayName: 'Alpha', countryCode: 'AE', defaultCurrency: 'AED' } })).id
    supplierB = (await prisma.supplier.create({ data: { tenantId: tenantB, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${suffix} sB`, displayName: 'Beta', countryCode: 'AE', defaultCurrency: 'AED' } })).id
    boardA = (await prisma.boardBasis.create({ data: { tenantId: tenantA, code: 'BB', name: 'B&B' } })).id
    boardB = (await prisma.boardBasis.create({ data: { tenantId: tenantB, code: 'BB', name: 'B&B' } })).id
    await makeHotel('A', 'alpha', 'Dubai', true)      // READY
    await makeHotel('A', 'bravo', 'Dubai', false)     // BLOCKED: nothing configured
    await makeHotel('A', 'charlie', 'Abu Dhabi', false)
    await makeHotel('B', 'oscar', 'Dubai', true)      // tenant B: must not appear in tenant A
    // connectors and executions (tenant A)
    const live = await prisma.connectorDefinition.create({ data: { tenantId: tenantA, supplierId: supplierA, type: 'API_JSON', status: 'ACTIVE', name: `${suffix} live`, version: '1', healthState: 'healthy' } })
    await prisma.connectorDefinition.create({ data: { tenantId: tenantA, supplierId: supplierA, type: 'API_JSON', status: 'ACTIVE', name: `${suffix} sick`, version: '1', healthState: 'degraded' } })
    await prisma.connectorDefinition.create({ data: { tenantId: tenantA, supplierId: supplierA, type: 'API_JSON', status: 'DRAFT', name: `${suffix} new`, version: '1' } })
    const exec = (status: 'SUCCEEDED' | 'FAILED' | 'RETRYING', n: number, cls: string | null, created = utc(0)) => prisma.connectorExecution.createMany({ data: Array.from({ length: n }, (_, i) => ({ tenantId: tenantA, connectorId: live.id, correlationId: `${suffix}-${status}-${cls}-${i}-${created.getTime()}`, operation: 'search', status, errorClassification: cls, createdAt: created })) })
    await exec('SUCCEEDED', 4, null); await exec('FAILED', 2, 'timeout'); await exec('FAILED', 1, 'auth'); await exec('RETRYING', 1, null)
    await exec('FAILED', 3, 'timeout', utc(-40)) // outside the 30-day window
    // people (tenant A)
    const owner = await user('owner', tenantA, ['supply.hotels.read', 'booking.read', 'audit.read', 'booking.reconcile'])
    const viewer = await user('viewer', tenantA, ['supply.hotels.read'])
    await user('norole', tenantA, null)
    await user('suspended', tenantA, null, { status: 'SUSPENDED' })
    await user('stale', tenantA, ['supply.hotels.read'], { lastLoginAt: new Date(Date.now() - 120 * 86_400_000) })
    const bowner = await user('bowner', tenantB, ['supply.hotels.read', 'booking.read', 'audit.read'])
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = module.createNestApplication()
    app.use(cookieParser()); app.setGlobalPrefix('api/v1')
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
    app.useGlobalFilters(new HttpExceptionFilter()); app.useGlobalInterceptors(new ResponseInterceptor())
    await app.init()
    cookies.owner = await login(owner); cookies.viewer = await login(viewer); cookies.bowner = await login(bowner)
  })

  afterAll(async () => {
    await app?.close()
    for (const tenantId of [tenantA, tenantB].filter(Boolean)) {
      await prisma.auditEvent.deleteMany({ where: { tenantId } })
      await prisma.connectorExecution.deleteMany({ where: { tenantId } })
      await prisma.connectorDefinition.deleteMany({ where: { tenantId } })
      await prisma.dailyRate.deleteMany({ where: { tenantId } })
      await prisma.dailyAvailability.deleteMany({ where: { tenantId } })
      await prisma.ratePlan.deleteMany({ where: { tenantId } })
      await prisma.contract.deleteMany({ where: { tenantId } })
      await prisma.supplierRoomMapping.deleteMany({ where: { tenantId } })
      await prisma.supplierHotelMapping.deleteMany({ where: { tenantId } })
      await prisma.boardBasis.deleteMany({ where: { tenantId } })
      await prisma.roomType.deleteMany({ where: { hotel: { tenantId } } })
      await prisma.hotel.deleteMany({ where: { tenantId } })
      await prisma.supplier.deleteMany({ where: { tenantId } })
      await prisma.userRole.deleteMany({ where: { tenantId } })
      await prisma.rolePermission.deleteMany({ where: { role: { tenantId } } })
      await prisma.role.deleteMany({ where: { tenantId } })
      await prisma.membership.deleteMany({ where: { tenantId } })
    }
    await prisma.session.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.user.deleteMany({ where: { id: { in: userIds } } })
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB].filter(Boolean) } } })
    await prisma.$disconnect()
  })

  it('MKT-01 destinations group hotels and use the Agent-search evaluator verdicts', async () => {
    const s = (await get('/markets/summary').expect(200)).body.data
    expect(s.totalHotels).toBe(3); expect(s.scanCapped).toBe(false)
    expect(s.destinations).toEqual([
      expect.objectContaining({ countryCode: 'AE', city: 'Dubai', hotels: 2, ready: 1, partial: 0, blocked: 1 }),
      expect.objectContaining({ countryCode: 'AE', city: 'Abu Dhabi', hotels: 1, ready: 0, partial: 0, blocked: 1 }),
    ])
    // the READY hotel agrees with the hotel list verdict
    const list = (await get('/hotels?pageSize=100').expect(200)).body.data.items
    expect(list.filter((h: { readiness: string }) => h.readiness === 'READY')).toHaveLength(1)
    expect(s.destinations[0].mappingIssues).toBe(1) // the unconfigured Dubai hotel
  })

  it('MKT-02 tenant isolation: tenant B sees only its own Dubai hotel', async () => {
    const s = (await get('/markets/summary', 'bowner').expect(200)).body.data
    expect(s.totalHotels).toBe(1); expect(s.destinations).toEqual([expect.objectContaining({ city: 'Dubai', hotels: 1, ready: 1 })])
  })

  it('REL-01 reliability counts connectors and windowed executions exactly, grouping failures by classification', async () => {
    const s = (await get('/reliability/summary').expect(200)).body.data
    expect(s.connectors).toEqual({ state: 'available', data: { total: 3, enabled: 2, unhealthy: 1, unknown: 1 } })
    expect(s.executions.state).toBe('available')
    expect(s.executions.data).toEqual({ total: 8, succeeded: 4, failed: 3, retrying: 1, byClassification: [{ classification: 'timeout', count: 2 }, { classification: 'auth', count: 1 }] })
    expect(s.supplierOutcomes).toEqual({ state: 'available', data: { uncertain: 0, oldestUncertainAt: null } })
    expect(s.holds).toEqual({ state: 'available', data: { stalledProcessing: 0, staleMinutes: 30 } })
    const wide = (await get('/reliability/summary?days=90').expect(200)).body.data
    expect(wide.executions.data.failed).toBe(6)
  })

  it('REL-02 tenant isolation: tenant B has no connectors or executions', async () => {
    const s = (await get('/reliability/summary', 'bowner').expect(200)).body.data
    expect(s.connectors.data).toEqual({ total: 0, enabled: 0, unhealthy: 0, unknown: 0 })
    expect(s.executions.data.total).toBe(0)
  })

  it('ACC-01 access review flags the right members and names sensitive permission holders', async () => {
    const s = (await get('/access-review/summary').expect(200)).body.data
    expect(s.members).toEqual({ total: 5, active: 4, inactive: 1, neverLoggedIn: 2, staleLogin: 1, noRole: 2, holdingSensitive: 1 })
    expect(s.staleLoginDays).toBe(90)
    expect(s.roles.find((r: { name: string }) => r.name === `${suffix}-owner`)).toMatchObject({ members: 1, sensitivePermissions: ['booking.reconcile'] })
    const page = (await get('/access-review/users?pageSize=100').expect(200)).body.data
    expect(page.total).toBe(5)
    expect(page.items.map((r: { email: string }) => r.email.replace(`${suffix}-`, '').replace('@example.test', ''))).toEqual(['suspended', 'norole', 'owner', 'stale', 'viewer'])
    const by = Object.fromEntries(page.items.map((r: { email: string }) => [r.email.replace(`${suffix}-`, '').replace('@example.test', ''), r]))
    expect(by.suspended.flags).toEqual(['INACTIVE', 'NEVER_LOGGED_IN', 'NO_ROLE'])
    expect(by.norole.flags).toEqual(['NEVER_LOGGED_IN', 'NO_ROLE'])
    expect(by.owner).toMatchObject({ flags: ['HOLDS_SENSITIVE'], sensitivePermissions: ['booking.reconcile'] })
    expect(by.stale.flags).toEqual(['STALE_LOGIN']); expect(by.viewer.flags).toEqual([])
    const filtered = (await get('/access-review/users?flag=NO_ROLE').expect(200)).body.data
    expect(filtered.total).toBe(2)
    await get('/access-review/users?flag=BOGUS').expect(400)
  })

  it('ACC-02 tenant isolation: tenant B reviews only its own member, and no password material is ever returned', async () => {
    const page = (await get('/access-review/users', 'bowner').expect(200)).body.data
    expect(page.total).toBe(1); expect(page.items[0].email).toContain('bowner')
    const raw = JSON.stringify((await get('/access-review/users?pageSize=100').expect(200)).body)
    expect(raw).not.toMatch(/passwordHash|password_hash|\$argon|\$2[aby]\$/)
  })

  it('RBAC: markets needs supply.hotels.read, reliability booking.read, access review audit.read; anonymous is refused', async () => {
    await get('/markets/summary', 'viewer').expect(200)
    await get('/reliability/summary', 'viewer').expect(403)
    await get('/access-review/summary', 'viewer').expect(403)
    await get('/access-review/users', 'viewer').expect(403)
    for (const p of ['/markets/summary', '/reliability/summary', '/access-review/summary', '/access-review/users']) await get(p, 'anon').expect(401)
    for (const bad of ['days=0', 'days=91', 'days=x']) { await get(`/markets/summary?${bad}`).expect(400); await get(`/reliability/summary?${bad}`).expect(400) }
  })

  it('RUNTIME-ROLE: under the non-bypass API runtime role, unreadable sections are explicit unavailable and readable ones stay tenant-scoped', async () => {
    const owner = new PrismaClient()
    const runtimePassword = randomBytes(24).toString('hex')
    const previous = process.env.DATABASE_URL
    let runtime: PrismaService | undefined
    try {
      await provisionApiRuntimeRole(owner, { password: runtimePassword })
      const url = new URL(previous as string); url.username = API_RUNTIME_LOGIN_ROLE; url.password = runtimePassword
      runtime = new PrismaService({ datasourceUrl: url.toString() } as never)
      await runtime.$connect()
      const tx = new OperationsTransactionsService(runtime, {} as never)
      const governance = new OperationsGovernanceService(runtime, tx)
      const r = await governance.reliability(tenantA, {})
      const states = Object.fromEntries((['connectors', 'executions', 'supplierOutcomes', 'holds'] as const).map((k) => [k, r[k].state]))
      for (const section of [r.connectors, r.executions, r.supplierOutcomes, r.holds]) if (section.state === 'unavailable') expect(section.reason).toBe(OPERATIONS_READ_DENIED)
      expect(states.supplierOutcomes).toBe('unavailable'); expect(states.holds).toBe('unavailable') // booking-side tables are outside the role's grants
      const markets = await new OperationsHotelsService(runtime).markets(tenantA, {})
      expect(markets.totalHotels).toBe(3); expect(markets.destinations.map((d) => d.city)).toEqual(['Dubai', 'Abu Dhabi'])
      const a = await governance.accessReview(tenantA).then((x) => ({ ok: true as const, x }), (e) => ({ ok: false as const, e }))
      if (a.ok) expect(a.x.members.total).toBe(5)
      else expect((a.e as { getResponse: () => unknown }).getResponse()).toMatchObject({ code: OPERATIONS_READ_DENIED })
    } finally { await runtime?.$disconnect(); await owner.$disconnect() }
  })
})
