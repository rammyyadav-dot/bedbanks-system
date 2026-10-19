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
import { API_RUNTIME_LOGIN_ROLE, provisionApiRuntimeRole } from '../src/database/api-runtime-role'
import { enableBookingOps } from './support/booking-ops'

const ownerUrl = process.env.DATABASE_URL
if (!ownerUrl) throw new Error('DATABASE_URL (the disposable owner connection) is required')

/**
 * ADR 0061 Amendment 2, slice 3: a supplier answers its own booking. The application runs as the strict API runtime role; the write goes through the
 * booking-module role and transitionBooking. Covers ownership (404 across organizations, tenants and null-supplier bookings), permission, idempotency
 * (replay, key reuse with another body), status compare-and-set, the three allowed answers, refusal of the operator-only answers, the audit event, and
 * that the API runtime role itself still cannot write a booking.
 */
describe('Supplier extranet booking answers (strict runtime role, PostgreSQL, HTTP)', () => {
  const owner = new PrismaClient({ datasourceUrl: ownerUrl })
  const suffix = `sa-${Date.now()}-${randomBytes(3).toString('hex')}`
  const password = 'supplier-answer-password'
  const runtimePassword = randomBytes(24).toString('hex')
  const origin = 'http://localhost:3001'
  let app: INestApplication
  let runtime: PrismaClient
  let restoreOps: () => void
  let previousUrl: string | undefined
  let tenantA = ''; let tenantB = ''
  let s1 = ''; let s2 = ''; let sB = ''
  let hotelA = ''; let hotelB = ''
  const userIds: string[] = []; const roleIds: string[] = []
  const emails: Record<string, string> = {}
  const cookies: Record<string, string> = {}
  let seq = 0

  async function booking(input: { tenantId?: string; supplierId: string | null; status?: 'PENDING_SUPPLIER' | 'ON_REQUEST' | 'CONFIRMED' | 'CANCEL_REQUESTED' }) {
    const tenantId = input.tenantId ?? tenantA
    const reference = `FB-${suffix.toUpperCase().replace(/[^A-Z0-9]/g, '')}${(++seq).toString().padStart(3, '0')}`
    const created = await owner.booking.create({ data: {
      tenantId, reference, supplier: 'contracted-inventory', supplierId: input.supplierId, hotelId: tenantId === tenantA ? hotelA : hotelB, status: input.status ?? 'PENDING_SUPPLIER',
      currency: 'AED', totalMinor: 150000n, netMinor: 100000n, idempotencyKey: `${suffix}-${seq}`, searchSnapshot: { marker: 'SNAPSHOT-SECRET' }, channel: 'PORTAL',
      checkIn: new Date('2099-03-01T00:00:00.000Z'), checkOut: new Date('2099-03-03T00:00:00.000Z'), nights: 2,
    } })
    await owner.bookingGuest.create({ data: { tenantId, bookingId: created.id, firstName: 'GUEST-NAME-SECRET', lastName: 'Lead', isLead: true } })
    return created.id
  }
  const row = (id: string) => owner.booking.findUniqueOrThrow({ where: { id } })
  const events = (id: string) => owner.bookingEvent.findMany({ where: { bookingId: id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  const key = () => `k-${randomBytes(8).toString('hex')}`

  beforeAll(async () => {
    await owner.$connect()
    const passwordHash = await hashPassword(password)
    tenantA = (await owner.tenant.create({ data: { name: `${suffix}a`, slug: `${suffix}a` } })).id
    tenantB = (await owner.tenant.create({ data: { name: `${suffix}b`, slug: `${suffix}b` } })).id
    const supplier = (tenantId: string, name: string) => owner.supplier.create({ data: { tenantId, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${suffix} ${name}`, displayName: name, countryCode: 'AE', defaultCurrency: 'AED' } })
    ;[s1, s2] = (await Promise.all([supplier(tenantA, 'Org1'), supplier(tenantA, 'Org2')])).map((s) => s.id)
    sB = (await supplier(tenantB, 'OrgB')).id
    hotelA = (await owner.hotel.create({ data: { tenantId: tenantA, name: `${suffix} Hotel A`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE' } })).id
    hotelB = (await owner.hotel.create({ data: { tenantId: tenantB, name: `${suffix} Hotel B`, propertyType: 'HOTEL', city: 'Muscat', countryCode: 'OM' } })).id

    const permissions = await Promise.all(['supplier.extranet.bookings.read', 'supplier.extranet.bookings.answer'].map((k) => owner.permission.upsert({ where: { key: k }, update: {}, create: { key: k, description: k } })))
    const id = (k: string) => permissions.find((p) => p.key === k)!.id
    async function user(label: string, tenantId: string, permissionIds: string[], supplierId: string) {
      const role = await owner.role.create({ data: { tenantId, name: `${suffix}-${label}` } }); roleIds.push(role.id)
      await owner.rolePermission.createMany({ data: permissionIds.map((permissionId) => ({ roleId: role.id, permissionId })) })
      const email = `${suffix}-${label}@example.test`; emails[label] = email
      const created = await owner.user.create({ data: { email, passwordHash, name: label } }); userIds.push(created.id)
      await owner.membership.create({ data: { tenantId, userId: created.id, role: 'member' } })
      await owner.userRole.create({ data: { tenantId, userId: created.id, roleId: role.id } })
      await owner.supplierMembership.create({ data: { tenantId, userId: created.id, supplierId, status: 'ACTIVE' } })
    }
    await user('s1', tenantA, [id('supplier.extranet.bookings.read'), id('supplier.extranet.bookings.answer')], s1)
    await user('s2', tenantA, [id('supplier.extranet.bookings.read'), id('supplier.extranet.bookings.answer')], s2)
    await user('readonly', tenantA, [id('supplier.extranet.bookings.read')], s1)
    await user('sb', tenantB, [id('supplier.extranet.bookings.read'), id('supplier.extranet.bookings.answer')], sB)

    restoreOps = await enableBookingOps(owner)
    await provisionApiRuntimeRole(owner, { password: runtimePassword })
    previousUrl = process.env.DATABASE_URL
    const u = new URL(ownerUrl!); u.username = API_RUNTIME_LOGIN_ROLE; u.password = runtimePassword
    process.env.DATABASE_URL = u.toString(); process.env.ADMIN_ORIGIN = origin
    runtime = new PrismaClient({ datasourceUrl: u.toString() })
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication(); app.use(cookieParser()); app.setGlobalPrefix('api/v1')
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
    app.useGlobalFilters(new HttpExceptionFilter()); app.useGlobalInterceptors(new ResponseInterceptor())
    await app.init()
    for (const label of ['s1', 's2', 'readonly', 'sb']) {
      const r = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', origin).send({ email: emails[label], password }).expect(200)
      cookies[label] = (r.headers['set-cookie'][0] as string).split(';')[0]
    }
  }, 180_000)

  afterAll(async () => {
    await app?.close(); restoreOps?.()
    await runtime?.$disconnect()
    if (previousUrl) process.env.DATABASE_URL = previousUrl
    const tenants = [tenantA, tenantB]
    await owner.$transaction(async (tx) => {
      // Booking events and finance events are append-only by trigger; the disposable fixture is removed with triggers off for this transaction only.
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`)
      await tx.bookingFinanceEvent.deleteMany({ where: { tenantId: { in: tenants } } })
      await tx.bookingGuest.deleteMany({ where: { tenantId: { in: tenants } } })
      await tx.bookingRoom.deleteMany({ where: { tenantId: { in: tenants } } })
      await tx.bookingEvent.deleteMany({ where: { tenantId: { in: tenants } } })
      await tx.booking.deleteMany({ where: { tenantId: { in: tenants } } })
    })
    await owner.auditEvent.deleteMany({ where: { tenantId: { in: tenants } } })
    await owner.supplierMembership.deleteMany({ where: { tenantId: { in: tenants } } })
    await owner.hotel.deleteMany({ where: { id: { in: [hotelA, hotelB] } } })
    await owner.supplier.deleteMany({ where: { id: { in: [s1, s2, sB] } } })
    await owner.userRole.deleteMany({ where: { userId: { in: userIds } } })
    await owner.rolePermission.deleteMany({ where: { roleId: { in: roleIds } } })
    await owner.role.deleteMany({ where: { id: { in: roleIds } } })
    await owner.membership.deleteMany({ where: { userId: { in: userIds } } })
    await owner.session.deleteMany({ where: { userId: { in: userIds } } })
    await owner.user.deleteMany({ where: { id: { in: userIds } } })
    await owner.tenant.deleteMany({ where: { id: { in: tenants } } })
    await owner.$disconnect()
  }, 60_000)

  const answer = (who: string, tenantId: string, supplierId: string, bookingId: string, body: Record<string, unknown>, idempotencyKey: string | null = key()) => {
    const t = request(app.getHttpServer()).post(`/api/v1/supplier/extranet/bookings/${bookingId}/answer`).set('Cookie', cookies[who]).set('Origin', origin).set('x-fbeds-tenant-id', tenantId).set('x-fbeds-supplier-id', supplierId)
    return (idempotencyKey ? t.set('Idempotency-Key', idempotencyKey) : t).send(body)
  }
  const code = (res: request.Response) => res.body?.error?.code ?? res.body?.code ?? res.body?.message?.code

  it('SA-01: a supplier confirms its own pending booking; status, supplier reference and the audit event are recorded', async () => {
    const id = await booking({ supplierId: s1 })
    const res = await answer('s1', tenantA, s1, id, { answer: 'CONFIRMED', expectedStatus: 'PENDING_SUPPLIER', supplierRef: 'HX-100', hotelConfirmationNo: 'HCN-9' }).expect(200)
    expect(res.body.data).toMatchObject({ bookingId: id, status: 'CONFIRMED', replayed: false })
    expect(await row(id)).toMatchObject({ status: 'CONFIRMED', supplierRef: 'HX-100', hotelConfirmationNo: 'HCN-9', supplierStatus: 'CONFIRMED' })
    const evs = await events(id); const last = evs[evs.length - 1]
    expect(last).toMatchObject({ action: 'systemConfirm', actorType: 'USER', fromStatus: 'PENDING_SUPPLIER', toStatus: 'CONFIRMED' })
    expect(last.payload).toMatchObject({ via: 'supplier_extranet', supplierId: s1, answer: 'CONFIRMED' })
    const audits = await owner.auditEvent.findMany({ where: { entityId: id, action: 'supplier.booking.answered' } })
    expect(audits).toHaveLength(1)
    expect(JSON.stringify(audits[0].payload)).not.toMatch(/GUEST-NAME-SECRET|HX-100|HCN-9/)
    expect(audits[0].payload).toMatchObject({ answer: 'CONFIRMED', from: 'PENDING_SUPPLIER', to: 'CONFIRMED', supplierId: s1 })
  })

  it('SA-02: on request, then confirm; and reject from pending and from on request', async () => {
    const a = await booking({ supplierId: s1 })
    await answer('s1', tenantA, s1, a, { answer: 'ON_REQUEST', expectedStatus: 'PENDING_SUPPLIER' }).expect(200)
    expect((await row(a)).status).toBe('ON_REQUEST')
    await answer('s1', tenantA, s1, a, { answer: 'CONFIRMED', expectedStatus: 'ON_REQUEST', supplierRef: 'HX-200' }).expect(200)
    const evsA = await events(a); expect(evsA[evsA.length - 1].action).toBe('systemConfirmOnRequest')
    expect(await row(a)).toMatchObject({ status: 'CONFIRMED', supplierRef: 'HX-200' })

    const b = await booking({ supplierId: s1 })
    await answer('s1', tenantA, s1, b, { answer: 'REJECTED', expectedStatus: 'PENDING_SUPPLIER', reason: 'No rooms left for those dates' }).expect(200)
    expect((await row(b)).status).toBe('FAILED')

    const c = await booking({ supplierId: s1, status: 'ON_REQUEST' })
    await answer('s1', tenantA, s1, c, { answer: 'REJECTED', expectedStatus: 'ON_REQUEST', reason: 'Hotel closed for renovation' }).expect(200)
    expect((await row(c)).status).toBe('REJECTED')
  })

  it('SA-03: confirm needs a supplier reference and reject needs a reason; nothing changes when they are missing', async () => {
    const id = await booking({ supplierId: s1 })
    expect(code(await answer('s1', tenantA, s1, id, { answer: 'CONFIRMED', expectedStatus: 'PENDING_SUPPLIER' }).expect(422))).toBe('MISSING_FIELDS')
    expect(code(await answer('s1', tenantA, s1, id, { answer: 'REJECTED', expectedStatus: 'PENDING_SUPPLIER', reason: 'short' }).expect(422))).toBe('MISSING_FIELDS')
    expect((await row(id)).status).toBe('PENDING_SUPPLIER')
    expect(await events(id)).toHaveLength(0)
  })

  it('SA-04: operator-only answers and unknown fields are refused by validation', async () => {
    const id = await booking({ supplierId: s1 })
    for (const bad of ['CANCELLED', 'SUPPLIER_CANCELLED', 'HAS_NO_BOOKING', 'REFUSED_CANCELLATION']) {
      await answer('s1', tenantA, s1, id, { answer: bad, expectedStatus: 'PENDING_SUPPLIER', supplierRef: 'X' }).expect(400)
    }
    await answer('s1', tenantA, s1, id, { answer: 'ON_REQUEST', expectedStatus: 'PENDING_SUPPLIER', agencyId: 'x' }).expect(400)
    expect((await row(id)).status).toBe('PENDING_SUPPLIER')
  })

  it('SA-05: an answer that does not fit the status is refused without a change (cancel-requested, already confirmed, on-request twice)', async () => {
    const cancelReq = await booking({ supplierId: s1, status: 'CANCEL_REQUESTED' })
    expect(code(await answer('s1', tenantA, s1, cancelReq, { answer: 'CONFIRMED', expectedStatus: 'CANCEL_REQUESTED', supplierRef: 'X' }).expect(400))).toBe('ANSWER_NOT_AVAILABLE')
    const done = await booking({ supplierId: s1, status: 'CONFIRMED' })
    await answer('s1', tenantA, s1, done, { answer: 'REJECTED', expectedStatus: 'CONFIRMED', reason: 'Changed our mind later' }).expect(400)
    const onReq = await booking({ supplierId: s1, status: 'ON_REQUEST' })
    await answer('s1', tenantA, s1, onReq, { answer: 'ON_REQUEST', expectedStatus: 'ON_REQUEST' }).expect(400)
    for (const [id, status] of [[cancelReq, 'CANCEL_REQUESTED'], [done, 'CONFIRMED'], [onReq, 'ON_REQUEST']] as const) expect((await row(id)).status).toBe(status)
  })

  it('SA-06: a booking owned by another organization, another tenant, or nobody is not found, and is never changed', async () => {
    const other = await booking({ supplierId: s2 }); const connector = await booking({ supplierId: null }); const tenantBBooking = await booking({ tenantId: tenantB, supplierId: sB })
    const body = { answer: 'CONFIRMED', expectedStatus: 'PENDING_SUPPLIER', supplierRef: 'X' }
    for (const id of [other, connector, tenantBBooking]) expect(code(await answer('s1', tenantA, s1, id, body).expect(404))).toBe('BOOKING_NOT_FOUND')
    expect((await row(other)).status).toBe('PENDING_SUPPLIER'); expect((await row(connector)).status).toBe('PENDING_SUPPLIER'); expect((await row(tenantBBooking)).status).toBe('PENDING_SUPPLIER')
    expect(await events(other)).toHaveLength(0)
  })

  it('SA-07: without the answer permission the route is forbidden, even with read access', async () => {
    const id = await booking({ supplierId: s1 })
    await answer('readonly', tenantA, s1, id, { answer: 'ON_REQUEST', expectedStatus: 'PENDING_SUPPLIER' }).expect(403)
    expect((await row(id)).status).toBe('PENDING_SUPPLIER')
  })

  it('SA-08: the idempotency key is required; the same key and body replays; the same key with another body is a conflict', async () => {
    const id = await booking({ supplierId: s1 })
    await answer('s1', tenantA, s1, id, { answer: 'ON_REQUEST', expectedStatus: 'PENDING_SUPPLIER' }, null).expect(400)
    await answer('s1', tenantA, s1, id, { answer: 'ON_REQUEST', expectedStatus: 'PENDING_SUPPLIER' }, 'short').expect(400)
    const k = key(); const body = { answer: 'CONFIRMED', expectedStatus: 'PENDING_SUPPLIER', supplierRef: 'HX-300' }
    const first = await answer('s1', tenantA, s1, id, body, k).expect(200)
    const eventsAfterFirst = (await events(id)).length
    const again = await answer('s1', tenantA, s1, id, body, k).expect(200)
    expect(first.body.data.replayed).toBe(false); expect(again.body.data).toMatchObject({ status: 'CONFIRMED', replayed: true })
    expect((await events(id)).length).toBe(eventsAfterFirst)
    expect(await owner.auditEvent.count({ where: { entityId: id, action: 'supplier.booking.answered' } })).toBe(1)
    expect(code(await answer('s1', tenantA, s1, id, { ...body, supplierRef: 'HX-OTHER' }, k).expect(409))).toBe('IDEMPOTENCY_CONFLICT')
    expect((await row(id)).supplierRef).toBe('HX-300')
  })

  it('SA-09: a stale expected status is a conflict; two concurrent answers produce exactly one change', async () => {
    const id = await booking({ supplierId: s1, status: 'ON_REQUEST' })
    expect(code(await answer('s1', tenantA, s1, id, { answer: 'REJECTED', expectedStatus: 'PENDING_SUPPLIER', reason: 'stale view of the booking' }).expect(409))).toBe('STALE_STATUS')
    const fresh = await booking({ supplierId: s1 })
    const results = await Promise.all([
      answer('s1', tenantA, s1, fresh, { answer: 'CONFIRMED', expectedStatus: 'PENDING_SUPPLIER', supplierRef: 'A-1' }),
      answer('s1', tenantA, s1, fresh, { answer: 'REJECTED', expectedStatus: 'PENDING_SUPPLIER', reason: 'Racing rejection attempt' }),
    ])
    expect(results.map((r) => r.status).sort()).toEqual([200, 409])
    expect(await owner.auditEvent.count({ where: { entityId: fresh, action: 'supplier.booking.answered' } })).toBe(1)
  })

  it('SA-10: a confirmation records its finance fact through the existing transition', async () => {
    const id = await booking({ supplierId: s1 })
    const before = await owner.bookingFinanceEvent.count({ where: { bookingId: id } })
    await answer('s1', tenantA, s1, id, { answer: 'CONFIRMED', expectedStatus: 'PENDING_SUPPLIER', supplierRef: 'HX-400' }).expect(200)
    expect(await owner.bookingFinanceEvent.count({ where: { bookingId: id } })).toBeGreaterThan(before)
  })

  it('SA-11: the API runtime role itself still has no write on a booking', async () => {
    const id = await booking({ supplierId: s1 })
    await expect(runtime.$executeRawUnsafe(`UPDATE "Booking" SET status = 'CONFIRMED' WHERE id = '${id}'`)).rejects.toThrow()
    await expect(runtime.$executeRawUnsafe(`UPDATE "Booking" SET supplier_ref = 'x' WHERE id = '${id}'`)).rejects.toThrow()
    expect((await row(id)).status).toBe('PENDING_SUPPLIER')
  })

  it('SA-12: the response and a failure body carry no guest, price or snapshot data', async () => {
    const id = await booking({ supplierId: s1 })
    const ok = await answer('s1', tenantA, s1, id, { answer: 'ON_REQUEST', expectedStatus: 'PENDING_SUPPLIER' }).expect(200)
    const missing = await answer('s1', tenantA, s1, id, { answer: 'CONFIRMED', expectedStatus: 'ON_REQUEST' }).expect(422)
    for (const text of [JSON.stringify(ok.body), JSON.stringify(missing.body)]) expect(text).not.toMatch(/GUEST-NAME-SECRET|SNAPSHOT-SECRET|150000|totalMinor|markup|agency/i)
  })
})
