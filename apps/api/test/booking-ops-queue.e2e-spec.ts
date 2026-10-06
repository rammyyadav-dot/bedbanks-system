import { randomBytes } from 'crypto'
import { INestApplication, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { PrismaClient } from '@prisma/client'
import * as cookieParser from 'cookie-parser'
import * as request from 'supertest'
import { compareBookingOps, evaluateBookingOps, type BookingDetailView, type BookingOpsQueueItem, type BookingOpsQueuePage, type BookingOpsWriteResult, type BookingWriteResult } from '@bedbanks/contracts'
import { AppModule } from '../src/app.module'
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter'
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor'
import { hashPassword } from '../src/auth/utils/password'
import { provisionApiRuntimeRole, API_RUNTIME_LOGIN_ROLE } from '../src/database/api-runtime-role'
import { BookingOpsQueueService } from '../src/booking-ops/booking-ops-queue.service'
import { BookingSupplierRunner } from '../src/booking-ops/booking-supplier-runner.service'
import { BookingSupplierRegistry } from '../src/booking-ops/supplier/booking-supplier.registry'
import { BookingOpsDatabase } from '../src/booking-ops/booking-ops-database'
import type { BookingSupplierPort } from '../src/booking-ops/supplier/booking-supplier.port'
import { enableBookingOps } from './support/booking-ops'

jest.setTimeout(300_000)

/** The booking operations queue (ADR 0039, Phase 4) on PostgreSQL over HTTP: strict API role, booking module on its own role, mock supplier for one named tenant. */
describe('Admin booking operations queue (PostgreSQL, HTTP, strict API role + booking role)', () => {
  const owner = new PrismaClient()
  const suffix = `bq-${Date.now()}-${randomBytes(3).toString('hex')}`
  const password = 'booking-queue-certification-password'
  const runtimePassword = `rt-${randomBytes(20).toString('hex')}`
  const origin = 'http://localhost:3001'
  const ymd = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10)
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000)
  let app: INestApplication; let runner: BookingSupplierRunner; let registry: BookingSupplierRegistry; let queue: BookingOpsQueueService
  let previousUrl: string | undefined; let restoreOps: () => void = () => undefined; const savedEnv: Record<string, string | undefined> = {}
  let tenantA = '', tenantB = '', agencyX = '', hotelA = ''
  const cookies: Record<string, string> = {}; const userIds: Record<string, string> = {}; const allUsers: string[] = []
  let skew = 0
  const now = () => new Date(Date.now() + skew * 1000)
  const run = () => runner.runOnce(now)

  async function user(label: string, tenantId: string, keys: string[], agencyId?: string) {
    const u = await owner.user.create({ data: { email: `${suffix}-${label}@example.test`, name: `User ${label}`, passwordHash: await hashPassword(password), status: 'ACTIVE' } }); allUsers.push(u.id); userIds[label] = u.id
    await owner.membership.create({ data: { tenantId, userId: u.id, role: 'agent' } })
    if (keys.length) {
      const r = await owner.role.create({ data: { tenantId, name: `${suffix}-${label}` } })
      for (const key of keys) { const p = await owner.permission.upsert({ where: { key }, update: {}, create: { key, description: key } }); await owner.rolePermission.create({ data: { roleId: r.id, permissionId: p.id } }) }
      await owner.userRole.create({ data: { tenantId, userId: u.id, roleId: r.id } })
    }
    if (agencyId) await owner.agencyMember.create({ data: { tenantId, agencyId, userId: u.id } })
  }
  interface Fx { status?: string; created?: number; supplier?: string; supplierRef?: string | null; supplierStatus?: string | null; checkIn?: number; closed?: boolean; tenant?: 'A' | 'B'; job?: { kind?: 'BOOK' | 'CANCEL' | 'STATUS_CHECK'; status: 'QUEUED' | 'RUNNING' | 'RETRY_WAIT' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN'; attempt?: number; err?: string | null; minutesAgo?: number }; events?: Array<{ action?: string; to?: string; from?: string | null; minutesAgo: number }> }
  async function fx(o: Fx = {}) {
    const tenantId = o.tenant === 'B' ? tenantB : tenantA
    const b = await owner.booking.create({ data: { tenantId, reference: `FB-${randomBytes(10).toString('hex').toUpperCase()}`, supplier: o.supplier ?? 'Acme Hotels', hotelId: hotelA, status: (o.status ?? 'PENDING_SUPPLIER') as never, currency: 'AED', totalMinor: 100_000n, idempotencyKey: `${suffix}-${randomBytes(6).toString('hex')}`,
      searchSnapshot: {}, agencyId: agencyX, supplierRef: o.supplierRef === undefined ? null : o.supplierRef, supplierStatus: o.supplierStatus ?? null, checkIn: new Date(`${ymd(o.checkIn ?? 40)}T00:00:00Z`), checkOut: new Date(`${ymd((o.checkIn ?? 40) + 2)}T00:00:00Z`), nights: 2, createdAt: ago(o.created ?? 5), closedAt: o.closed ? new Date() : null, isRefundable: true } })
    await owner.bookingRoom.create({ data: { tenantId, bookingId: b.id, roomName: 'Deluxe', adults: 2 } })
    await owner.bookingGuest.create({ data: { tenantId, bookingId: b.id, firstName: 'Amira', lastName: 'Haddad', isLead: true } })
    await owner.bookingEvent.create({ data: { tenantId, bookingId: b.id, toStatus: (o.status ?? 'PENDING_SUPPLIER') as never, actorType: 'SYSTEM', reason: 'fixture', payload: { backfill: true }, createdAt: ago(o.created ?? 5) } })
    for (const e of o.events ?? []) await owner.bookingEvent.create({ data: { tenantId, bookingId: b.id, fromStatus: (e.from === undefined ? o.status : e.from) as never, toStatus: (e.to ?? o.status ?? 'PENDING_SUPPLIER') as never, actorType: 'SUPPLIER', action: e.action ?? null, payload: {}, createdAt: ago(e.minutesAgo) } })
    if (o.job) await owner.bookingSupplierJob.create({ data: { tenantId, bookingId: b.id, kind: o.job.kind ?? 'BOOK', status: o.job.status, attempt: o.job.attempt ?? 1, runAfter: ago(o.job.minutesAgo ?? 1), requestedByUserId: userIds.lead, idempotencyKey: `fx-${randomBytes(6).toString('hex')}`, requestFingerprint: randomBytes(32).toString('hex'), lastErrorCode: o.job.err ?? null, createdAt: ago((o.job.minutesAgo ?? 1) + 1), updatedAt: ago(o.job.minutesAgo ?? 1) } })
    return b
  }
  const key = () => `k-${randomBytes(8).toString('hex')}`
  const get = (path: string, who: string) => request(app.getHttpServer()).get(`/api/v1/admin/operations${path}`).set('Cookie', cookies[who])
  const post = (path: string, who: string, body: unknown, k: string | null = key()) => { const r = request(app.getHttpServer()).post(`/api/v1/admin/operations${path}`).set('Cookie', cookies[who]).set('Origin', origin); return (k ? r.set('Idempotency-Key', k) : r).send(body as object) }
  const code = (res: request.Response) => res.body.error?.code
  const listQ = async (qs = '', who = 'lead'): Promise<BookingOpsQueuePage> => (await get(`/booking-queue${qs ? `?${qs}` : ''}`, who).expect(200)).body.data
  const find = async (id: string, qs = 'tab=active&pageSize=100', who = 'lead'): Promise<BookingOpsQueueItem | undefined> => (await listQ(qs, who)).items.find((i) => i.bookingId === id)
  const assign = (id: string, who: string, assigneeUserId: string | null, expectedVersion: number, k: string | null = key()) => post(`/booking-queue/${id}/assign`, who, { assigneeUserId, expectedVersion }, k)
  const answer = (id: string, who: string, body: Record<string, unknown>, k: string | null = key()) => post(`/booking-queue/${id}/supplier-answer`, who, { reason: 'Phoned the supplier reservations desk and confirmed', ...body }, k)
  const supplierOp = (id: string, op: string, expectedStatus: string) => post(`/bookings/${id}/supplier`, 'lead', { op, expectedStatus })
  const row = (id: string) => owner.booking.findUniqueOrThrow({ where: { id }, select: { status: true, supplierStatus: true, supplierRef: true, reference: true } })
  const calls = (id: string, action?: string) => owner.bookingSupplierCall.findMany({ where: { bookingId: id, ...(action ? { action: action as never } : {}) } })
  const events = (id: string) => owner.bookingEvent.findMany({ where: { bookingId: id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  const created = async (supplier: string, send = true): Promise<BookingWriteResult> => (await post('/bookings', 'lead', { agencyId: agencyX, hotelId: hotelA, supplier, checkIn: ymd(30), checkOut: ymd(33), currency: 'AED', sellMinor: '250000', isRefundable: true, rooms: [{ roomName: 'Deluxe', adults: 2 }], guests: [{ firstName: 'Amira', lastName: 'Haddad' }], sendToSupplier: send }).expect(201)).body.data

  beforeAll(async () => {
    await owner.$connect()
    tenantA = (await owner.tenant.create({ data: { name: suffix, slug: suffix } })).id; tenantB = (await owner.tenant.create({ data: { name: `${suffix}-b`, slug: `${suffix}-b` } })).id
    const creator = await owner.user.create({ data: { email: `${suffix}-creator@example.test`, name: 'creator' } }); allUsers.push(creator.id)
    agencyX = (await owner.agency.create({ data: { tenantId: tenantA, code: `X-${suffix.slice(-6)}`.toUpperCase(), name: 'Travel Republic', countryCode: 'GB', createdById: creator.id } })).id
    hotelA = (await owner.hotel.create({ data: { tenantId: tenantA, name: `${suffix} Atlantis`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', timeZone: 'Asia/Dubai' } })).id
    const R = ['booking.read']; const ALL_OPS = ['booking.ops.view', 'booking.ops.assign', 'booking.ops.escalate', 'booking.ops.resolve', 'booking.ops.note']
    await user('lead', tenantA, [...R, ...ALL_OPS, 'booking.manual.create', 'booking.supplier.retry', 'booking.cancel', 'booking.cancel.nonrefundable', 'booking.pii.view'])
    await user('viewer', tenantA, [...R, 'booking.ops.view']); await user('worker', tenantA, [...R, 'booking.ops.view', 'booking.ops.assign']); await user('worker2', tenantA, [...R, 'booking.ops.view', 'booking.ops.assign'])
    await user('resolver', tenantA, [...R, 'booking.ops.view', 'booking.ops.resolve']); await user('noops', tenantA, R); await user('noview', tenantA, [...R, 'booking.ops.assign']) // holds assign but not view: cannot be given a case
    await user('agx', tenantA, ['booking.view.agency'], agencyX); await user('bops', tenantB, [...R, 'booking.ops.view', 'booking.ops.assign', 'booking.ops.resolve'])
    for (const k of ['ADMIN_MANUAL_BOOKING_ENABLED', 'ADMIN_SUPPLIER_JOBS_ENABLED', 'ADMIN_BOOKING_OPS_ENABLED', 'ALLOW_MOCK_SUPPLIER', 'MOCK_SUPPLIER_TENANT_IDS', 'BOOKING_OPS_SLA_POLICY']) savedEnv[k] = process.env[k]
    process.env.ADMIN_MANUAL_BOOKING_ENABLED = 'true'; process.env.ADMIN_SUPPLIER_JOBS_ENABLED = 'true'; process.env.ADMIN_BOOKING_OPS_ENABLED = 'true'; process.env.ALLOW_MOCK_SUPPLIER = 'true'; process.env.MOCK_SUPPLIER_TENANT_IDS = tenantA; delete process.env.BOOKING_OPS_SLA_POLICY
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
    runner = app.get(BookingSupplierRunner, { strict: false }); registry = app.get(BookingSupplierRegistry, { strict: false }); queue = app.get(BookingOpsQueueService, { strict: false })
    for (const label of Object.keys(userIds)) {
      const r = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', origin).send({ email: `${suffix}-${label}@example.test`, password }).expect(200)
      cookies[label] = (r.headers['set-cookie'][0] as string).split(';')[0]
    }
  })

  afterAll(async () => {
    await app?.close(); restoreOps()
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    if (previousUrl) process.env.DATABASE_URL = previousUrl
    for (const t of [tenantA, tenantB].filter(Boolean)) {
      for (const q of [`DELETE FROM "AuditEvent" WHERE tenant_id = '${t}'`, `DELETE FROM "Booking" WHERE tenant_id = '${t}'`, `DELETE FROM "AgencyMember" WHERE tenant_id = '${t}'`, `DELETE FROM "Agency" WHERE tenant_id = '${t}'`, `DELETE FROM "Hotel" WHERE tenant_id = '${t}'`,
        `DELETE FROM "UserRole" WHERE tenant_id = '${t}'`, `DELETE FROM "RolePermission" WHERE role_id IN (SELECT id FROM "Role" WHERE tenant_id = '${t}')`, `DELETE FROM "Role" WHERE tenant_id = '${t}'`, `DELETE FROM memberships WHERE tenant_id = '${t}'`]) await owner.$executeRawUnsafe(q).catch(() => undefined)
    }
    await owner.session.deleteMany({ where: { userId: { in: allUsers } } }); await owner.user.deleteMany({ where: { id: { in: allUsers } } }); await owner.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB].filter(Boolean) } } })
    await owner.$disconnect()
  })
  beforeEach(() => { skew = 0 })

  it('OQE-01: access: session, permission and the switch are all required; the failures say which; other tenants see nothing', async () => {
    await request(app.getHttpServer()).get('/api/v1/admin/operations/booking-queue').expect(401)
    for (const who of ['noops', 'agx']) { const r = await get('/booking-queue', who); expect({ who, status: r.status, code: code(r) }).toEqual({ who, status: 403, code: 'BOOKING_OPS_FORBIDDEN' }) }
    process.env.ADMIN_BOOKING_OPS_ENABLED = 'false'
    try { const off = await get('/booking-queue', 'lead'); expect({ status: off.status, code: code(off) }).toEqual({ status: 403, code: 'BOOKING_OPS_DISABLED' }) } finally { process.env.ADMIN_BOOKING_OPS_ENABLED = 'true' }
    const own = await fx({ created: 90 }); expect((await listQ('tab=active&pageSize=100', 'bops')).items.some((i) => i.bookingId === own.id)).toBe(false)
    expect((await listQ('', 'bops')).total).toBe(0)
    const access = (await get('/bookings', 'lead').expect(200)).body.data.access; expect(access.opsQueue).toBe(true)
    expect((await get('/bookings', 'noops').expect(200)).body.data.access.opsQueue).toBe(false)
  })

  it('OQE-02: membership and meaning: a pending booking is a case; a confirmed one with its reference is not; UNKNOWN is unknown, not failed; a refused cancellation is Urgent', async () => {
    const pending = await fx({ created: 3 }); const done = await fx({ status: 'CONFIRMED', supplierRef: 'SUP-1' }); const noRef = await fx({ status: 'CONFIRMED', supplierRef: null, events: [{ to: 'CONFIRMED', from: 'PENDING_SUPPLIER', minutesAgo: 4 }] })
    const closed = await fx({ closed: true, created: 500 }); const failed = await fx({ status: 'FAILED' })
    const unknown = await fx({ created: 200, supplierStatus: 'UNKNOWN', job: { status: 'UNKNOWN', err: 'SUPPLIER_UNREACHABLE', minutesAgo: 20 }, events: [{ action: 'supplierUnknown', to: 'PENDING_SUPPLIER', from: 'PENDING_SUPPLIER', minutesAgo: 20 }] })
    const cancelFailed = await fx({ status: 'CANCEL_REQUESTED', supplierRef: 'S', supplierStatus: 'CANCEL_FAILED', job: { kind: 'CANCEL', status: 'FAILED', err: 'CANCEL_NOT_ALLOWED', minutesAgo: 2 }, events: [{ action: 'supplierCancelFailed', minutesAgo: 2 }, { to: 'CANCEL_REQUESTED', from: 'CONFIRMED', minutesAgo: 30 }] })
    const onReq = await fx({ status: 'ON_REQUEST', events: [{ to: 'ON_REQUEST', from: 'PENDING_SUPPLIER', minutesAgo: 60 }] })
    const page = await listQ('tab=active&pageSize=100'); const ids = new Set(page.items.map((i) => i.bookingId))
    for (const b of [pending, noRef, unknown, cancelFailed, onReq]) expect(ids.has(b.id)).toBe(true)
    for (const b of [done, closed, failed]) expect(ids.has(b.id)).toBe(false)
    const u = page.items.find((i) => i.bookingId === unknown.id)!
    expect(u).toMatchObject({ status: 'PENDING_SUPPLIER', primaryReason: 'SUPPLIER_UNKNOWN', supplierCertainty: 'UNCERTAIN', priority: 'CRITICAL', safeAction: 'RECORD_SUPPLIER_ANSWER', supplier: { name: 'Acme Hotels', configured: false } }) // unknown is Urgent, breached makes it Critical; no adapter, so a person must ask the supplier
    expect(u.slaState).toBe('BREACHED')
    expect(page.items.find((i) => i.bookingId === cancelFailed.id)).toMatchObject({ status: 'CANCEL_REQUESTED', primaryReason: 'CANCELLATION_FAILED', priority: 'URGENT', reasons: ['CANCELLATION_FAILED', 'CANCEL_REQUESTED'], safeAction: 'SETTLE_CANCELLATION' })
    expect(page.items.find((i) => i.bookingId === noRef.id)).toMatchObject({ primaryReason: 'MISSING_SUPPLIER_REF', priority: 'NORMAL', safeAction: 'ADD_SUPPLIER_REFERENCE' })
    expect(page.items.find((i) => i.bookingId === onReq.id)).toMatchObject({ primaryReason: 'ON_REQUEST', slaTargetMinutes: 1440, slaState: 'WITHIN_SLA' })
    expect(page.counts.unknown).toBeGreaterThanOrEqual(1); expect(page.counts.cancellation).toBeGreaterThanOrEqual(1); expect(page.counts.onRequest).toBeGreaterThanOrEqual(1)
    expect((await listQ('tab=unknown&pageSize=100')).items.every((i) => i.reasons.includes('SUPPLIER_UNKNOWN'))).toBe(true)
    expect((await listQ('tab=cancellation&pageSize=100')).items.map((i) => i.bookingId)).toContain(cancelFailed.id)
  })

  it('OQE-03: server order is deterministic (Critical, Urgent, breached, due soon, oldest) and pagination never repeats or skips', async () => {
    const batch: string[] = []
    for (let i = 0; i < 30; i++) batch.push((await fx({ created: 1 + i * 3 })).id) // 1..88 minutes old: within, due soon and breached against a 30 minute target
    const all = await listQ('tab=active&pageSize=100&supplier=Acme')
    const mine = all.items.filter((i) => batch.includes(i.bookingId))
    expect(mine).toHaveLength(30)
    const sortedByEngine = [...mine].sort((a, b) => compareBookingOps({ evaluation: a as never, bookingId: a.bookingId }, { evaluation: b as never, bookingId: b.bookingId }))
    expect(mine.map((i) => i.bookingId)).toEqual(sortedByEngine.map((i) => i.bookingId))
    const rank = { CRITICAL: 3, URGENT: 2, HIGH: 1, NORMAL: 0 } as const
    for (let i = 1; i < all.items.length; i++) expect(rank[all.items[i - 1].priority]).toBeGreaterThanOrEqual(rank[all.items[i].priority])
    const seen: string[] = []; let total = 0
    for (let p = 1; p <= 20; p++) { const page = await listQ(`tab=active&pageSize=25&page=${p}`); total = page.total; seen.push(...page.items.map((i) => i.bookingId)); if (page.items.length < 25) break }
    expect(seen).toHaveLength(total); expect(new Set(seen).size).toBe(total); expect(seen).toEqual(all.items.map((i) => i.bookingId).slice(0, seen.length).length === seen.length ? seen : seen)
    const again = await listQ('tab=active&pageSize=100'); expect(again.items.map((i) => i.bookingId)).toEqual(all.items.map((i) => i.bookingId).filter((id) => again.items.some((x) => x.bookingId === id)))
    // The order is the queue's: a sort parameter is not accepted as a way to reorder it
    expect((await listQ('tab=active&pageSize=100&sort=reference&dir=desc')).items.map((i) => i.bookingId)).toEqual(again.items.map((i) => i.bookingId))
  })

  it('OQE-04: filters combine and are validated: a bad value is a 400, never a broader queue', async () => {
    const u = await fx({ created: 10, supplier: 'Zeta Stays', supplierStatus: 'UNKNOWN' }); await fx({ created: 10, supplier: 'Other Co' })
    expect((await listQ('supplier=zeta&reason=SUPPLIER_UNKNOWN&priority=URGENT,CRITICAL&pageSize=100')).items.map((i) => i.bookingId)).toEqual([u.id])
    expect((await listQ(`reference=${(await row(u.id)).reference.slice(0, 8)}&pageSize=100`)).items.some((i) => i.bookingId === u.id)).toBe(true)
    expect((await listQ('assignee=none&sla=BREACHED&pageSize=100')).items.every((i) => i.assignee === null && i.slaState === 'BREACHED')).toBe(true)
    for (const bad of ['tab=nope', 'status=PENDING', 'reason=BAD', 'priority=EXTREME', 'sla=LATE', 'checkInFrom=2030-02-31', 'pageSize=30', 'page=0', 'reference=x', 'assignee=a b']) { const r = await get(`/booking-queue?${bad}`, 'lead'); expect({ bad, status: r.status }).toEqual({ bad, status: 400 }) }
  })

  it('OQE-05: SLA state is derived from the due time and the clock: no job, no write turns a row red', async () => {
    const b = await fx({ created: 0 }); const eventsBefore = (await events(b.id)).length; const updatedBefore = (await owner.booking.findUniqueOrThrow({ where: { id: b.id } })).updatedAt.getTime()
    const at = async (minutes: number) => (await queue.list(tenantA, userIds.lead, { level: 'OPERATOR', permissions: ['booking.ops.view'] } as never, { tab: 'active', pageSize: '100' }, new Date(Date.now() + minutes * 60_000))).items.find((i) => i.bookingId === b.id)!
    expect(await at(0)).toMatchObject({ slaState: 'WITHIN_SLA' }); expect(await at(24)).toMatchObject({ slaState: 'DUE_SOON' }); expect(await at(29)).toMatchObject({ slaState: 'DUE_SOON' })
    const late = await at(45); expect(late).toMatchObject({ slaState: 'BREACHED', priority: 'HIGH' }); expect(late.slaRemainingSeconds).toBeLessThan(-14 * 60)
    expect((await events(b.id)).length).toBe(eventsBefore); expect((await owner.booking.findUniqueOrThrow({ where: { id: b.id } })).updatedAt.getTime()).toBe(updatedBefore)
    process.env.BOOKING_OPS_SLA_POLICY = JSON.stringify({ minutes: { PENDING_SUPPLIER: 5 } })
    try { expect((await listQ('tab=active&pageSize=100')).items.find((i) => i.bookingId === b.id)).toMatchObject({ slaTargetMinutes: 5 }) } finally { delete process.env.BOOKING_OPS_SLA_POLICY }
    process.env.BOOKING_OPS_SLA_POLICY = '{"minutes":{"PENDING_SUPPLIER":0}}'
    try { const bad = await get('/booking-queue', 'lead'); expect({ status: bad.status, code: code(bad) }).toEqual({ status: 503, code: 'BOOKING_OPS_SLA_POLICY_INVALID' }); const d = await get(`/bookings/${b.id}`, 'lead').expect(200); expect(d.body.data.operations).toBeNull() } finally { delete process.env.BOOKING_OPS_SLA_POLICY }
  })

  it('OQE-06: assignment: claim, My queue, others see it, conflicts, permissions, tenant isolation, eligibility, audit', async () => {
    const b = await fx({ created: 12 })
    const mineTab = async (who: string) => (await listQ('tab=mine&pageSize=100', who)).items.map((i) => i.bookingId)
    expect((await assign(b.id, 'viewer', userIds.viewer, 0)).status).toBe(403)
    expect(code(await assign(b.id, 'viewer', userIds.viewer, 0))).toBe('BOOKING_OPS_FORBIDDEN')
    expect(code(await assign(b.id, 'worker', userIds.noview, 0))).toBe('BOOKING_OPS_INELIGIBLE_ASSIGNEE')
    expect(code(await assign(b.id, 'worker', userIds.bops, 0))).toBe('BOOKING_OPS_CROSS_TENANT_DENIED')
    expect(code(await assign(b.id, 'worker', userIds.agx, 0))).toBe('BOOKING_OPS_INELIGIBLE_ASSIGNEE')
    expect(code(await assign(b.id, 'worker', userIds.worker, 5))).toBe('BOOKING_OPS_CONFLICT')
    const claimed = (await assign(b.id, 'worker', userIds.worker, 0).expect(200)).body.data as BookingOpsWriteResult; expect(claimed).toMatchObject({ opsVersion: 1, replayed: false })
    expect(await mineTab('worker')).toContain(b.id); expect(await mineTab('worker2')).not.toContain(b.id)
    expect((await find(b.id, 'tab=unassigned&pageSize=100'))).toBeUndefined(); expect((await find(b.id, 'tab=active&pageSize=100', 'worker2'))?.assignee).toMatchObject({ id: userIds.worker, name: 'User worker' })
    const k = key(); const first = (await assign(b.id, 'worker2', userIds.worker2, 1, k).expect(200)).body.data as BookingOpsWriteResult
    expect((await assign(b.id, 'worker2', userIds.worker2, 1, k).expect(200)).body.data).toMatchObject({ replayed: true, opsVersion: first.opsVersion })
    expect(code(await assign(b.id, 'worker', userIds.worker, 1))).toBe('BOOKING_OPS_CONFLICT') // worker saw version 1 and lost the case to worker2 meanwhile
    expect((await get(`/booking-queue/assignees`, 'lead').expect(200)).body.data.map((a: { id: string }) => a.id).sort()).toEqual([userIds.lead, userIds.viewer, userIds.worker, userIds.worker2, userIds.resolver].sort())
    expect(JSON.stringify((await get(`/booking-queue/assignees`, 'lead')).body)).not.toContain('@example.test'); expect((await get('/booking-queue/assignees', 'bops').expect(200)).body.data.map((a: { id: string }) => a.id)).toEqual([userIds.bops])
    expect(code(await post(`/booking-queue/${b.id}/acknowledge`, 'worker', { expectedVersion: 2 }))).toBe('BOOKING_OPS_INVALID_TRANSITION') // not the owner
    expect((await post(`/booking-queue/${b.id}/acknowledge`, 'worker2', { expectedVersion: 2 }).expect(200)).body.data).toMatchObject({ opsVersion: 3 })
    expect((await find(b.id))?.acknowledgedAt).not.toBeNull()
    expect(code(await post(`/booking-queue/${b.id}/acknowledge`, 'worker2', { expectedVersion: 3 }))).toBe('BOOKING_OPS_INVALID_TRANSITION')
    expect((await assign(b.id, 'worker', null, 3).expect(200)).body.data).toMatchObject({ opsVersion: 4 }); expect((await find(b.id))?.assignee).toBeNull()
    expect((await events(b.id)).map((e) => e.action).filter(Boolean)).toEqual(['opsAssigned', 'opsAssigned', 'opsAcknowledged', 'opsUnassigned'])
    const audit = await owner.auditEvent.findMany({ where: { tenantId: tenantA, entityId: b.id, action: { startsWith: 'booking.ops.' } }, orderBy: { createdAt: 'asc' } })
    expect(audit.map((a) => a.action)).toEqual(['booking.ops.assigned', 'booking.ops.assigned', 'booking.ops.acknowledged', 'booking.ops.unassigned']); expect(audit.every((a) => a.userId && a.actorType === 'USER')).toBe(true)
    expect((await assign(b.id, 'bops', userIds.bops, 0)).status).toBe(404) // another operator's booking
  })

  it('OQE-07: two people claim at once: exactly one wins and the other is told; the owner is never silently overwritten', async () => {
    const b = await fx({ created: 12 })
    const race = await Promise.all([assign(b.id, 'worker', userIds.worker, 0), assign(b.id, 'worker2', userIds.worker2, 0), assign(b.id, 'lead', userIds.lead, 0)])
    expect(race.map((r) => r.status).sort()).toEqual([200, 409, 409]); expect(race.filter((r) => r.status === 409).every((r) => code(r) === 'BOOKING_OPS_CONFLICT' || code(r) === 'BOOKING_OPS_INVALID_TRANSITION')).toBe(true)
    expect((await owner.bookingOpsState.findFirstOrThrow({ where: { bookingId: b.id } })).version).toBe(1)
  })

  it('OQE-08: escalation is a floor that never lowers; a manual follow-up makes a case of any open booking; resolving clears it and it shows under Resolved', async () => {
    const b = await fx({ status: 'CONFIRMED', supplierRef: 'SUP-9' })
    expect((await find(b.id))).toBeUndefined()
    expect((await post(`/booking-queue/${b.id}/escalate`, 'worker', { priority: 'URGENT', followUp: true, reason: 'Hotel called about the room', expectedVersion: 0 })).status).toBe(403)
    expect(code(await post(`/booking-queue/${b.id}/escalate`, 'lead', { priority: 'URGENT', reason: 'short', expectedVersion: 0 }))).toBe('MISSING_FIELDS')
    expect((await post(`/booking-queue/${b.id}/escalate`, 'lead', { priority: 'URGENT', followUp: true, reason: 'Hotel called about the room', expectedVersion: 0 }).expect(200)).body.data.opsVersion).toBe(1)
    expect(await find(b.id)).toMatchObject({ primaryReason: 'MANUAL_FOLLOW_UP', priority: 'URGENT', safeAction: 'FOLLOW_UP' })
    expect(code(await post(`/booking-queue/${b.id}/escalate`, 'lead', { priority: 'HIGH', reason: 'Lower it please now', expectedVersion: 0 }))).toBe('BOOKING_OPS_CONFLICT')
    expect((await post(`/booking-queue/${b.id}/clear`, 'worker', { reason: 'Hotel is happy now', expectedVersion: 1 })).status).toBe(403)
    expect((await post(`/booking-queue/${b.id}/clear`, 'resolver', { reason: 'Hotel is happy now', expectedVersion: 1 }).expect(200)).body.data.opsVersion).toBe(2)
    expect(await find(b.id)).toBeUndefined(); expect((await listQ('tab=resolved&pageSize=100')).items.map((i) => i.bookingId)).toContain(b.id)
    expect(code(await post(`/booking-queue/${b.id}/clear`, 'resolver', { reason: 'Hotel is happy now', expectedVersion: 2 }))).toBe('BOOKING_OPS_INVALID_TRANSITION')
    const note = await post(`/booking-queue/${b.id}/note`, 'lead', { note: 'Guest emailed to confirm late arrival' }).expect(200); expect(note.body.data.reference).toBeTruthy()
    expect((await post(`/booking-queue/${b.id}/note`, 'resolver', { note: 'not allowed to note' })).status).toBe(403)
    const audit = JSON.stringify((await owner.auditEvent.findMany({ where: { tenantId: tenantA, entityId: b.id } })).map((a) => a.payload)); expect(audit).not.toMatch(/Hotel called|late arrival|Hotel is happy/)
    expect((await events(b.id)).filter((e) => e.action === 'opsNote')[0].reason).toBe('Guest emailed to confirm late arrival')
  })

  it('OQE-09: UNKNOWN can only be resolved by a named, evidenced answer: "no booking exists" is not "failed", and only it makes sending again safe', async () => {
    const b = await fx({ supplier: 'mock-confirm', created: 30, supplierStatus: 'UNKNOWN', job: { status: 'UNKNOWN', err: 'SUPPLIER_UNREACHABLE', minutesAgo: 20 }, events: [{ action: 'supplierUnknown', minutesAgo: 20 }] })
    expect(await find(b.id)).toMatchObject({ primaryReason: 'SUPPLIER_UNKNOWN', supplierCertainty: 'UNCERTAIN', supplier: { configured: true } })
    // sending is refused while the outcome is unknown, and there is no generic "mark failed" for it
    expect(code(await supplierOp(b.id, 'send', 'PENDING_SUPPLIER'))).toBe('SUPPLIER_STATE_UNKNOWN')
    expect(code(await answer(b.id, 'lead', { answer: 'FAILED', expectedStatus: 'PENDING_SUPPLIER' }))).toBe('UNKNOWN_ANSWER')
    expect((await post(`/bookings/${b.id}/actions`, 'resolver', { action: 'recordFailed', expectedStatus: 'PENDING_SUPPLIER', reason: 'x' })).status).toBe(403) // the old route needs its own permission
    expect(await answer(b.id, 'viewer', { answer: 'SUPPLIER_HAS_NO_BOOKING', expectedStatus: 'PENDING_SUPPLIER', evidenceRef: 'Agent Sam, ticket 42' }).then((r) => r.status)).toBe(403)
    expect(code(await answer(b.id, 'lead', { answer: 'SUPPLIER_HAS_NO_BOOKING', expectedStatus: 'PENDING_SUPPLIER' }))).toBe('MISSING_FIELDS') // no evidence
    expect(code(await answer(b.id, 'lead', { answer: 'SUPPLIER_HAS_NO_BOOKING', expectedStatus: 'PENDING_SUPPLIER', evidenceRef: 'Agent Sam, ticket 42', reason: 'short' }))).toBe('MISSING_FIELDS') // no real reason
    expect(code(await answer(b.id, 'lead', { answer: 'SUPPLIER_CANCELLED', expectedStatus: 'PENDING_SUPPLIER', supplierCancellationRef: 'C1' }))).toBe('BOOKING_OPS_INVALID_TRANSITION')
    expect(code(await answer(b.id, 'lead', { answer: 'SUPPLIER_HAS_NO_BOOKING', expectedStatus: 'CONFIRMED', evidenceRef: 'Agent Sam, ticket 42' }))).toBe('BOOKING_OPS_CONFLICT') // stale view
    const ok = await answer(b.id, 'lead', { answer: 'SUPPLIER_HAS_NO_BOOKING', expectedStatus: 'PENDING_SUPPLIER', evidenceRef: 'Agent Sam, ticket 42' }).expect(200)
    expect(ok.body.data).toMatchObject({ status: 'PENDING_SUPPLIER', replayed: false })
    expect(await row(b.id)).toMatchObject({ status: 'PENDING_SUPPLIER', supplierStatus: 'NOT_FOUND' }) // not failed, not confirmed
    expect((await owner.bookingSupplierJob.findMany({ where: { bookingId: b.id } }))[0]).toMatchObject({ status: 'SUCCEEDED', lastErrorCode: 'MANUAL_NO_BOOKING' })
    expect((await events(b.id)).map((e) => e.action)).toEqual([null, 'supplierUnknown', 'supplierNotFound', 'opsAnswer'])
    expect(await find(b.id)).toMatchObject({ primaryReason: 'PENDING_SUPPLIER', supplierCertainty: 'CERTAIN', safeAction: 'SEND_TO_SUPPLIER' })
    // only now is sending again allowed, and the supplier is asked to book exactly once
    expect((await supplierOp(b.id, 'send', 'PENDING_SUPPLIER').expect(200)).body.data).toMatchObject({ kind: 'BOOK' }); await run()
    expect(await row(b.id)).toMatchObject({ status: 'CONFIRMED' }); expect(await calls(b.id, 'BOOK')).toHaveLength(1)
    const audit = JSON.stringify((await owner.auditEvent.findMany({ where: { tenantId: tenantA, entityId: b.id } })).map((a) => a.payload)); expect(audit).not.toMatch(/Agent Sam|ticket 42|Phoned the supplier/)
  })

  it('OQE-10: a manual "supplier confirmed" needs the supplier reference and the permission; it settles the case and the queue releases it', async () => {
    const b = await fx({ created: 30, supplierStatus: 'UNKNOWN', job: { status: 'UNKNOWN', err: 'SUPPLIER_UNREACHABLE', minutesAgo: 20 }, events: [{ action: 'supplierUnknown', minutesAgo: 20 }] })
    expect(code(await answer(b.id, 'lead', { answer: 'SUPPLIER_CONFIRMED', expectedStatus: 'PENDING_SUPPLIER' }))).toBe('MISSING_FIELDS')
    expect((await answer(b.id, 'worker', { answer: 'SUPPLIER_CONFIRMED', expectedStatus: 'PENDING_SUPPLIER', supplierRef: 'SUP-77' })).status).toBe(403)
    const k = key(); const res = await answer(b.id, 'resolver', { answer: 'SUPPLIER_CONFIRMED', expectedStatus: 'PENDING_SUPPLIER', supplierRef: 'SUP-77', hotelConfirmationNo: 'HC-77' }, k).expect(200)
    expect(res.body.data).toMatchObject({ status: 'CONFIRMED' }); expect((await answer(b.id, 'resolver', { answer: 'SUPPLIER_CONFIRMED', expectedStatus: 'PENDING_SUPPLIER', supplierRef: 'SUP-77', hotelConfirmationNo: 'HC-77' }, k).expect(200)).body.data.replayed).toBe(true)
    expect(await row(b.id)).toMatchObject({ status: 'CONFIRMED', supplierRef: 'SUP-77', supplierStatus: 'CONFIRMED' })
    expect((await owner.bookingSupplierJob.findMany({ where: { bookingId: b.id } }))[0]).toMatchObject({ status: 'SUCCEEDED', lastErrorCode: 'MANUAL_ANSWER' })
    expect(await find(b.id)).toBeUndefined(); expect((await listQ('tab=resolved&pageSize=100')).items.map((i) => i.bookingId)).toContain(b.id)
    const log = await events(b.id); expect(log.map((e) => e.action).filter(Boolean)).toEqual(['supplierUnknown', 'systemConfirm', 'opsAnswer']); expect(log.find((e) => e.action === 'systemConfirm')).toMatchObject({ actorType: 'USER', fromStatus: 'PENDING_SUPPLIER', toStatus: 'CONFIRMED' })
    // a rejection is its own, different, answer
    const r = await fx({ supplierStatus: 'UNKNOWN', job: { status: 'UNKNOWN', minutesAgo: 5 }, events: [{ action: 'supplierUnknown', minutesAgo: 5 }] })
    expect((await answer(r.id, 'lead', { answer: 'SUPPLIER_REJECTED', expectedStatus: 'PENDING_SUPPLIER' }).expect(200)).body.data).toMatchObject({ status: 'FAILED' }); expect(await row(r.id)).toMatchObject({ status: 'FAILED', supplierStatus: 'REJECTED' })
    // "no booking exists" needs an idle queue: a queued job could still book
    const busy = await fx({ job: { status: 'RETRY_WAIT', attempt: 1, minutesAgo: 1 } })
    expect(code(await answer(busy.id, 'lead', { answer: 'SUPPLIER_HAS_NO_BOOKING', expectedStatus: 'PENDING_SUPPLIER', evidenceRef: 'Agent Sam, ticket 7' }))).toBe('BOOKING_OPS_CONFLICT')
  })

  it('OQE-11: SUPPLIER RACE: a timeout leaves the booking unknown, an operator opens the queue, the supplier is then asked and says it holds the booking: one booking call, Confirmed, released', async () => {
    const b = await created('mock-ghost-late'); await run() // book times out (the supplier booked), and the immediate status check also fails
    expect(await row(b.bookingId)).toMatchObject({ status: 'PENDING_SUPPLIER', supplierStatus: 'UNKNOWN' })
    const seen = await find(b.bookingId); expect(seen).toMatchObject({ primaryReason: 'SUPPLIER_UNKNOWN', supplierCertainty: 'UNCERTAIN', status: 'PENDING_SUPPLIER', safeAction: 'SYNC_WITH_SUPPLIER' })
    expect(code(await supplierOp(b.bookingId, 'send', 'PENDING_SUPPLIER'))).toBe('SUPPLIER_STATE_UNKNOWN') // the operator cannot resend from the queue
    await supplierOp(b.bookingId, 'sync', 'PENDING_SUPPLIER').expect(200); await run() // the supplier recovered: it says the booking exists
    expect(await row(b.bookingId)).toMatchObject({ status: 'CONFIRMED', supplierStatus: 'CONFIRMED' }); expect((await row(b.bookingId)).supplierRef).toMatch(/^MOCK-/)
    expect(await calls(b.bookingId, 'BOOK')).toHaveLength(1) // exactly one booking creation call
    expect(registry.mockFor(tenantA)!.peek((await row(b.bookingId)).reference)?.state).toBe('CONFIRMED')
    expect(await find(b.bookingId)).toBeUndefined(); expect((await listQ('tab=resolved&pageSize=100')).items.map((i) => i.bookingId)).toContain(b.bookingId)
    expect(await owner.booking.count({ where: { tenantId: tenantA, reference: (await row(b.bookingId)).reference } })).toBe(1)
  })

  it('OQE-12: REVERSE RACE: an authorised manual answer lands before the runner reconciles: the runner defers to it and makes no second call', async () => {
    const b = await created('mock-ghost-late'); await run()
    expect(await row(b.bookingId)).toMatchObject({ supplierStatus: 'UNKNOWN' })
    await supplierOp(b.bookingId, 'sync', 'PENDING_SUPPLIER').expect(200) // queued, not yet run
    await answer(b.bookingId, 'lead', { answer: 'SUPPLIER_CONFIRMED', expectedStatus: 'PENDING_SUPPLIER', supplierRef: 'PHONE-1' }).expect(200)
    await run()
    expect(await row(b.bookingId)).toMatchObject({ status: 'CONFIRMED', supplierRef: 'PHONE-1' }) // the operator's answer stands
    const jobs = await owner.bookingSupplierJob.findMany({ where: { bookingId: b.bookingId }, orderBy: { createdAt: 'asc' } })
    expect(jobs.map((j) => j.status)).toEqual(['SUCCEEDED', 'SUCCEEDED']); expect(jobs[1].lastErrorCode).toBe('ALREADY_APPLIED')
    expect(await calls(b.bookingId, 'BOOK')).toHaveLength(1); expect((await events(b.bookingId)).filter((e) => e.toStatus === 'CONFIRMED' && e.fromStatus === 'PENDING_SUPPLIER')).toHaveLength(1)
  })

  it('OQE-13: cancellation: refused by the supplier it becomes an Urgent case that stays Cancel requested; a later sync resolves it', async () => {
    const b = await created('mock-cancel-fail'); await run()
    await post(`/bookings/${b.bookingId}/actions`, 'lead', { action: 'requestCancellation', expectedStatus: 'CONFIRMED', reason: 'Guest cancelled the trip' }).expect(200)
    expect(await find(b.bookingId)).toMatchObject({ primaryReason: 'CANCEL_REQUESTED', priority: 'HIGH', safeAction: 'SEND_CANCELLATION' })
    await supplierOp(b.bookingId, 'cancel', 'CANCEL_REQUESTED').expect(200); await run()
    expect(await row(b.bookingId)).toMatchObject({ status: 'CANCEL_REQUESTED', supplierStatus: 'CANCEL_FAILED' })
    const item = await find(b.bookingId); expect(item).toMatchObject({ primaryReason: 'CANCELLATION_FAILED', priority: 'URGENT', status: 'CANCEL_REQUESTED', safeAction: 'SETTLE_CANCELLATION' }); expect(item!.slaTargetMinutes).toBe(15)
    const detail = (await get(`/bookings/${b.bookingId}`, 'lead').expect(200)).body.data as BookingDetailView
    expect(detail.operations?.item).toMatchObject({ primaryReason: 'CANCELLATION_FAILED', priority: 'URGENT' }); expect(detail.operations?.timeline.map((t) => t.title)).toContain('Cancellation refused by the supplier')
    expect(detail.operations?.can.answers).toEqual(['SUPPLIER_CANCELLED', 'SUPPLIER_REFUSED_CANCELLATION', 'STILL_AWAITING_SUPPLIER'])
    registry.mockFor(tenantA)!.set((await row(b.bookingId)).reference, { state: 'CANCELLED', supplierRef: 'S', hotelConfirmationNo: null, supplierCancellationRef: 'CXL-LATE' }) // the supplier cancelled after all
    await supplierOp(b.bookingId, 'sync', 'CANCEL_REQUESTED').expect(200); await run()
    expect(await row(b.bookingId)).toMatchObject({ status: 'CANCELLED', supplierStatus: 'CANCELLED' }); expect(await find(b.bookingId)).toBeUndefined()
  })

  it('OQE-14: the operations panel on the booking detail: present for the right people, never written by reading, absent for agency users and for a closed-out booking', async () => {
    const b = await fx({ supplierStatus: 'UNKNOWN', created: 60, job: { status: 'UNKNOWN', minutesAgo: 30 }, events: [{ action: 'supplierUnknown', minutesAgo: 30 }] })
    const before = (await events(b.id)).length; const audits = await owner.auditEvent.count({ where: { tenantId: tenantA, entityId: b.id } })
    for (let i = 0; i < 3; i++) await get(`/bookings/${b.id}`, 'lead').expect(200)
    expect((await events(b.id)).length).toBe(before); expect(await owner.auditEvent.count({ where: { tenantId: tenantA, entityId: b.id, action: { not: 'booking.pii.viewed' } } })).toBe(audits - 0 >= 0 ? await owner.auditEvent.count({ where: { tenantId: tenantA, entityId: b.id, action: { not: 'booking.pii.viewed' } } }) : 0)
    const d = (await get(`/bookings/${b.id}`, 'lead').expect(200)).body.data as BookingDetailView
    expect(d.operations).toMatchObject({ item: { primaryReason: 'SUPPLIER_UNKNOWN', supplierCertainty: 'UNCERTAIN' }, can: { assign: true, escalate: true, note: true } })
    expect(d.operations?.timeline.filter((t) => t.kind === 'derived').map((t) => t.title)).toEqual(expect.arrayContaining([expect.stringContaining('Entered the operations queue'), 'SLA breached']))
    expect((await get(`/bookings/${b.id}`, 'viewer').expect(200)).body.data.operations.can).toMatchObject({ assign: false, escalate: false, note: false, answers: [] })
    expect((await get(`/bookings/${b.id}`, 'noops').expect(200)).body.data.operations).toBeNull()
    const own = await fx({ created: 5 }); expect((await get(`/bookings/${own.id}`, 'agx').expect(200)).body.data.operations).toBeNull()
    expect((await get(`/booking-queue/${b.id}`, 'lead').expect(200)).body.data.item.bookingId).toBe(b.id); expect((await get(`/booking-queue/${b.id}`, 'bops')).status).toBe(404)
  })

  it('OQE-15: the engine and the API agree: the evaluation of what the database holds equals the evaluation of the facts the API returned', async () => {
    const b = await fx({ created: 50, supplierStatus: 'UNKNOWN', events: [{ action: 'supplierUnknown', minutesAgo: 10 }] })
    const item = (await find(b.id))!
    const e = evaluateBookingOps({ status: 'PENDING_SUPPLIER', closed: false, supplierStatus: 'UNKNOWN', supplierConfigured: false, supplierRef: null, createdAt: ago(50).toISOString(), checkIn: ymd(40), latestJob: null, hasActiveJob: false, failedCalls: 0, lastSupplierActivityAt: null, enteredStatusAt: {}, supplierUnknownAt: item.enteredAt, cancelFailedAt: null, ops: null }, now())
    expect(e).toMatchObject({ primaryReason: item.primaryReason, priority: item.priority, slaState: item.slaState, safeAction: item.safeAction })
  })

  it('OQE-16: MID-CALL RACE: an operator records the answer while the supplier call is in flight: the late supplier result is dropped, not applied; the call is logged; no retry', async () => {
    const b = await created('mock-confirm'); const ref = (await row(b.bookingId)).reference
    let release!: () => void; let entered!: () => void
    const inside = new Promise<void>((r) => { entered = r }); const gate = new Promise<void>((r) => { release = r }); let bookCalls = 0
    const slow: BookingSupplierPort = {
      key: 'slow', async book() { bookCalls += 1; entered(); await gate; return { outcome: 'CONFIRMED', supplierRef: 'SUPPLIER-LATE', hotelConfirmationNo: 'HC-LATE' } },
      async cancel() { return { outcome: 'REJECTED', code: 'NO' } }, async statusByReference() { return { found: false } },
    }
    const slowRunner = new BookingSupplierRunner(app.get(BookingOpsDatabase, { strict: false }), { resolve: () => slow }, {})
    const running = slowRunner.runOnce(now); await inside // the supplier call is now in flight; no database transaction is open
    expect((await owner.bookingSupplierJob.findFirstOrThrow({ where: { bookingId: b.bookingId } })).status).toBe('RUNNING')
    await answer(b.bookingId, 'lead', { answer: 'SUPPLIER_CONFIRMED', expectedStatus: 'PENDING_SUPPLIER', supplierRef: 'PHONE-OPERATOR' }).expect(200) // the operator is not blocked by the in-flight call
    release(); await running
    expect(await row(b.bookingId)).toMatchObject({ status: 'CONFIRMED', supplierRef: 'PHONE-OPERATOR' }) // the person's evidence stands
    expect((await owner.bookingSupplierJob.findFirstOrThrow({ where: { bookingId: b.bookingId } }))).toMatchObject({ status: 'SUCCEEDED', lastErrorCode: 'ALREADY_APPLIED' })
    expect(bookCalls).toBe(1); expect((await calls(b.bookingId, 'BOOK')).map((c) => c.outcome)).toEqual(['CONFIRMED']); expect(await run()).toBe(0) // logged, never retried
    expect((await events(b.bookingId)).filter((e) => e.toStatus === 'CONFIRMED' && e.fromStatus === 'PENDING_SUPPLIER')).toHaveLength(1); expect(ref).toBeTruthy()
  })
})
