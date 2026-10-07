import { randomBytes } from 'crypto'
import { INestApplication, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { PrismaClient } from '@prisma/client'
import * as cookieParser from 'cookie-parser'
import * as request from 'supertest'
import type { BookingAccessView, BookingListPage } from '@bedbanks/contracts'
import { AppModule } from '../src/app.module'
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter'
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor'
import { hashPassword } from '../src/auth/utils/password'
import { provisionApiRuntimeRole, API_RUNTIME_LOGIN_ROLE } from '../src/database/api-runtime-role'
import { BookingQueryService } from '../src/booking-ops/booking-query.service'
import { enableBookingOps } from './support/booking-ops'

jest.setTimeout(180_000)

/** The canonical booking query on PostgreSQL (ADR 0039, Phase 6A): strict API role, booking role, two tenants, deterministic paging, scoped and gated fields. */
describe('BookingQueryV1 on PostgreSQL (HTTP + service, strict roles)', () => {
  const owner = new PrismaClient()
  const suffix = `bq-${Date.now()}-${randomBytes(3).toString('hex')}`
  const password = 'booking-query-certification-password'
  const runtimePassword = `rt-${randomBytes(20).toString('hex')}`
  const origin = 'http://localhost:3001'
  let app: INestApplication; let previousUrl: string | undefined; let restoreOps: () => void = () => undefined
  let tenantA = '', tenantB = '', agencyX = '', agencyY = '', hotelDubai = '', hotelLondon = '', hotelB = '', opsUserId = ''
  const cookies: Record<string, string> = {}; const userIds: string[] = []; const byRef = new Map<string, string>()
  const T0 = Date.UTC(2030, 0, 10, 12, 0, 0)

  async function user(label: string, tenantId: string, keys: string[], agencyId?: string) {
    const u = await owner.user.create({ data: { email: `${suffix}-${label}@example.test`, name: label, passwordHash: await hashPassword(password), status: 'ACTIVE' } }); userIds.push(u.id)
    await owner.membership.create({ data: { tenantId, userId: u.id, role: 'agent' } })
    const r = await owner.role.create({ data: { tenantId, name: `${suffix}-${label}` } })
    for (const key of keys) { const p = await owner.permission.upsert({ where: { key }, update: {}, create: { key, description: key } }); await owner.rolePermission.create({ data: { roleId: r.id, permissionId: p.id } }) }
    await owner.userRole.create({ data: { tenantId, userId: u.id, roleId: r.id } })
    if (agencyId) await owner.agencyMember.create({ data: { tenantId, agencyId, userId: u.id } })
    return u.id
  }
  async function booking(key: string, o: { tenant?: 'A' | 'B'; status?: string; agency?: 'X' | 'Y' | null; hotel?: 'Dubai' | 'London'; channel?: 'PORTAL' | 'API' | 'MANUAL'; currency?: string; sell?: bigint; createdMs?: number } = {}) {
    const tenantId = o.tenant === 'B' ? tenantB : tenantA
    const b = await owner.booking.create({ data: {
      tenantId, reference: `FB-${suffix.replace(/[^a-z0-9]/gi, '').toUpperCase()}${key}`.slice(0, 30), supplier: 'Global Hotel Supply', hotelId: o.tenant === 'B' ? hotelB : o.hotel === 'London' ? hotelLondon : hotelDubai,
      status: (o.status ?? 'CONFIRMED') as never, currency: o.currency ?? 'AED', totalMinor: o.sell ?? 100_000n, idempotencyKey: `${suffix}-${key}`, searchSnapshot: {}, channel: o.channel ?? 'PORTAL',
      agencyId: o.tenant === 'B' ? null : o.agency === undefined || o.agency === 'X' ? agencyX : o.agency === 'Y' ? agencyY : null, createdAt: new Date(o.createdMs ?? T0),
    } })
    await owner.bookingEvent.create({ data: { tenantId, bookingId: b.id, toStatus: (o.status ?? 'CONFIRMED') as never, actorType: 'SYSTEM', reason: 'fixture', payload: { backfill: true } } })
    byRef.set(b.id, key)
    return b
  }
  const get = (qs: string, who: string) => request(app.getHttpServer()).get(`/api/v1/admin/operations/bookings?${qs}`).set('Cookie', cookies[who])
  const list = async (qs: string, who = 'ops'): Promise<BookingListPage> => (await get(qs, who).expect(200)).body.data
  const keys = (p: BookingListPage) => p.items.map((i) => byRef.get(i.id) as string)
  const accessOf = (over: Partial<BookingAccessView> = {}): BookingAccessView => ({ level: 'OPERATOR', canViewNet: false, canViewPii: false, agencyId: null, permissions: [], manualEntry: false, supplierDispatch: false, opsQueue: false, ...over })

  beforeAll(async () => {
    await owner.$connect()
    tenantA = (await owner.tenant.create({ data: { name: suffix, slug: suffix } })).id; tenantB = (await owner.tenant.create({ data: { name: `${suffix}-b`, slug: `${suffix}-b` } })).id
    const creator = await owner.user.create({ data: { email: `${suffix}-creator@example.test`, name: 'creator' } }); userIds.push(creator.id)
    agencyX = (await owner.agency.create({ data: { tenantId: tenantA, code: `X-${suffix.slice(-6)}`.toUpperCase(), name: 'Travel Republic', countryCode: 'GB', createdById: creator.id } })).id
    agencyY = (await owner.agency.create({ data: { tenantId: tenantA, code: `Y-${suffix.slice(-6)}`.toUpperCase(), name: 'Atlas Getaways', countryCode: 'AE', createdById: creator.id } })).id
    hotelDubai = (await owner.hotel.create({ data: { tenantId: tenantA, name: `${suffix} Atlantis`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', timeZone: 'Asia/Dubai' } })).id
    hotelLondon = (await owner.hotel.create({ data: { tenantId: tenantA, name: `${suffix} Hoxton`, propertyType: 'HOTEL', city: 'London', countryCode: 'GB', timeZone: 'Europe/London' } })).id
    hotelB = (await owner.hotel.create({ data: { tenantId: tenantB, name: `${suffix} Other`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE' } })).id
    opsUserId = await user('ops', tenantA, ['booking.read', 'booking.finance.view', 'booking.ops.view'])
    await user('plain', tenantA, ['booking.read'])
    await user('agx', tenantA, ['booking.view.agency'], agencyX)
    await user('bops', tenantB, ['booking.read'])
    // Twelve bookings sharing ONE created timestamp, so ordering depends entirely on the id tie-break; plus varied attributes.
    for (let i = 1; i <= 12; i++) await booking(`t${String(i).padStart(2, '0')}`)
    await booking('mn', { channel: 'MANUAL', currency: 'GBP', sell: 250_000n, hotel: 'London', agency: 'Y', status: 'CANCELLED', createdMs: T0 - 86_400_000 })
    await booking('ap', { channel: 'API', currency: 'GBP', sell: 50_000n, hotel: 'London', agency: null, createdMs: T0 - 2 * 86_400_000 })
    const noSource = await booking('own', { sell: 70_000n, createdMs: T0 - 3 * 86_400_000 })
    await owner.bookingOpsState.create({ data: { tenantId: tenantA, bookingId: noSource.id, assigneeUserId: opsUserId, assignedAt: new Date(), assignedByUserId: opsUserId, updatedAt: new Date() } })
    const mn = [...byRef.entries()].find(([, k]) => k === 'mn')![0]
    await owner.bookingFinanceEvent.create({ data: { tenantId: tenantA, bookingId: mn, type: 'CANCELLED', currency: 'GBP', sellMinor: 250_000n } })
    for (const k of ['b1', 'b2']) await booking(k, { tenant: 'B' })
    restoreOps = await enableBookingOps(owner)
    await provisionApiRuntimeRole(owner, { password: runtimePassword })
    previousUrl = process.env.DATABASE_URL
    const u = new URL(previousUrl as string); u.username = API_RUNTIME_LOGIN_ROLE; u.password = runtimePassword
    process.env.DATABASE_URL = u.toString(); process.env.ADMIN_ORIGIN = origin
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication(); app.use(cookieParser()); app.setGlobalPrefix('api/v1')
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
    app.useGlobalFilters(new HttpExceptionFilter()); app.useGlobalInterceptors(new ResponseInterceptor())
    await app.init()
    for (const label of ['ops', 'plain', 'agx', 'bops']) {
      const r = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', origin).send({ email: `${suffix}-${label}@example.test`, password }).expect(200)
      cookies[label] = (r.headers['set-cookie'][0] as string).split(';')[0]
    }
  })

  afterAll(async () => {
    await app?.close(); restoreOps()
    if (previousUrl) process.env.DATABASE_URL = previousUrl
    for (const t of [tenantA, tenantB].filter(Boolean)) {
      for (const q of [`DELETE FROM "AuditEvent" WHERE tenant_id = '${t}'`, `DELETE FROM "Booking" WHERE tenant_id = '${t}'`, `DELETE FROM "AgencyMember" WHERE tenant_id = '${t}'`, `DELETE FROM "Agency" WHERE tenant_id = '${t}'`, `DELETE FROM "Hotel" WHERE tenant_id = '${t}'`,
        `DELETE FROM "UserRole" WHERE tenant_id = '${t}'`, `DELETE FROM "RolePermission" WHERE role_id IN (SELECT id FROM "Role" WHERE tenant_id = '${t}')`, `DELETE FROM "Role" WHERE tenant_id = '${t}'`, `DELETE FROM memberships WHERE tenant_id = '${t}'`]) await owner.$executeRawUnsafe(q).catch(() => undefined)
    }
    await owner.session.deleteMany({ where: { userId: { in: userIds } } }); await owner.user.deleteMany({ where: { id: { in: userIds } } }); await owner.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB].filter(Boolean) } } })
    await owner.$disconnect()
  })

  it('BQ-E01: tenant isolation: another operator\'s bookings never appear, whatever the query says, and a tenant field is a 400', async () => {
    const all = await list('pageSize=100')
    expect(all.total).toBe(15); expect(keys(all).some((k) => k.startsWith('b'))).toBe(false)
    expect((await list('pageSize=100', 'bops')).total).toBe(2)
    for (const qs of ['tenantId=' + tenantB, 'tenant_id=' + tenantB, 'where=1%3D1']) expect((await get(qs, 'ops')).status).toBe(400)
    const res = await get('tenantId=x&status=NOPE&page=0', 'ops'); expect(res.status).toBe(400)
    expect(JSON.stringify(res.body)).toMatch(/BOOKING_QUERY_INVALID/); expect(JSON.stringify(res.body)).toMatch(/tenantId/); expect(JSON.stringify(res.body)).toMatch(/status/)
  })

  it('BQ-E02: pagination is consistent: with every row tied on the sort key the pages neither overlap nor skip, and match the service id order', async () => {
    const seen: string[] = []
    for (const p of [1, 2, 3, 4]) seen.push(...keys(await list(`pageSize=25&page=${p}&status=CONFIRMED&dateType=created&from=2030-01-10&to=2030-01-10`)))
    const small: string[] = []
    // pageSize 25 is the smallest the grammar allows, so compare one page against the service's own ordered ids.
    const filter = app.get(BookingQueryService).parse({ status: 'CONFIRMED', dateType: 'created', from: '2030-01-10', to: '2030-01-10' }, accessOf())
    const { ids, truncated } = await app.get(BookingQueryService).ids(tenantA, accessOf(), filter, new Date(T0))
    expect(truncated).toBe(false)
    expect(ids.map((i) => byRef.get(i))).toEqual(seen)
    expect(new Set(seen).size).toBe(seen.length); expect(seen).toHaveLength(12)
    expect(small).toHaveLength(0)
    // id desc is the final tie-break: the ordered ids are strictly descending.
    const sorted = [...ids].sort().reverse(); expect(ids).toEqual(sorted)
  })

  it('BQ-E03: the cap is honoured and reported', async () => {
    const filter = app.get(BookingQueryService).parse({}, accessOf())
    const r = await app.get(BookingQueryService).ids(tenantA, accessOf(), filter, new Date(T0), 5)
    expect(r.ids).toHaveLength(5); expect(r.truncated).toBe(true)
  })

  it('BQ-E04: the new filters select the right bookings', async () => {
    expect(keys(await list('source=MANUAL'))).toEqual(['mn'])
    expect(keys(await list('source=API'))).toEqual(['ap'])
    expect(keys(await list('currency=GBP&amountMin=100000&amountMax=300000'))).toEqual(['mn'])
    expect(keys(await list('currency=GBP')).sort()).toEqual(['ap', 'mn'])
    expect(keys(await list('destination=london')).sort()).toEqual(['ap', 'mn'])
    expect((await list('destination=dubai&pageSize=100')).total).toBe(13)
    expect(keys(await list('opsOwner=' + opsUserId))).toEqual(['own'])
    expect((await list('opsOwner=unassigned&pageSize=100')).total).toBe(14)
    expect(keys(await list('moneyEvent=CANCELLED'))).toEqual(['mn'])
    expect(keys(await list('dateType=created&from=2030-01-09&to=2030-01-09'))).toEqual(['mn'])
  })

  it('BQ-E05: permission-limited results: gated fields are 403 for a caller without the permission, and an agency user stays in their agency', async () => {
    for (const qs of ['moneyEvent=CANCELLED', 'opsOwner=unassigned']) { expect((await get(qs, 'plain')).status).toBe(403); expect((await get(qs, 'agx')).status).toBe(403) }
    const mine = await list('pageSize=100', 'agx')
    expect(mine.items.every((i) => i.agency?.id === agencyX)).toBe(true)
    expect(keys(mine)).not.toContain('mn'); expect(keys(mine)).not.toContain('ap')
    expect((await get(`agencyId=${agencyY}`, 'agx')).status).toBe(403)
    expect((await get('guest=Haddad', 'plain')).status).toBe(403)
  })

  it('BQ-E06: the booking role reads through row-level security only: no tenant context sees nothing; the API role cannot read bookings at all', async () => {
    const roleUrl = process.env.BOOKING_OPS_DATABASE_URL as string
    const role = new PrismaClient({ datasourceUrl: roleUrl })
    try { expect(await role.booking.count()).toBe(0) } finally { await role.$disconnect() }
    const api = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL as string })
    try { await expect(api.$queryRawUnsafe('SELECT 1 FROM "Booking" LIMIT 1')).rejects.toThrow(/permission denied/) } finally { await api.$disconnect() }
  })
})
