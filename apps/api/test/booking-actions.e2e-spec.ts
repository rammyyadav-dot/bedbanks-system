import { randomBytes } from 'crypto'
import { INestApplication, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { PrismaClient } from '@prisma/client'
import * as cookieParser from 'cookie-parser'
import * as request from 'supertest'
import type { BookingDetailView, BookingWriteResult } from '@bedbanks/contracts'
import { AppModule } from '../src/app.module'
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter'
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor'
import { hashPassword } from '../src/auth/utils/password'
import { provisionApiRuntimeRole, API_RUNTIME_LOGIN_ROLE } from '../src/database/api-runtime-role'
import { enableBookingOps } from './support/booking-ops'

jest.setTimeout(180_000)

/** The Admin booking lifecycle over HTTP (ADR 0039, Phase 2): API on the strict runtime role (no booking grants), booking module on its own role with narrow write grants. */
describe('Admin booking lifecycle (PostgreSQL, HTTP, strict API role + booking role)', () => {
  const owner = new PrismaClient()
  const suffix = `ba-${Date.now()}-${randomBytes(3).toString('hex')}`
  const password = 'booking-actions-certification-password'
  const runtimePassword = `rt-${randomBytes(20).toString('hex')}`
  const origin = 'http://localhost:3001'
  const DAY = 86_400_000
  const ymd = (d: number) => new Date(Date.now() + d * DAY).toISOString().slice(0, 10)
  let app: INestApplication; let previousUrl: string | undefined; let restoreOps: () => void = () => undefined; let previousFlag: string | undefined
  let tenantA = '', tenantB = '', agencyX = '', agencyY = '', hotelA = ''
  const cookies: Record<string, string> = {}; const userIds: string[] = []; let n = 0
  const SECRET_REASON = 'Guest Zaphod Beeblebrox called from +971500000000'

  async function user(label: string, tenantId: string, keys: string[], agencyId?: string) {
    const u = await owner.user.create({ data: { email: `${suffix}-${label}@example.test`, name: label, passwordHash: await hashPassword(password), status: 'ACTIVE' } }); userIds.push(u.id)
    await owner.membership.create({ data: { tenantId, userId: u.id, role: 'agent' } })
    const r = await owner.role.create({ data: { tenantId, name: `${suffix}-${label}` } })
    for (const key of keys) { const p = await owner.permission.upsert({ where: { key }, update: {}, create: { key, description: key } }); await owner.rolePermission.create({ data: { roleId: r.id, permissionId: p.id } }) }
    await owner.userRole.create({ data: { tenantId, userId: u.id, roleId: r.id } })
    if (agencyId) await owner.agencyMember.create({ data: { tenantId, agencyId, userId: u.id } })
    return u.id
  }
  async function booking(status: string, o: { agency?: 'X' | 'Y' | null; refundable?: boolean | null; checkIn?: number; supplierRef?: string | null; tenant?: 'A' | 'B'; closed?: boolean } = {}) {
    const tenantId = o.tenant === 'B' ? tenantB : tenantA; n += 1
    const ci = o.checkIn ?? 20
    const b = await owner.booking.create({ data: { tenantId, reference: `FB-${randomBytes(10).toString('hex').toUpperCase()}`, supplier: 'Supplier One', hotelId: hotelA, status: status as never, currency: 'AED', totalMinor: 100_000n, idempotencyKey: `${suffix}-${n}`, searchSnapshot: {},
      agencyId: o.agency === null ? null : o.agency === 'Y' ? agencyY : agencyX, isRefundable: o.refundable === undefined ? true : o.refundable, supplierRef: o.supplierRef ?? null, checkIn: new Date(`${ymd(ci)}T00:00:00Z`), checkOut: new Date(`${ymd(ci + 2)}T00:00:00Z`), nights: 2, closedAt: o.closed ? new Date() : null } })
    await owner.bookingRoom.create({ data: { tenantId, bookingId: b.id, roomName: 'Deluxe', adults: 2 } })
    await owner.bookingGuest.create({ data: { tenantId, bookingId: b.id, firstName: 'Amira', lastName: 'Haddad', isLead: true } })
    await owner.bookingEvent.create({ data: { tenantId, bookingId: b.id, toStatus: status as never, actorType: 'SYSTEM', reason: 'fixture', payload: { backfill: true } } })
    return b
  }
  const key = () => `k-${randomBytes(8).toString('hex')}`
  const post = (path: string, who: string, body: unknown, k: string | null = key(), method: 'post' | 'patch' = 'post') => {
    const r = request(app.getHttpServer())[method](`/api/v1/admin/operations/bookings${path}`).set('Cookie', cookies[who]).set('Origin', origin)
    return (k ? r.set('Idempotency-Key', k) : r).send(body as object)
  }
  const act = (id: string, who: string, body: Record<string, unknown>, k: string | null = key()) => post(`/${id}/actions`, who, body, k)
  const ok = async (id: string, who: string, body: Record<string, unknown>): Promise<BookingWriteResult> => (await act(id, who, body).expect(200)).body.data
  const detail = async (id: string, who = 'lead'): Promise<BookingDetailView> => (await request(app.getHttpServer()).get(`/api/v1/admin/operations/bookings/${id}`).set('Cookie', cookies[who]).expect(200)).body.data
  const code = (res: request.Response) => res.body.error?.code ?? res.body.code ?? res.body.message?.code
  const events = (id: string) => owner.bookingEvent.findMany({ where: { bookingId: id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  const state = async (id: string) => owner.booking.findUniqueOrThrow({ where: { id }, select: { status: true, version: true, closedAt: true, supplierRef: true, hotelConfirmationNo: true } })

  beforeAll(async () => {
    await owner.$connect()
    tenantA = (await owner.tenant.create({ data: { name: suffix, slug: suffix } })).id; tenantB = (await owner.tenant.create({ data: { name: `${suffix}-b`, slug: `${suffix}-b` } })).id
    const creator = await owner.user.create({ data: { email: `${suffix}-creator@example.test`, name: 'creator' } }); userIds.push(creator.id)
    agencyX = (await owner.agency.create({ data: { tenantId: tenantA, code: `X-${suffix.slice(-6)}`.toUpperCase(), name: 'Travel Republic', countryCode: 'GB', createdById: creator.id } })).id
    agencyY = (await owner.agency.create({ data: { tenantId: tenantA, code: `Y-${suffix.slice(-6)}`.toUpperCase(), name: 'Atlas Getaways', countryCode: 'AE', createdById: creator.id } })).id
    hotelA = (await owner.hotel.create({ data: { tenantId: tenantA, name: `${suffix} Atlantis`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', timeZone: 'Asia/Dubai' } })).id
    const READ = ['booking.read']
    await user('lead', tenantA, [...READ, 'booking.confirm.manual', 'booking.on-request.resolve', 'booking.amend', 'booking.cancel', 'booking.cancel.nonrefundable', 'booking.no-show.mark', 'booking.rebook', 'booking.supplier-ref.edit', 'booking.manual.create', 'booking.view.net', 'booking.pii.view'])
    await user('resolver', tenantA, [...READ, 'booking.on-request.resolve'])
    await user('canceller', tenantA, [...READ, 'booking.cancel'])
    await user('readonly', tenantA, READ)
    await user('agx', tenantA, ['booking.view.agency', 'booking.cancel.request', 'booking.amend.request'], agencyX)
    await user('agy', tenantA, ['booking.view.agency', 'booking.cancel.request'], agencyY)
    await user('agview', tenantA, ['booking.view.agency'], agencyX)
    await user('bops', tenantB, [...READ, 'booking.confirm.manual', 'booking.on-request.resolve', 'booking.cancel', 'booking.manual.create'])
    previousFlag = process.env.ADMIN_MANUAL_BOOKING_ENABLED; process.env.ADMIN_MANUAL_BOOKING_ENABLED = 'true'
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
    for (const label of ['lead', 'resolver', 'canceller', 'readonly', 'agx', 'agy', 'agview', 'bops']) {
      const r = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', origin).send({ email: `${suffix}-${label}@example.test`, password }).expect(200)
      cookies[label] = (r.headers['set-cookie'][0] as string).split(';')[0]
    }
  })

  afterAll(async () => {
    await app?.close(); restoreOps()
    if (previousFlag === undefined) delete process.env.ADMIN_MANUAL_BOOKING_ENABLED; else process.env.ADMIN_MANUAL_BOOKING_ENABLED = previousFlag
    if (previousUrl) process.env.DATABASE_URL = previousUrl
    for (const t of [tenantA, tenantB].filter(Boolean)) {
      for (const q of [`DELETE FROM "AuditEvent" WHERE tenant_id = '${t}'`, `DELETE FROM "Booking" WHERE tenant_id = '${t}'`, `DELETE FROM "AgencyMember" WHERE tenant_id = '${t}'`, `DELETE FROM "Agency" WHERE tenant_id = '${t}'`, `DELETE FROM "Hotel" WHERE tenant_id = '${t}'`,
        `DELETE FROM "UserRole" WHERE tenant_id = '${t}'`, `DELETE FROM "RolePermission" WHERE role_id IN (SELECT id FROM "Role" WHERE tenant_id = '${t}')`, `DELETE FROM "Role" WHERE tenant_id = '${t}'`, `DELETE FROM memberships WHERE tenant_id = '${t}'`]) await owner.$executeRawUnsafe(q).catch(() => undefined)
    }
    await owner.session.deleteMany({ where: { userId: { in: userIds } } }); await owner.user.deleteMany({ where: { id: { in: userIds } } }); await owner.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB].filter(Boolean) } } })
    await owner.$disconnect()
  })

  it('BA-E01: the full journey: pending -> on request -> confirmed -> amended -> cancelled, with a timeline row, an event and an audit event for every step', async () => {
    const b = await booking('PENDING_SUPPLIER', { refundable: true })
    expect(await ok(b.id, 'lead', { action: 'recordOnRequest', expectedStatus: 'PENDING_SUPPLIER' })).toMatchObject({ status: 'ON_REQUEST', replayed: false })
    expect((await act(b.id, 'lead', { action: 'confirmOnRequest', expectedStatus: 'ON_REQUEST', supplierRef: 'SUP-1' })).status).toBe(422) // hotel confirmation number is mandatory too
    expect(await ok(b.id, 'lead', { action: 'confirmOnRequest', expectedStatus: 'ON_REQUEST', supplierRef: 'SUP-1', hotelConfirmationNo: 'HC-1' })).toMatchObject({ status: 'CONFIRMED' })
    expect(await state(b.id)).toMatchObject({ status: 'CONFIRMED', version: 1, supplierRef: 'SUP-1', hotelConfirmationNo: 'HC-1' })
    expect(await ok(b.id, 'lead', { action: 'requestAmendment', expectedStatus: 'CONFIRMED', reason: 'Move arrival one day later' })).toMatchObject({ status: 'AMEND_REQUESTED' })
    expect(await ok(b.id, 'lead', { action: 'approveAmendment', expectedStatus: 'AMEND_REQUESTED' })).toMatchObject({ status: 'CONFIRMED', version: 2 })
    expect(await ok(b.id, 'lead', { action: 'requestAmendment', expectedStatus: 'CONFIRMED', reason: 'Add a room' })).toMatchObject({ status: 'AMEND_REQUESTED' })
    expect(await ok(b.id, 'lead', { action: 'rejectAmendment', expectedStatus: 'AMEND_REQUESTED', reason: 'Hotel is full' })).toMatchObject({ status: 'CONFIRMED', version: 2 }) // rejected: no version bump
    expect(await ok(b.id, 'lead', { action: 'requestCancellation', expectedStatus: 'CONFIRMED', reason: 'Guest changed plans' })).toMatchObject({ status: 'CANCEL_REQUESTED' })
    expect((await act(b.id, 'lead', { action: 'confirmCancellation', expectedStatus: 'CANCEL_REQUESTED' })).status).toBe(422) // supplier cancellation ref is mandatory
    expect(await ok(b.id, 'lead', { action: 'confirmCancellation', expectedStatus: 'CANCEL_REQUESTED', supplierCancellationRef: 'CXL-9', confirmNonRefundable: true })).toMatchObject({ status: 'CANCELLED', version: 2 })
    const log = await events(b.id)
    expect(log.map((e) => e.action)).toEqual([null, 'recordOnRequest', 'confirmOnRequest', 'requestAmendment', 'approveAmendment', 'requestAmendment', 'rejectAmendment', 'requestCancellation', 'confirmCancellation'])
    expect(log.slice(1).map((e) => `${e.fromStatus}>${e.toStatus}`)).toEqual(['PENDING_SUPPLIER>ON_REQUEST', 'ON_REQUEST>CONFIRMED', 'CONFIRMED>AMEND_REQUESTED', 'AMEND_REQUESTED>CONFIRMED', 'CONFIRMED>AMEND_REQUESTED', 'AMEND_REQUESTED>CONFIRMED', 'CONFIRMED>CANCEL_REQUESTED', 'CANCEL_REQUESTED>CANCELLED'])
    expect(log.slice(1).every((e) => e.actorType === 'USER' && e.actorId && e.idempotencyKey && /^[0-9a-f]{64}$/.test(e.requestFingerprint ?? ''))).toBe(true)
    const d = await detail(b.id)
    expect(d.timeline.filter((t) => t.kind === 'status').map((t) => t.action)).toEqual([null, 'recordOnRequest', 'confirmOnRequest', 'requestAmendment', 'approveAmendment', 'requestAmendment', 'rejectAmendment', 'requestCancellation', 'confirmCancellation'])
    expect(d.booking).toMatchObject({ status: 'CANCELLED' }); expect(d.availableActions).toEqual([])
    const audits = await owner.auditEvent.findMany({ where: { tenantId: tenantA, entityId: b.id, action: { startsWith: 'booking.' }, NOT: { action: { startsWith: 'booking.pii' } } }, orderBy: { createdAt: 'asc' } })
    expect(audits.map((a) => a.action)).toEqual(['booking.recordOnRequest', 'booking.confirmOnRequest', 'booking.requestAmendment', 'booking.approveAmendment', 'booking.requestAmendment', 'booking.rejectAmendment', 'booking.requestCancellation', 'booking.confirmCancellation'])
    expect(audits.every((a) => a.userId && a.actorType === 'USER')).toBe(true)
  })

  it('BA-E02: illegal moves are rejected with 409 and change nothing; a closed booking is locked; Failed is never revived', async () => {
    const b = await booking('PENDING_SUPPLIER')
    for (const a of ['confirmOnRequest', 'requestCancellation', 'approveAmendment', 'markNoShow', 'confirmCancellation']) {
      const res = await act(b.id, 'lead', { action: a, expectedStatus: 'PENDING_SUPPLIER', reason: 'x', supplierRef: 's', hotelConfirmationNo: 'h', supplierCancellationRef: 'c', confirmNonRefundable: true })
      expect({ a, status: res.status, code: code(res) }).toEqual({ a, status: 409, code: 'ILLEGAL_TRANSITION' })
    }
    expect((await act(b.id, 'lead', { action: 'markCheckedOut', expectedStatus: 'PENDING_SUPPLIER' })).status).toBe(403) // system-only: no person holds it
    expect((await act(b.id, 'lead', { action: 'nonsense', expectedStatus: 'PENDING_SUPPLIER' })).status).toBe(400)
    expect(await state(b.id)).toMatchObject({ status: 'PENDING_SUPPLIER', version: 1 }); expect(await events(b.id)).toHaveLength(1)
    expect(await ok(b.id, 'lead', { action: 'recordFailed', expectedStatus: 'PENDING_SUPPLIER', reason: 'Supplier error E42' })).toMatchObject({ status: 'FAILED' })
    for (const a of ['recordConfirmed', 'recordOnRequest']) expect((await act(b.id, 'lead', { action: a, expectedStatus: 'FAILED', supplierRef: 's' })).status).toBe(409)
    expect(await ok(b.id, 'lead', { action: 'close', expectedStatus: 'FAILED', reason: 'Closed as failed' })).toMatchObject({ status: 'FAILED', closed: true })
    expect((await state(b.id)).closedAt).not.toBeNull()
    for (const a of ['close', 'recordConfirmed']) expect(code(await act(b.id, 'lead', { action: a, expectedStatus: 'FAILED', reason: 'again', supplierRef: 's' }))).toBe('BOOKING_CLOSED')
    expect(code(await post(`/${b.id}/references`, 'lead', { supplierRef: 'X', reason: 'late' }, key(), 'patch'))).toBe('BOOKING_CLOSED')
    const d = await detail(b.id); expect(d.availableActions).toEqual([]); expect(d.booking.status).toBe('FAILED')
  })

  it('BA-E03: each action needs its own permission; read access and unrelated keys grant nothing; refusals are audited', async () => {
    const b = await booking('ON_REQUEST')
    const body = { action: 'confirmOnRequest', expectedStatus: 'ON_REQUEST', supplierRef: 's', hotelConfirmationNo: 'h' }
    for (const who of ['readonly', 'canceller']) { const r = await act(b.id, who, body); expect({ who, status: r.status }).toEqual({ who, status: 403 }) }
    expect((await act(b.id, 'resolver', { action: 'recordOnRequest', expectedStatus: 'ON_REQUEST' })).status).toBe(403) // a different action's key
    expect((await act(b.id, 'resolver', { ...body, expectedStatus: 'CONFIRMED' })).status).toBe(409) // the right key, a stale view: 409, not 403
    expect(await state(b.id)).toMatchObject({ status: 'ON_REQUEST' })
    const denied = await owner.auditEvent.count({ where: { tenantId: tenantA, entityId: b.id, action: 'permission.denied' } }); expect(denied).toBeGreaterThanOrEqual(1)
    expect(await ok(b.id, 'resolver', body)).toMatchObject({ status: 'CONFIRMED' })
    // a resolver cannot cancel, amend or mark no-show even though they can read and resolve
    for (const a of ['requestCancellation', 'requestAmendment']) expect((await act(b.id, 'resolver', { action: a, expectedStatus: 'CONFIRMED', reason: 'x', confirmNonRefundable: true })).status).toBe(403)
    // no session, no write
    await request(app.getHttpServer()).post(`/api/v1/admin/operations/bookings/${b.id}/actions`).set('Origin', origin).set('Idempotency-Key', key()).send(body).expect(401)
  })

  it('BA-E04: a non-refundable or unknown-refundability booking needs booking.cancel.nonrefundable and a second confirmation', async () => {
    const nonref = await booking('CONFIRMED', { refundable: false }); const unknown = await booking('CONFIRMED', { refundable: null }); const refundable = await booking('CONFIRMED', { refundable: true })
    for (const b of [nonref, unknown]) {
      expect((await act(b.id, 'canceller', { action: 'requestCancellation', expectedStatus: 'CONFIRMED', reason: 'x', confirmNonRefundable: true })).status).toBe(403) // booking.cancel alone is not enough
      expect(code(await act(b.id, 'lead', { action: 'requestCancellation', expectedStatus: 'CONFIRMED', reason: 'x' }))).toBe('CONFIRMATION_REQUIRED')
      expect(await ok(b.id, 'lead', { action: 'requestCancellation', expectedStatus: 'CONFIRMED', reason: 'x', confirmNonRefundable: true })).toMatchObject({ status: 'CANCEL_REQUESTED' })
    }
    expect((await events(nonref.id)).at(-1)?.payload).toMatchObject({ secondConfirmation: true })
    expect(await ok(refundable.id, 'canceller', { action: 'requestCancellation', expectedStatus: 'CONFIRMED', reason: 'x', confirmNonRefundable: true })).toMatchObject({ status: 'CANCEL_REQUESTED' }) // refundable: booking.cancel suffices
  })

  it('BA-E05: an agency user can request on their own agency only; foreign and Unassigned bookings are 404; they cannot approve, and see no internal reasons', async () => {
    const mine = await booking('CONFIRMED', { agency: 'X', refundable: true }); const theirs = await booking('CONFIRMED', { agency: 'Y' }); const loose = await booking('CONFIRMED', { agency: null })
    expect((await act(theirs.id, 'agx', { action: 'requestCancellation', expectedStatus: 'CONFIRMED', reason: 'x', confirmNonRefundable: true })).status).toBe(404)
    expect((await act(loose.id, 'agx', { action: 'requestCancellation', expectedStatus: 'CONFIRMED', reason: 'x', confirmNonRefundable: true })).status).toBe(404)
    expect(code(await act(mine.id, 'agx', { action: 'requestCancellation', expectedStatus: 'CONFIRMED', reason: 'plans changed' }))).toBe('CONFIRMATION_REQUIRED') // an agency request is always double-confirmed
    expect(await ok(mine.id, 'agx', { action: 'requestCancellation', expectedStatus: 'CONFIRMED', reason: 'plans changed', confirmNonRefundable: true })).toMatchObject({ status: 'CANCEL_REQUESTED' })
    expect((await act(mine.id, 'agx', { action: 'confirmCancellation', expectedStatus: 'CANCEL_REQUESTED', supplierCancellationRef: 'c', confirmNonRefundable: true })).status).toBe(403)
    expect((await act(mine.id, 'agview', { action: 'requestCancellation', expectedStatus: 'CANCEL_REQUESTED', reason: 'x' })).status).toBe(403) // read-only agency user
    const mineAmend = await booking('CONFIRMED', { agency: 'X' })
    expect(await ok(mineAmend.id, 'agx', { action: 'requestAmendment', expectedStatus: 'CONFIRMED', reason: 'one more night' })).toMatchObject({ status: 'AMEND_REQUESTED' })
    expect((await act(mineAmend.id, 'agx', { action: 'approveAmendment', expectedStatus: 'AMEND_REQUESTED' })).status).toBe(403)
    expect((await act(mineAmend.id, 'agy', { action: 'rejectAmendment', expectedStatus: 'AMEND_REQUESTED', reason: 'x' })).status).toBe(404)
    const d = await detail(mine.id, 'agx')
    expect(d.timeline.every((t) => t.reason === null)).toBe(true) // internal reasons are operator-only
    expect(d.availableActions).toEqual([]) // CANCEL_REQUESTED: an agency user has nothing more to do
    expect((await detail(mineAmend.id, 'lead')).timeline.filter((t) => t.kind === 'status').at(-1)?.reason).toBe('one more night')
  })

  it('BA-E06: required fields are enforced and bounded, and a rejected request changes nothing', async () => {
    const b = await booking('ON_REQUEST')
    expect(code(await act(b.id, 'lead', { action: 'rejectOnRequest', expectedStatus: 'ON_REQUEST' }))).toBe('MISSING_FIELDS')
    expect(code(await act(b.id, 'lead', { action: 'rejectOnRequest', expectedStatus: 'ON_REQUEST', reason: '   ' }))).toBe('MISSING_FIELDS')
    expect(code(await act(b.id, 'lead', { action: 'rejectOnRequest', expectedStatus: 'ON_REQUEST', reason: 'x'.repeat(501) }))).toBe('FIELD_TOO_LONG')
    expect((await act(b.id, 'lead', { action: 'rejectOnRequest', expectedStatus: 'ON_REQUEST', reason: 12 })).status).toBe(400)
    expect((await act(b.id, 'lead', { action: 'rejectOnRequest' })).status).toBe(400)
    expect(await state(b.id)).toMatchObject({ status: 'ON_REQUEST' }); expect(await events(b.id)).toHaveLength(1)
    expect(await ok(b.id, 'lead', { action: 'rejectOnRequest', expectedStatus: 'ON_REQUEST', reason: 'Hotel declined' })).toMatchObject({ status: 'REJECTED' })
  })

  it('BA-E07: compare-and-set: a stale expectedStatus is a 409 naming the current status; two racing requests produce exactly one winner', async () => {
    const b = await booking('ON_REQUEST')
    const stale = await act(b.id, 'lead', { action: 'rejectOnRequest', expectedStatus: 'PENDING_SUPPLIER', reason: 'x' }); expect(stale.status).toBe(409); expect(code(stale)).toBe('STALE_STATUS')
    const race = await Promise.all([
      act(b.id, 'lead', { action: 'rejectOnRequest', expectedStatus: 'ON_REQUEST', reason: 'declined' }),
      act(b.id, 'resolver', { action: 'confirmOnRequest', expectedStatus: 'ON_REQUEST', supplierRef: 's', hotelConfirmationNo: 'h' }),
      act(b.id, 'lead', { action: 'confirmOnRequest', expectedStatus: 'ON_REQUEST', supplierRef: 's2', hotelConfirmationNo: 'h2' }),
    ])
    expect(race.map((r) => r.status).sort()).toEqual([200, 409, 409])
    const log = await events(b.id); expect(log).toHaveLength(2) // the seed row + the single winner
    expect((await state(b.id)).status).toBe(log[1].toStatus)
  })

  it('BA-E08: idempotency: a replay returns the first result without a second event or audit; the same key with a different request is a 409; the key is required', async () => {
    const b = await booking('ON_REQUEST'); const k = key()
    const body = { action: 'confirmOnRequest', expectedStatus: 'ON_REQUEST', supplierRef: 'SUP-8', hotelConfirmationNo: 'HC-8' }
    const first = (await act(b.id, 'lead', body, k).expect(200)).body.data as BookingWriteResult
    const again = (await act(b.id, 'lead', body, k).expect(200)).body.data as BookingWriteResult // status is CONFIRMED now: the replay still succeeds
    expect(first.replayed).toBe(false); expect(again).toMatchObject({ replayed: true, status: 'CONFIRMED', reference: first.reference })
    expect(await events(b.id)).toHaveLength(2)
    expect(await owner.auditEvent.count({ where: { tenantId: tenantA, entityId: b.id, action: 'booking.confirmOnRequest' } })).toBe(1)
    expect(code(await act(b.id, 'lead', { ...body, supplierRef: 'DIFFERENT' }, k))).toBe('IDEMPOTENCY_CONFLICT')
    expect(code(await act(b.id, 'lead', { action: 'requestAmendment', expectedStatus: 'CONFIRMED', reason: 'a' }, k))).toBe('IDEMPOTENCY_CONFLICT')
    for (const bad of [null, 'short', 'has spaces in it!!', 'x'.repeat(129)]) expect({ bad, code: code(await act(b.id, 'lead', { action: 'requestAmendment', expectedStatus: 'CONFIRMED', reason: 'a' }, bad)) }).toEqual({ bad, code: 'IDEMPOTENCY_KEY_REQUIRED' })
    expect(await state(b.id)).toMatchObject({ status: 'CONFIRMED' })
  })

  it('BA-E09: the audit event and the status change commit together, and no free-text reason or guest data reaches the audit log', async () => {
    const b = await booking('CONFIRMED', { refundable: true })
    await ok(b.id, 'lead', { action: 'requestAmendment', expectedStatus: 'CONFIRMED', reason: SECRET_REASON })
    const audit = await owner.auditEvent.findMany({ where: { tenantId: tenantA, entityId: b.id } })
    const serialised = JSON.stringify(audit.map((a) => a.payload))
    expect(serialised).not.toContain('Zaphod'); expect(serialised).not.toContain('+971'); expect(serialised).not.toContain('Haddad')
    expect(audit.find((a) => a.action === 'booking.requestAmendment')?.payload).toMatchObject({ bookingAction: 'requestAmendment', from: 'CONFIRMED', to: 'AMEND_REQUESTED', permission: 'booking.amend', level: 'OPERATOR', reasonGiven: true })
    // the reason lives in the immutable event, readable only by operators
    expect((await events(b.id)).at(-1)?.reason).toBe(SECRET_REASON)
    // atomic: a request refused after the audit would have been written leaves neither (here: a stale status after a permitted actor)
    const before = await owner.auditEvent.count({ where: { tenantId: tenantA, entityId: b.id } })
    await act(b.id, 'lead', { action: 'requestAmendment', expectedStatus: 'CONFIRMED', reason: 'again' }).expect(409)
    expect(await owner.auditEvent.count({ where: { tenantId: tenantA, entityId: b.id, action: { startsWith: 'booking.' } } })).toBe(before)
  })

  it('BA-E10: editing references is permissioned, audited, idempotent, bounded and never touches the status; clearing the missing-reference flag works', async () => {
    const b = await booking('CONFIRMED', { supplierRef: null })
    expect((await detail(b.id)).booking.missingSupplierRef).toBe(true)
    expect((await post(`/${b.id}/references`, 'resolver', { supplierRef: 'S1', reason: 'x' }, key(), 'patch')).status).toBe(403)
    expect((await post(`/${b.id}/references`, 'agx', { supplierRef: 'S1', reason: 'x' }, key(), 'patch')).status).toBe(403)
    expect(code(await post(`/${b.id}/references`, 'lead', { supplierRef: 'S1' }, key(), 'patch'))).toBe('MISSING_FIELDS')
    expect((await post(`/${b.id}/references`, 'lead', { supplierRef: 'S'.repeat(65), reason: 'x' }, key(), 'patch')).status).toBe(400)
    const k = key(); const body = { supplierRef: 'SUP-77', hotelConfirmationNo: 'HC-77', reason: 'Phoned the hotel' }
    const r = (await post(`/${b.id}/references`, 'lead', body, k, 'patch').expect(200)).body.data as BookingWriteResult
    expect(r).toMatchObject({ status: 'CONFIRMED', replayed: false }); expect((await post(`/${b.id}/references`, 'lead', body, k, 'patch').expect(200)).body.data.replayed).toBe(true)
    expect(code(await post(`/${b.id}/references`, 'lead', { ...body, supplierRef: 'OTHER' }, k, 'patch'))).toBe('IDEMPOTENCY_CONFLICT')
    expect(await state(b.id)).toMatchObject({ status: 'CONFIRMED', supplierRef: 'SUP-77', hotelConfirmationNo: 'HC-77' })
    expect((await detail(b.id)).booking.missingSupplierRef).toBe(false)
    const last = (await events(b.id)).at(-1)!; expect(last).toMatchObject({ action: 'editReferences', fromStatus: 'CONFIRMED', toStatus: 'CONFIRMED' }); expect(last.payload).toMatchObject({ changed: { supplierRef: { from: null, to: 'SUP-77' } } })
    expect(code(await post(`/${b.id}/references`, 'lead', { supplierRef: 'SUP-77', reason: 'same' }, key(), 'patch'))).toBe('NO_CHANGE')
    expect(await owner.auditEvent.count({ where: { tenantId: tenantA, entityId: b.id, action: 'booking.references.edited' } })).toBe(1)
  })

  it('BA-E11: no-show only within 7 days of check-in, with a reason; later it is refused', async () => {
    const inside = await booking('CHECKED_OUT', { checkIn: -3 }); const outside = await booking('CHECKED_OUT', { checkIn: -9 })
    expect(code(await act(outside.id, 'lead', { action: 'markNoShow', expectedStatus: 'CHECKED_OUT', reason: 'late report' }))).toBe('NO_SHOW_WINDOW')
    expect(code(await act(inside.id, 'lead', { action: 'markNoShow', expectedStatus: 'CHECKED_OUT' }))).toBe('MISSING_FIELDS')
    expect(await ok(inside.id, 'lead', { action: 'markNoShow', expectedStatus: 'CHECKED_OUT', reason: 'Hotel reported no-show' })).toMatchObject({ status: 'NO_SHOW' })
  })

  it('BA-E12: another operator tenant cannot act on this booking (404), and cannot see it', async () => {
    const b = await booking('ON_REQUEST')
    expect((await act(b.id, 'bops', { action: 'rejectOnRequest', expectedStatus: 'ON_REQUEST', reason: 'x' })).status).toBe(404)
    expect((await post(`/${b.id}/references`, 'bops', { supplierRef: 'S', reason: 'x' }, key(), 'patch')).status).toBe(403) // bops lacks the references permission
    expect(await state(b.id)).toMatchObject({ status: 'ON_REQUEST' })
  })

  const manual = (over: Record<string, unknown> = {}) => ({ agencyId: agencyX, hotelId: hotelA, supplier: 'Supplier One', checkIn: ymd(30), checkOut: ymd(33), currency: 'AED', sellMinor: '250000', netMinor: '200000', paymentMode: 'CREDIT', isRefundable: true,
    rooms: [{ roomName: 'Deluxe Sea View', boardCode: 'BB', adults: 2, children: 1, childAges: [6] }], guests: [{ firstName: 'Amira', lastName: 'Haddad' }, { firstName: 'Sam', lastName: 'Haddad', type: 'CHILD', age: 6 }], ...over })
  it('BA-E13: manual entry: behind the flag and the permission; creates a Pending-supplier booking with the standard reference, moves no money and calls no supplier', async () => {
    process.env.ADMIN_MANUAL_BOOKING_ENABLED = 'false'
    try {
      expect(code(await post('', 'lead', manual()))).toBe('MANUAL_BOOKING_DISABLED')
      expect((await request(app.getHttpServer()).get('/api/v1/admin/operations/bookings').set('Cookie', cookies.lead)).body.data.access.manualEntry).toBe(false)
    } finally { process.env.ADMIN_MANUAL_BOOKING_ENABLED = 'true' }
    expect((await request(app.getHttpServer()).get('/api/v1/admin/operations/bookings').set('Cookie', cookies.lead)).body.data.access.manualEntry).toBe(true)
    expect((await request(app.getHttpServer()).get('/api/v1/admin/operations/bookings').set('Cookie', cookies.readonly)).body.data.access.manualEntry).toBe(false)
    expect((await post('', 'readonly', manual())).status).toBe(403); expect((await post('', 'resolver', manual())).status).toBe(403); expect((await post('', 'agx', manual())).status).toBe(403)
    const counts = async () => JSON.stringify([await owner.supplierMutation.count({ where: { tenantId: tenantA } }), await owner.inventoryHold.count({ where: { tenantId: tenantA } }), await owner.ledgerEntry.count({ where: { tenantId: tenantA } })])
    const before = await counts(); const k = key()
    const created = (await post('', 'lead', manual(), k).expect(201)).body.data as BookingWriteResult
    expect(created).toMatchObject({ status: 'PENDING_SUPPLIER', version: 1, replayed: false }); expect(created.reference).toMatch(/^FB-[0-9A-F]{20}$/)
    expect(await counts()).toBe(before)
    const row = await owner.booking.findUniqueOrThrow({ where: { id: created.bookingId }, include: { rooms: true, guests: true } })
    expect(row).toMatchObject({ channel: 'MANUAL', agencyId: agencyX, hotelId: hotelA, totalMinor: 250000n, netMinor: 200000n, markupMinor: 50000n, currency: 'AED', nights: 3, paymentMode: 'CREDIT', isRefundable: true })
    expect(row.rooms).toHaveLength(1); expect(row.guests.filter((g) => g.isLead)).toHaveLength(1); expect(row.guests).toHaveLength(2)
    expect((await events(created.bookingId)).map((e) => [e.fromStatus, e.toStatus, e.action, e.actorType])).toEqual([[null, 'PENDING_SUPPLIER', 'createManual', 'USER']])
    expect((await owner.auditEvent.findFirstOrThrow({ where: { tenantId: tenantA, entityId: created.bookingId, action: 'booking.manual.created' } })).payload).toMatchObject({ channel: 'MANUAL', sellMinor: '250000' })
    expect(JSON.stringify((await owner.auditEvent.findMany({ where: { tenantId: tenantA, entityId: created.bookingId } })).map((a) => a.payload))).not.toMatch(/Amira|Haddad/)
    // replay, then conflict, then the new booking is a normal citizen of the lifecycle
    expect((await post('', 'lead', manual(), k).expect(201)).body.data).toMatchObject({ replayed: true, bookingId: created.bookingId })
    expect(code(await post('', 'lead', manual({ sellMinor: '999' }), k))).toBe('IDEMPOTENCY_CONFLICT')
    expect(await owner.booking.count({ where: { tenantId: tenantA, channel: 'MANUAL' } })).toBe(1)
    expect(await ok(created.bookingId, 'lead', { action: 'recordConfirmed', expectedStatus: 'PENDING_SUPPLIER', supplierRef: 'PHONE-1' })).toMatchObject({ status: 'CONFIRMED' })
    const d = await detail(created.bookingId); expect(d.booking).toMatchObject({ channel: 'MANUAL', status: 'CONFIRMED' })
  })

  it('BA-E14: manual entry refuses bad input: decimals, bad dates, foreign hotel or agency, inactive agency, disabled currency', async () => {
    const before = await owner.booking.count({ where: { tenantId: tenantA } })
    for (const [label, over] of Object.entries({ decimal: { sellMinor: '12.50' }, negative: { sellMinor: '-1' }, number: { sellMinor: 5000 }, dates: { checkOut: ymd(30) }, fakeDate: { checkIn: '2030-02-31' }, noGuests: { guests: [] }, ages: { rooms: [{ roomName: 'x', adults: 2, children: 1, childAges: [] }] } })) {
      const r = await post('', 'lead', manual(over)); expect({ label, status: r.status }).toEqual({ label, status: 400 })
    }
    expect(code(await post('', 'lead', manual({ hotelId: 'nope' })))).toBe('HOTEL_NOT_FOUND')
    expect(code(await post('', 'lead', manual({ agencyId: 'nope' })))).toBe('AGENCY_NOT_FOUND')
    expect(code(await post('', 'lead', manual(), null))).toBe('IDEMPOTENCY_KEY_REQUIRED')
    await owner.agency.update({ where: { id: agencyY }, data: { status: 'SUSPENDED' } })
    try { expect(code(await post('', 'lead', manual({ agencyId: agencyY })))).toBe('AGENCY_NOT_ACTIVE') } finally { await owner.agency.update({ where: { id: agencyY }, data: { status: 'ACTIVE' } }) }
    expect(await owner.booking.count({ where: { tenantId: tenantA } })).toBe(before)
  })

  it('BA-E15: a strict API role still cannot write a booking, and the lifecycle log stays append-only', async () => {
    const b = await booking('ON_REQUEST')
    const api = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL })
    try {
      await expect(api.$transaction(async (tx) => { await tx.$executeRawUnsafe(`SELECT set_config('app.current_tenant_id', '${tenantA}', true)`); await tx.booking.updateMany({ where: { id: b.id }, data: { status: 'CONFIRMED' } }) })).rejects.toThrow(/permission denied|42501/i)
    } finally { await api.$disconnect() }
    await expect(owner.$executeRawUnsafe(`UPDATE "BookingEvent" SET reason = 'tamper' WHERE booking_id = '${b.id}'`)).rejects.toThrow(/append-only/)
    expect(await state(b.id)).toMatchObject({ status: 'ON_REQUEST' })
  })
})
