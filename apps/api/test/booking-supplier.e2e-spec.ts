import { randomBytes } from 'crypto'
import { INestApplication, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { PrismaClient } from '@prisma/client'
import * as cookieParser from 'cookie-parser'
import * as request from 'supertest'
import type { BookingDetailView, BookingSupplierResult, BookingWriteResult } from '@bedbanks/contracts'
import { AppModule } from '../src/app.module'
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter'
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor'
import { hashPassword } from '../src/auth/utils/password'
import { provisionApiRuntimeRole, API_RUNTIME_LOGIN_ROLE } from '../src/database/api-runtime-role'
import { verifyBookingOpsRole } from '../src/database/booking-ops-role'
import { BookingSupplierRunner } from '../src/booking-ops/booking-supplier-runner.service'
import { BookingSupplierRegistry } from '../src/booking-ops/supplier/booking-supplier.registry'
import { BookingOpsDatabase } from '../src/booking-ops/booking-ops-database'
import { BOOKING_SUPPLIER_RESOLVER } from '../src/booking-ops/supplier/booking-supplier.port'
import { enableBookingOps } from './support/booking-ops'

jest.setTimeout(240_000)

/** The Admin supplier queue (ADR 0039, Phase 3) on PostgreSQL over HTTP: API on the strict runtime role, runner and routes on the booking role, mock supplier for one named tenant. */
describe('Admin booking supplier queue (PostgreSQL, HTTP, strict API role + booking role, mock supplier)', () => {
  const owner = new PrismaClient()
  const suffix = `bs-${Date.now()}-${randomBytes(3).toString('hex')}`
  const password = 'booking-supplier-certification-password'
  const runtimePassword = `rt-${randomBytes(20).toString('hex')}`
  const origin = 'http://localhost:3001'
  const DAY = 86_400_000
  const ymd = (d: number) => new Date(Date.now() + d * DAY).toISOString().slice(0, 10)
  let app: INestApplication; let runner: BookingSupplierRunner; let registry: BookingSupplierRegistry
  let previousUrl: string | undefined; let restoreOps: () => void = () => undefined; const savedEnv: Record<string, string | undefined> = {}
  let tenantA = '', tenantB = '', agencyX = '', hotelA = ''
  const cookies: Record<string, string> = {}; const userIds: string[] = []
  let skew = 0 // seconds the runner's clock is ahead of real time: the test "waits" by moving it, never by sleeping
  const now = () => new Date(Date.now() + skew * 1000)
  const tick = (seconds: number) => { skew += seconds }
  const run = () => runner.runOnce(now)
  /** Seconds from the runner's "now" until the job is next due. */
  const waitOf = (job: { runAfter: Date }) => Math.round((job.runAfter.getTime() - now().getTime()) / 1000)

  async function user(label: string, tenantId: string, keys: string[], agencyId?: string) {
    const u = await owner.user.create({ data: { email: `${suffix}-${label}@example.test`, name: label, passwordHash: await hashPassword(password), status: 'ACTIVE' } }); userIds.push(u.id)
    await owner.membership.create({ data: { tenantId, userId: u.id, role: 'agent' } })
    const r = await owner.role.create({ data: { tenantId, name: `${suffix}-${label}` } })
    for (const key of keys) { const p = await owner.permission.upsert({ where: { key }, update: {}, create: { key, description: key } }); await owner.rolePermission.create({ data: { roleId: r.id, permissionId: p.id } }) }
    await owner.userRole.create({ data: { tenantId, userId: u.id, roleId: r.id } })
    if (agencyId) await owner.agencyMember.create({ data: { tenantId, agencyId, userId: u.id } })
    return u.id
  }
  const key = () => `k-${randomBytes(8).toString('hex')}`
  const post = (path: string, who: string, body: unknown, k: string | null = key()) => { const r = request(app.getHttpServer()).post(`/api/v1/admin/operations/bookings${path}`).set('Cookie', cookies[who]).set('Origin', origin); return (k ? r.set('Idempotency-Key', k) : r).send(body as object) }
  const code = (res: request.Response) => res.body.error?.code
  const manual = (supplier: string, over: Record<string, unknown> = {}) => ({ agencyId: agencyX, hotelId: hotelA, supplier, checkIn: ymd(30), checkOut: ymd(33), currency: 'AED', sellMinor: '250000', isRefundable: true, rooms: [{ roomName: 'Deluxe', adults: 2 }], guests: [{ firstName: 'Amira', lastName: 'Haddad' }], ...over })
  /** A manual booking sent to the supplier at creation, as the Admin does. */
  const created = async (supplier: string, send = true): Promise<BookingWriteResult> => (await post('', 'lead', manual(supplier, { sendToSupplier: send })).expect(201)).body.data
  const row = (id: string) => owner.booking.findUniqueOrThrow({ where: { id }, select: { status: true, supplierStatus: true, supplierRef: true, hotelConfirmationNo: true, version: true, reference: true } })
  const jobs = (id: string) => owner.bookingSupplierJob.findMany({ where: { bookingId: id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  const calls = (id: string) => owner.bookingSupplierCall.findMany({ where: { bookingId: id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  const events = (id: string) => owner.bookingEvent.findMany({ where: { bookingId: id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  const detail = async (id: string, who = 'lead'): Promise<BookingDetailView> => (await request(app.getHttpServer()).get(`/api/v1/admin/operations/bookings/${id}`).set('Cookie', cookies[who]).expect(200)).body.data
  const supplierOp = (id: string, who: string, op: string, expectedStatus: string, k: string | null = key()) => post(`/${id}/supplier`, who, { op, expectedStatus }, k)
  const act = (id: string, body: Record<string, unknown>) => post(`/${id}/actions`, 'lead', body)
  const mock = () => registry.mockFor(tenantA)!

  beforeAll(async () => {
    await owner.$connect()
    tenantA = (await owner.tenant.create({ data: { name: suffix, slug: suffix } })).id; tenantB = (await owner.tenant.create({ data: { name: `${suffix}-b`, slug: `${suffix}-b` } })).id
    const creator = await owner.user.create({ data: { email: `${suffix}-creator@example.test`, name: 'creator' } }); userIds.push(creator.id)
    agencyX = (await owner.agency.create({ data: { tenantId: tenantA, code: `X-${suffix.slice(-6)}`.toUpperCase(), name: 'Travel Republic', countryCode: 'GB', createdById: creator.id } })).id
    hotelA = (await owner.hotel.create({ data: { tenantId: tenantA, name: `${suffix} Atlantis`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', timeZone: 'Asia/Dubai' } })).id
    const WRITE = ['booking.read', 'booking.pii.view', 'booking.manual.create', 'booking.confirm.manual', 'booking.cancel', 'booking.cancel.nonrefundable', 'booking.on-request.resolve']
    await user('lead', tenantA, [...WRITE, 'booking.supplier.retry']); await user('nosupplier', tenantA, WRITE); await user('agx', tenantA, ['booking.view.agency', 'booking.cancel.request'], agencyX)
    await user('bops', tenantB, ['booking.read', 'booking.supplier.retry'])
    for (const k of ['ADMIN_MANUAL_BOOKING_ENABLED', 'ADMIN_SUPPLIER_JOBS_ENABLED', 'ALLOW_MOCK_SUPPLIER', 'MOCK_SUPPLIER_TENANT_IDS']) savedEnv[k] = process.env[k]
    process.env.ADMIN_MANUAL_BOOKING_ENABLED = 'true'; process.env.ADMIN_SUPPLIER_JOBS_ENABLED = 'true'; process.env.ALLOW_MOCK_SUPPLIER = 'true'; process.env.MOCK_SUPPLIER_TENANT_IDS = tenantA
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
    runner = app.get(BookingSupplierRunner, { strict: false }); registry = app.get(BookingSupplierRegistry, { strict: false })
    for (const label of ['lead', 'nosupplier', 'agx', 'bops']) {
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
    await owner.session.deleteMany({ where: { userId: { in: userIds } } }); await owner.user.deleteMany({ where: { id: { in: userIds } } }); await owner.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB].filter(Boolean) } } })
    await owner.$disconnect()
  })

  beforeEach(() => { skew = 0 })

  it('BS-E01: send at creation, run the queue: confirmed with references; one call logged; the job, event and audit all agree', async () => {
    const b = await created('mock-confirm')
    expect(await row(b.bookingId)).toMatchObject({ status: 'PENDING_SUPPLIER', supplierStatus: null })
    expect((await jobs(b.bookingId)).map((j) => [j.kind, j.status, j.attempt])).toEqual([['BOOK', 'QUEUED', 0]])
    expect(await run()).toBeGreaterThanOrEqual(1)
    const r = await row(b.bookingId)
    expect(r).toMatchObject({ status: 'CONFIRMED', supplierStatus: 'CONFIRMED' }); expect(r.supplierRef).toMatch(/^MOCK-/); expect(r.hotelConfirmationNo).toMatch(/^HC-/)
    expect((await jobs(b.bookingId))[0]).toMatchObject({ status: 'SUCCEEDED', attempt: 1, lockedUntil: null }); expect((await jobs(b.bookingId))[0].completedAt).not.toBeNull()
    expect((await calls(b.bookingId)).map((c) => [c.action, c.outcome, c.attempt])).toEqual([['BOOK', 'CONFIRMED', 1]])
    const log = await events(b.bookingId)
    expect(log.map((e) => [e.action, e.fromStatus, e.toStatus, e.actorType])).toEqual([['createManual', null, 'PENDING_SUPPLIER', 'USER'], ['supplierQueued', 'PENDING_SUPPLIER', 'PENDING_SUPPLIER', 'USER'], ['systemConfirm', 'PENDING_SUPPLIER', 'CONFIRMED', 'SUPPLIER']])
    const audit = await owner.auditEvent.findMany({ where: { tenantId: tenantA, entityId: b.bookingId }, orderBy: { createdAt: 'asc' } })
    expect(audit.map((a) => a.action)).toEqual(['booking.manual.created', 'booking.systemConfirm']); expect(audit[1]).toMatchObject({ actorType: 'USER' }); expect(audit[1].payload).toMatchObject({ via: 'supplier_job', from: 'PENDING_SUPPLIER', to: 'CONFIRMED' })
    expect(await run()).toBe(0) // nothing is due again
    const d = await detail(b.bookingId); expect(d.supplier).toMatchObject({ supplierStatus: 'CONFIRMED', ops: [], dispatch: { available: true, reason: null } })
    expect(d.supplier?.calls).toHaveLength(1); expect(d.supplier?.jobs[0]).toMatchObject({ kind: 'BOOK', status: 'SUCCEEDED' })
  })

  it('BS-E02: the call log is a summary: no request or response payload and no guest data is stored anywhere in it', async () => {
    const b = await created('mock-confirm'); await run()
    const columns = (await owner.$queryRawUnsafe<Array<{ column_name: string }>>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'BookingSupplierCall'`)).map((c) => c.column_name).sort()
    expect(columns).toEqual(['action', 'attempt', 'booking_id', 'created_at', 'duration_ms', 'error_code', 'http_status', 'id', 'job_id', 'outcome', 'supplier_key', 'supplier_reference', 'tenant_id'])
    expect(JSON.stringify(await calls(b.bookingId))).not.toMatch(/Amira|Haddad/)
    await expect(owner.$executeRawUnsafe(`UPDATE "BookingSupplierCall" SET outcome = 'X' WHERE booking_id = '${b.bookingId}'`)).rejects.toThrow(/append-only/)
    await expect(owner.$executeRawUnsafe(`DELETE FROM "BookingSupplierCall" WHERE booking_id = '${b.bookingId}'`)).rejects.toThrow(/append-only/)
  })

  it('BS-E03: on request, then the supplier confirms later: a status sync moves it to Confirmed', async () => {
    const b = await created('mock-on-request'); await run()
    expect(await row(b.bookingId)).toMatchObject({ status: 'ON_REQUEST', supplierStatus: 'ON_REQUEST' })
    const ref = (await row(b.bookingId)).reference
    mock().set(ref, { state: 'CONFIRMED', supplierRef: 'SUP-LATE', hotelConfirmationNo: 'HC-LATE' })
    expect((await detail(b.bookingId)).supplier?.ops).toEqual(['sync'])
    expect(((await supplierOp(b.bookingId, 'lead', 'sync', 'ON_REQUEST').expect(200)).body.data as BookingSupplierResult)).toMatchObject({ kind: 'STATUS_CHECK', status: 'QUEUED' })
    await run()
    expect(await row(b.bookingId)).toMatchObject({ status: 'CONFIRMED', supplierRef: 'SUP-LATE', hotelConfirmationNo: 'HC-LATE', supplierStatus: 'CONFIRMED' })
    expect((await events(b.bookingId)).at(-1)).toMatchObject({ action: 'systemConfirmOnRequest', fromStatus: 'ON_REQUEST', toStatus: 'CONFIRMED' })
  })

  it('BS-E04: a definite rejection fails the booking at once, with the supplier code in the reason, and nothing is retried', async () => {
    const b = await created('mock-reject'); await run()
    expect(await row(b.bookingId)).toMatchObject({ status: 'FAILED', supplierStatus: 'REJECTED' })
    expect((await events(b.bookingId)).at(-1)?.reason).toContain('NO_AVAILABILITY'); expect((await calls(b.bookingId)).map((c) => c.outcome)).toEqual(['REJECTED'])
    expect(await run()).toBe(0)
  })

  it('BS-E05: a timeout with nothing booked is retried at 30 s, 2 min and 5 min; only then is the booking Failed, and every attempt checks the supplier first', async () => {
    const b = await created('mock-timeout'); await run()
    let job = (await jobs(b.bookingId))[0]; expect(job).toMatchObject({ status: 'RETRY_WAIT', attempt: 1, lastErrorCode: 'SUPPLIER_TIMEOUT' }); expect(waitOf(job)).toBeGreaterThanOrEqual(28); expect(waitOf(job)).toBeLessThanOrEqual(30)
    expect(await row(b.bookingId)).toMatchObject({ status: 'PENDING_SUPPLIER' }) // not failed on the first timeout
    tick(10); expect(await run()).toBe(0) // not due yet
    tick(25); await run(); job = (await jobs(b.bookingId))[0]; expect(job).toMatchObject({ status: 'RETRY_WAIT', attempt: 2 }); expect(waitOf(job)).toBeGreaterThanOrEqual(118); expect(waitOf(job)).toBeLessThanOrEqual(120)
    tick(119); expect(await run()).toBe(0); tick(2); await run()
    job = (await jobs(b.bookingId))[0]; expect(job).toMatchObject({ status: 'RETRY_WAIT', attempt: 3 }); expect(waitOf(job)).toBeGreaterThanOrEqual(298); expect(waitOf(job)).toBeLessThanOrEqual(300)
    expect(await row(b.bookingId)).toMatchObject({ status: 'PENDING_SUPPLIER' }) // still not failed after three calls
    tick(299); expect(await run()).toBe(0); tick(2); await run() // the fourth and last call
    expect(await row(b.bookingId)).toMatchObject({ status: 'FAILED' }); expect((await events(b.bookingId)).at(-1)?.reason).toMatch(/did not answer after 4 attempts and holds no booking/)
    expect((await jobs(b.bookingId))[0]).toMatchObject({ status: 'SUCCEEDED' })
    const log = (await calls(b.bookingId)).map((c) => `${c.action}:${c.outcome}`)
    expect(log.filter((l) => l === 'BOOK:TIMEOUT')).toHaveLength(4); expect(log.filter((l) => l === 'STATUS_CHECK:NOT_FOUND')).toHaveLength(4)
    // every BOOK timeout is immediately followed by a status check
    for (let i = 0; i < log.length; i++) if (log[i] === 'BOOK:TIMEOUT') expect(log[i + 1]).toBe('STATUS_CHECK:NOT_FOUND')
  })

  it('BS-E06: NO GHOST BOOKING: the supplier booked but the call timed out: the status check finds it, the booking is Confirmed from the supplier’s own answer, and the supplier was asked to book exactly once', async () => {
    const b = await created('mock-ghost'); const ref = (await row(b.bookingId)).reference
    await run()
    expect(await row(b.bookingId)).toMatchObject({ status: 'CONFIRMED', supplierStatus: 'CONFIRMED' }); expect((await row(b.bookingId)).supplierRef).toMatch(/^MOCK-/)
    expect((await calls(b.bookingId)).map((c) => `${c.action}:${c.outcome}`)).toEqual(['BOOK:TIMEOUT', 'STATUS_CHECK:FOUND_CONFIRMED'])
    expect((await jobs(b.bookingId))[0]).toMatchObject({ status: 'SUCCEEDED', attempt: 1 })
    expect(mock().peek(ref)?.state).toBe('CONFIRMED'); expect(await run()).toBe(0) // no second book call is ever made
    expect((await events(b.bookingId)).map((e) => e.action)).not.toContain('supplierUnknown')
  })

  it('BS-E07: a flaky supplier: the first attempt times out with nothing booked; "Retry now" from the detail page makes it run immediately and it succeeds', async () => {
    const b = await created('mock-flaky'); await run()
    expect(await row(b.bookingId)).toMatchObject({ status: 'PENDING_SUPPLIER' }); expect((await jobs(b.bookingId))[0].status).toBe('RETRY_WAIT')
    expect((await detail(b.bookingId)).supplier?.ops).toEqual(['retryNow'])
    expect(await run()).toBe(0)
    const res = (await supplierOp(b.bookingId, 'lead', 'retryNow', 'PENDING_SUPPLIER').expect(200)).body.data as BookingSupplierResult; expect(res).toMatchObject({ status: 'RETRY_WAIT', replayed: false })
    expect(await jobs(b.bookingId)).toHaveLength(1) // the same job, not a second one
    await run()
    expect(await row(b.bookingId)).toMatchObject({ status: 'CONFIRMED' }); expect((await jobs(b.bookingId))[0]).toMatchObject({ status: 'SUCCEEDED', attempt: 2 })
  })

  it('BS-E08: UNKNOWN is never Failed: when neither the call nor the status check can be answered, the booking stays Pending supplier, sending again is refused, and only a sync or a manual answer can move it', async () => {
    const b = await created('mock-down'); await run()
    expect(await row(b.bookingId)).toMatchObject({ status: 'PENDING_SUPPLIER', supplierStatus: 'UNKNOWN' }); expect((await jobs(b.bookingId))[0]).toMatchObject({ status: 'UNKNOWN', lastErrorCode: 'SUPPLIER_UNREACHABLE' })
    expect((await events(b.bookingId)).at(-1)).toMatchObject({ action: 'supplierUnknown', fromStatus: 'PENDING_SUPPLIER', toStatus: 'PENDING_SUPPLIER' })
    expect(await run()).toBe(0)
    expect(code(await supplierOp(b.bookingId, 'lead', 'send', 'PENDING_SUPPLIER'))).toBe('SUPPLIER_STATE_UNKNOWN')
    expect((await detail(b.bookingId)).supplier?.ops).toEqual(['sync'])
    await supplierOp(b.bookingId, 'lead', 'sync', 'PENDING_SUPPLIER').expect(200); await run()
    expect(await row(b.bookingId)).toMatchObject({ status: 'PENDING_SUPPLIER' }) // the supplier is still unreachable: still unknown, still not failed
    expect((await jobs(b.bookingId)).map((j) => j.status)).toEqual(['UNKNOWN', 'UNKNOWN'])
    // a person who learned the answer off-platform records it with the existing manual action
    const manualConfirm = (await act(b.bookingId, { action: 'recordConfirmed', expectedStatus: 'PENDING_SUPPLIER', supplierRef: 'PHONE-1' }).expect(200)).body.data
    expect(manualConfirm).toMatchObject({ status: 'CONFIRMED' })
  })

  it('BS-E09: a sync that finds nothing at the supplier says so, and only then is "Send to supplier" offered again', async () => {
    const b = await created('mock-timeout', false)
    expect((await detail(b.bookingId)).supplier?.ops).toEqual(['send', 'sync'])
    await supplierOp(b.bookingId, 'lead', 'sync', 'PENDING_SUPPLIER').expect(200); await run()
    expect(await row(b.bookingId)).toMatchObject({ status: 'PENDING_SUPPLIER', supplierStatus: 'NOT_FOUND' }); expect((await events(b.bookingId)).at(-1)?.action).toBe('supplierNotFound')
    expect((await jobs(b.bookingId))[0]).toMatchObject({ kind: 'STATUS_CHECK', status: 'SUCCEEDED' })
    expect((await detail(b.bookingId)).supplier?.ops).toEqual(['send', 'sync'])
  })

  it('BS-E10: confirmed without references stays Confirmed and is flagged Missing supplier ref (spec B.4)', async () => {
    const b = await created('mock-confirm-noref'); await run()
    expect(await row(b.bookingId)).toMatchObject({ status: 'CONFIRMED', supplierRef: null, hotelConfirmationNo: null })
    expect((await detail(b.bookingId)).booking.missingSupplierRef).toBe(true)
  })

  it('BS-E11: cancellation through the supplier: Cancel requested -> supplier cancels -> Cancelled with the supplier’s reference; a refusal leaves it Cancel requested and flagged', async () => {
    const ok = await created('mock-confirm'); await run()
    await act(ok.bookingId, { action: 'requestCancellation', expectedStatus: 'CONFIRMED', reason: 'Guest cancelled' }).expect(200)
    expect((await detail(ok.bookingId)).supplier?.ops).toEqual(['cancel', 'sync'])
    await supplierOp(ok.bookingId, 'lead', 'cancel', 'CANCEL_REQUESTED').expect(200); await run()
    expect(await row(ok.bookingId)).toMatchObject({ status: 'CANCELLED', supplierStatus: 'CANCELLED' })
    expect((await events(ok.bookingId)).at(-1)).toMatchObject({ action: 'systemCompleteCancellation', toStatus: 'CANCELLED' }); expect((await events(ok.bookingId)).at(-1)?.payload).toMatchObject({ supplierCancellationRef: expect.stringMatching(/^CXL-/) })
    const refused = await created('mock-cancel-fail'); await run()
    await act(refused.bookingId, { action: 'requestCancellation', expectedStatus: 'CONFIRMED', reason: 'x' }).expect(200)
    await supplierOp(refused.bookingId, 'lead', 'cancel', 'CANCEL_REQUESTED').expect(200); await run()
    expect(await row(refused.bookingId)).toMatchObject({ status: 'CANCEL_REQUESTED', supplierStatus: 'CANCEL_FAILED' }); expect((await jobs(refused.bookingId)).at(-1)).toMatchObject({ kind: 'CANCEL', status: 'FAILED', lastErrorCode: 'CANCEL_NOT_ALLOWED' })
    expect((await events(refused.bookingId)).at(-1)?.action).toBe('supplierCancelFailed')
    // ops settle it by hand with the existing action
    expect((await act(refused.bookingId, { action: 'confirmCancellation', expectedStatus: 'CANCEL_REQUESTED', supplierCancellationRef: 'PHONE-CXL', confirmNonRefundable: true }).expect(200)).body.data).toMatchObject({ status: 'CANCELLED' })
  })

  it('BS-E12: nothing is sent unless a supplier adapter exists: a real tenant, an unknown supplier, a mock name for the wrong tenant and the flag off are all refused honestly', async () => {
    expect(code(await post('', 'lead', manual('Acme Hotels', { sendToSupplier: true })))).toBe('SUPPLIER_NOT_CONFIGURED')
    const plain = await created('Acme Hotels', false)
    expect(code(await supplierOp(plain.bookingId, 'lead', 'send', 'PENDING_SUPPLIER'))).toBe('SUPPLIER_NOT_CONFIGURED')
    expect((await detail(plain.bookingId)).supplier).toMatchObject({ dispatch: { available: false, reason: 'SUPPLIER_NOT_CONFIGURED' }, ops: [] })
    expect(registry.resolve(tenantB, 'mock-confirm')).toBeNull(); expect(registry.resolve(tenantA, 'mock-confirm')).not.toBeNull(); expect(registry.resolve(tenantA, 'Acme Hotels')).toBeNull()
    const off = new BookingSupplierRegistry({ ALLOW_MOCK_SUPPLIER: 'false', MOCK_SUPPLIER_TENANT_IDS: tenantA }); expect(off.resolve(tenantA, 'mock-confirm')).toBeNull()
    const noList = new BookingSupplierRegistry({ ALLOW_MOCK_SUPPLIER: 'true' }); expect(noList.resolve(tenantA, 'mock-confirm')).toBeNull()
    process.env.ADMIN_SUPPLIER_JOBS_ENABLED = 'false'
    try { expect(code(await supplierOp(plain.bookingId, 'lead', 'sync', 'PENDING_SUPPLIER'))).toBe('SUPPLIER_JOBS_DISABLED'); expect(code(await post('', 'lead', manual('mock-confirm', { sendToSupplier: true })))).toBe('SUPPLIER_JOBS_DISABLED') } finally { process.env.ADMIN_SUPPLIER_JOBS_ENABLED = 'true' }
    expect(await owner.bookingSupplierJob.count({ where: { bookingId: plain.bookingId } })).toBe(0)
  })

  it('BS-E13: permissions and scope: booking.supplier.retry is required, agency users and other tenants are refused, idempotency replays, and only one job can be active', async () => {
    const b = await created('mock-confirm', false)
    expect((await supplierOp(b.bookingId, 'nosupplier', 'send', 'PENDING_SUPPLIER')).status).toBe(403)
    expect((await supplierOp(b.bookingId, 'agx', 'send', 'PENDING_SUPPLIER')).status).toBe(403)
    expect((await supplierOp(b.bookingId, 'bops', 'send', 'PENDING_SUPPLIER')).status).toBe(404)
    expect((await detail(b.bookingId, 'nosupplier')).supplier).toMatchObject({ dispatch: { available: false, reason: 'NOT_PERMITTED' }, ops: [] })
    const asAgency = await request(app.getHttpServer()).get(`/api/v1/admin/operations/bookings/${b.bookingId}`).set('Cookie', cookies.agx).expect(200) // their own agency's booking: visible
    expect(asAgency.body.data.supplier).toBeNull() // but the supplier queue is internal
    expect(code(await supplierOp(b.bookingId, 'lead', 'send', 'PENDING_SUPPLIER', null))).toBe('IDEMPOTENCY_KEY_REQUIRED')
    expect(code(await supplierOp(b.bookingId, 'lead', 'send', 'CONFIRMED'))).toBe('STALE_STATUS')
    expect((await post(`/${b.bookingId}/supplier`, 'lead', { op: 'dance', expectedStatus: 'PENDING_SUPPLIER' })).status).toBe(400)
    const k = key(); const first = (await supplierOp(b.bookingId, 'lead', 'send', 'PENDING_SUPPLIER', k).expect(200)).body.data as BookingSupplierResult
    const replay = (await supplierOp(b.bookingId, 'lead', 'send', 'PENDING_SUPPLIER', k).expect(200)).body.data as BookingSupplierResult
    expect(first.replayed).toBe(false); expect(replay).toMatchObject({ replayed: true, jobId: first.jobId })
    expect(code(await supplierOp(b.bookingId, 'lead', 'sync', 'PENDING_SUPPLIER', k))).toBe('IDEMPOTENCY_CONFLICT')
    expect(code(await supplierOp(b.bookingId, 'lead', 'send', 'PENDING_SUPPLIER'))).toBe('SUPPLIER_JOB_ACTIVE')
    expect(await jobs(b.bookingId)).toHaveLength(1)
  })

  it('BS-E14: concurrent clicks create exactly one job; two runners racing over many jobs call the supplier exactly once per booking', async () => {
    const b = await created('mock-confirm', false)
    const race = await Promise.all([1, 2, 3, 4].map(() => supplierOp(b.bookingId, 'lead', 'send', 'PENDING_SUPPLIER')))
    expect(race.map((r) => r.status).sort()).toEqual([200, 409, 409, 409]); expect(await jobs(b.bookingId)).toHaveLength(1)
    const many = [b]; for (let i = 0; i < 6; i++) many.push(await created('mock-confirm'))
    const second = new BookingSupplierRunner(app.get(BookingOpsDatabase, { strict: false }), app.get(BOOKING_SUPPLIER_RESOLVER, { strict: false }), {})
    await Promise.all([runner.runOnce(now), second.runOnce(now)])
    for (const m of many) { expect(await row(m.bookingId)).toMatchObject({ status: 'CONFIRMED' }); expect((await calls(m.bookingId)).filter((c) => c.action === 'BOOK')).toHaveLength(1) }
  })

  it('BS-E15: a crashed runner: an expired RUNNING job is picked up again; one that died on its last attempt becomes UNKNOWN, not Failed', async () => {
    const b = await created('mock-confirm'); const [job] = await jobs(b.bookingId)
    await owner.bookingSupplierJob.update({ where: { id: job.id }, data: { status: 'RUNNING', attempt: 1, lockedUntil: new Date(now().getTime() - 1000) } })
    await run(); expect(await row(b.bookingId)).toMatchObject({ status: 'CONFIRMED' }); expect((await jobs(b.bookingId))[0]).toMatchObject({ status: 'SUCCEEDED', attempt: 2 })
    const lost = await created('mock-confirm'); const [lostJob] = await jobs(lost.bookingId)
    await owner.bookingSupplierJob.update({ where: { id: lostJob.id }, data: { status: 'RUNNING', attempt: 4, lockedUntil: new Date(now().getTime() - 1000) } })
    await run(); expect(await row(lost.bookingId)).toMatchObject({ status: 'PENDING_SUPPLIER' }); expect((await jobs(lost.bookingId))[0]).toMatchObject({ status: 'UNKNOWN', lastErrorCode: 'RUNNER_LOST' })
    expect(await calls(lost.bookingId)).toHaveLength(0) // the supplier was not called blindly a fourth time
    const live = await created('mock-confirm'); const [liveJob] = await jobs(live.bookingId)
    await owner.bookingSupplierJob.update({ where: { id: liveJob.id }, data: { status: 'RUNNING', attempt: 1, lockedUntil: new Date(now().getTime() + 60_000) } })
    expect(await run()).toBe(0) // still locked by a live runner
    await owner.bookingSupplierJob.update({ where: { id: liveJob.id }, data: { status: 'FAILED' } })
  })

  it('BS-E16: a booking a person already settled is not touched by a late job; a missing adapter fails the job, not the booking', async () => {
    const b = await created('mock-confirm')
    await act(b.bookingId, { action: 'recordConfirmed', expectedStatus: 'PENDING_SUPPLIER', supplierRef: 'PHONE-9' }).expect(200)
    await run()
    expect(await row(b.bookingId)).toMatchObject({ status: 'CONFIRMED', supplierRef: 'PHONE-9' }); expect((await jobs(b.bookingId))[0]).toMatchObject({ status: 'SUCCEEDED', lastErrorCode: 'ALREADY_APPLIED' }); expect(await calls(b.bookingId)).toHaveLength(0)
    const c = await created('mock-confirm'); process.env.ALLOW_MOCK_SUPPLIER = 'false'
    try { await run() } finally { process.env.ALLOW_MOCK_SUPPLIER = 'true' }
    expect(await row(c.bookingId)).toMatchObject({ status: 'PENDING_SUPPLIER' }); expect((await jobs(c.bookingId))[0]).toMatchObject({ status: 'FAILED', lastErrorCode: 'SUPPLIER_NOT_CONFIGURED' })
  })

  it('BS-E17: the runner uses only the booking role: it can name due tenants through the one function and cannot read another tenant’s jobs', async () => {
    const b = await created('mock-confirm'); const db = app.get(BookingOpsDatabase, { strict: false })
    expect(await db.dueTenants(new Date(Date.now() + 1000))).toContain(tenantA)
    expect(await db.withTenantWrite(tenantB, (tx) => tx.bookingSupplierJob.count())).toBe(0)
    expect(await db.withTenantWrite(tenantA, (tx) => tx.bookingSupplierJob.count({ where: { bookingId: b.bookingId } }))).toBe(1)
    const roleUrl = process.env.BOOKING_OPS_DATABASE_URL as string; const probe = new PrismaClient({ datasourceUrl: roleUrl })
    try { expect(await verifyBookingOpsRole(probe)).toEqual({ ok: true, failures: [] }); await expect(probe.$queryRawUnsafe(`SELECT count(*) FROM "Tenant"`)).rejects.toThrow() } finally { await probe.$disconnect() }
    await run()
  })
})
