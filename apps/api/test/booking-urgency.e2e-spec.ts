import { randomBytes } from 'crypto'
import { INestApplication, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { PrismaClient } from '@prisma/client'
import * as cookieParser from 'cookie-parser'
import * as request from 'supertest'
import type { BookingListPage } from '@bedbanks/contracts'
import { AppModule } from '../src/app.module'
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter'
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor'
import { hashPassword } from '../src/auth/utils/password'
import { provisionApiRuntimeRole, API_RUNTIME_LOGIN_ROLE } from '../src/database/api-runtime-role'
import { enableBookingOps } from './support/booking-ops'

jest.setTimeout(240_000)

/** The Urgent badge on list rows (ADR 0039, Phase 6F): the operations queue's own verdict, only for callers who can see the queue, and a visible "unavailable" when it cannot be evaluated. */
describe('Booking list urgency (PostgreSQL, HTTP, strict roles)', () => {
  const owner = new PrismaClient()
  const suffix = `bu-${Date.now()}-${randomBytes(3).toString('hex')}`
  const password = 'booking-urgency-certification-password'
  const runtimePassword = `rt-${randomBytes(20).toString('hex')}`
  const origin = 'http://localhost:3001'
  let app: INestApplication; let previousUrl: string | undefined; let restoreOps: () => void = () => undefined; let restoreFlags: () => void = () => undefined
  let tenantA = '', hotelA = '', unknownId = '', pendingId = '', settledId = '', lead = ''
  const cookies: Record<string, string> = {}; const all: string[] = []; let n = 0
  const ago = (min: number) => new Date(Date.now() - min * 60_000)

  async function user(label: string, keys: string[]) {
    const u = await owner.user.create({ data: { email: `${suffix}-${label}@example.test`.toLowerCase(), name: `User ${label}`, passwordHash: await hashPassword(password), status: 'ACTIVE' } }); all.push(u.id)
    await owner.membership.create({ data: { tenantId: tenantA, userId: u.id, role: 'agent' } })
    const r = await owner.role.create({ data: { tenantId: tenantA, name: `${suffix}-${label}` } })
    for (const key of keys) { const p = await owner.permission.upsert({ where: { key }, update: {}, create: { key, description: key } }); await owner.rolePermission.create({ data: { roleId: r.id, permissionId: p.id } }) }
    await owner.userRole.create({ data: { tenantId: tenantA, userId: u.id, roleId: r.id } })
    return u.id
  }
  async function booking(o: { status: string; supplierRef: string | null; supplierStatus?: string; unknown?: boolean }) {
    n += 1
    const b = await owner.booking.create({ data: { tenantId: tenantA, reference: `FB-${randomBytes(10).toString('hex').toUpperCase()}`, supplier: 'Acme Hotels', hotelId: hotelA, status: o.status as never, currency: 'AED', totalMinor: 100_000n, idempotencyKey: `${suffix}-${n}`, searchSnapshot: {}, supplierRef: o.supplierRef, supplierStatus: o.supplierStatus ?? null, createdAt: ago(200), hotelConfirmationNo: o.supplierRef ? `H-${n}` : null } })
    await owner.bookingEvent.create({ data: { tenantId: tenantA, bookingId: b.id, toStatus: o.status as never, actorType: 'SYSTEM', reason: 'fixture', payload: { backfill: true }, createdAt: ago(200) } })
    if (o.unknown) {
      await owner.bookingEvent.create({ data: { tenantId: tenantA, bookingId: b.id, fromStatus: o.status as never, toStatus: o.status as never, actorType: 'SUPPLIER', action: 'supplierUnknown', payload: {}, createdAt: ago(60) } })
      await owner.bookingSupplierJob.create({ data: { tenantId: tenantA, bookingId: b.id, kind: 'BOOK', status: 'UNKNOWN', attempt: 1, runAfter: ago(60), requestedByUserId: lead, idempotencyKey: `fx-${randomBytes(6).toString('hex')}`, requestFingerprint: randomBytes(32).toString('hex'), lastErrorCode: 'SUPPLIER_UNREACHABLE' } as never })
    }
    return b.id
  }
  const list = (who: string) => request(app.getHttpServer()).get('/api/v1/admin/operations/bookings?chip=latest&pageSize=100').set('Cookie', cookies[who])
  const page = async (who: string): Promise<BookingListPage> => (await list(who).expect(200)).body.data
  const row = (p: BookingListPage, id: string) => p.items.find((i) => i.id === id)!

  beforeAll(async () => {
    await owner.$connect()
    tenantA = (await owner.tenant.create({ data: { name: suffix, slug: suffix } })).id
    hotelA = (await owner.hotel.create({ data: { tenantId: tenantA, name: `${suffix} A`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', timeZone: 'Asia/Dubai' } })).id
    lead = await user('lead', ['booking.read', 'booking.ops.view'])
    await user('plain', ['booking.read'])
    unknownId = await booking({ status: 'PENDING_SUPPLIER', supplierRef: null, supplierStatus: 'UNKNOWN', unknown: true })
    pendingId = await booking({ status: 'PENDING_SUPPLIER', supplierRef: null })
    settledId = await booking({ status: 'CONFIRMED', supplierRef: 'SUP-1' })
    const prevOps = process.env.ADMIN_BOOKING_OPS_ENABLED; const prevSla = process.env.BOOKING_OPS_SLA_POLICY
    process.env.ADMIN_BOOKING_OPS_ENABLED = 'true'; delete process.env.BOOKING_OPS_SLA_POLICY
    restoreFlags = () => { for (const [k, v] of [['ADMIN_BOOKING_OPS_ENABLED', prevOps], ['BOOKING_OPS_SLA_POLICY', prevSla]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
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
    for (const label of ['lead', 'plain']) {
      const r = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', origin).send({ email: `${suffix}-${label}@example.test`.toLowerCase(), password }); if (r.status !== 200) throw new Error(`login ${label} ${r.status}`)
      cookies[label] = (r.headers['set-cookie'][0] as string).split(';')[0]
    }
  })
  afterAll(async () => {
    await app?.close(); restoreOps(); restoreFlags()
    if (previousUrl) process.env.DATABASE_URL = previousUrl
    for (const q of [`DELETE FROM "AuditEvent" WHERE tenant_id = '${tenantA}'`, `DELETE FROM "Booking" WHERE tenant_id = '${tenantA}'`, `DELETE FROM "Hotel" WHERE tenant_id = '${tenantA}'`, `DELETE FROM "UserRole" WHERE tenant_id = '${tenantA}'`,
      `DELETE FROM "RolePermission" WHERE role_id IN (SELECT id FROM "Role" WHERE tenant_id = '${tenantA}')`, `DELETE FROM "Role" WHERE tenant_id = '${tenantA}'`, `DELETE FROM memberships WHERE tenant_id = '${tenantA}'`]) await owner.$executeRawUnsafe(q).catch(() => undefined)
    await owner.session.deleteMany({ where: { userId: { in: all } } }); await owner.user.deleteMany({ where: { id: { in: all } } }); await owner.tenant.deleteMany({ where: { id: tenantA } }); await owner.$disconnect()
  })

  it('BUE-01: a caller who can see the queue gets the queue\'s verdict per row: Urgent/Critical for an unknown supplier answer, a case but not urgent for a plain pending booking, not a case when settled', async () => {
    const p = await page('lead')
    expect(p.urgencyAvailable).toBe(true)
    expect(['URGENT', 'CRITICAL']).toContain(row(p, unknownId).urgency?.priority)
    expect(row(p, unknownId).urgency).toMatchObject({ inQueue: true, primaryReason: 'SUPPLIER_UNKNOWN' })
    expect(row(p, pendingId).urgency).toMatchObject({ inQueue: true, priority: expect.stringMatching(/NORMAL|HIGH/) })
    expect(row(p, settledId).urgency).toMatchObject({ inQueue: false })
  })

  it('BUE-02: a caller without booking.ops.view gets no urgency at all (not "false", not a flag): the field and the availability marker are absent', async () => {
    const p = await page('plain')
    expect(p.urgencyAvailable).toBeUndefined()
    for (const i of p.items) expect('urgency' in i).toBe(false)
  })

  it('BUE-03: an invalid SLA policy does not break the list: it answers 200, says urgency is unavailable, and shows no urgency rather than "not urgent"', async () => {
    process.env.BOOKING_OPS_SLA_POLICY = '{not json'
    try {
      const p = await page('lead')
      expect(p.urgencyAvailable).toBe(false)
      for (const i of p.items) expect('urgency' in i).toBe(false)
      expect(p.items.length).toBeGreaterThanOrEqual(3)
    } finally { delete process.env.BOOKING_OPS_SLA_POLICY }
    expect((await page('lead')).urgencyAvailable).toBe(true)
  })

  it('BUE-04: with the queue switched off nobody gets urgency, whatever their permissions', async () => {
    process.env.ADMIN_BOOKING_OPS_ENABLED = 'false'
    try { const p = await page('lead'); expect(p.urgencyAvailable).toBeUndefined(); for (const i of p.items) expect('urgency' in i).toBe(false) } finally { process.env.ADMIN_BOOKING_OPS_ENABLED = 'true' }
  })
})
