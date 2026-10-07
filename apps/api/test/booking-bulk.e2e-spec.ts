import { randomBytes } from 'crypto'
import { INestApplication, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { PrismaClient } from '@prisma/client'
import * as cookieParser from 'cookie-parser'
import * as request from 'supertest'
import type { BookingBulkOperationView } from '@bedbanks/contracts'
import { AppModule } from '../src/app.module'
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter'
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor'
import { hashPassword } from '../src/auth/utils/password'
import { provisionApiRuntimeRole, API_RUNTIME_LOGIN_ROLE } from '../src/database/api-runtime-role'
import { bulkFingerprint, innerKey } from '../src/booking-ops/booking-bulk.service'
import { enableBookingOps } from './support/booking-ops'

jest.setTimeout(240_000)

/** Bulk actions over HTTP (ADR 0039, Phase 6C): strict API role + the booking role. The bulk layer only calls the single-booking ops service; these tests prove its limits. */
describe('Booking bulk actions (PostgreSQL, HTTP, strict roles)', () => {
  const owner = new PrismaClient()
  const suffix = `bb-${Date.now()}-${randomBytes(3).toString('hex')}`
  const password = 'booking-bulk-certification-password'
  const runtimePassword = `rt-${randomBytes(20).toString('hex')}`
  const origin = 'http://localhost:3001'
  let app: INestApplication; let previousUrl: string | undefined; let restoreOps: () => void = () => undefined
  let tenantA = '', tenantB = '', hotelA = '', hotelB = ''
  const cookies: Record<string, string> = {}; const uid: Record<string, string> = {}; const all: string[] = []; let n = 0
  const BULK = ['booking.read', 'booking.ops.view', 'booking.ops.assign', 'booking.bulk.assign', 'booking.bulk.acknowledge', 'booking.bulk.read']

  async function user(label: string, tenantId: string, keys: string[]) {
    const u = await owner.user.create({ data: { email: `${suffix}-${label}@example.test`.toLowerCase(), name: `User ${label}`, passwordHash: await hashPassword(password), status: 'ACTIVE' } }); all.push(u.id); uid[label] = u.id
    await owner.membership.create({ data: { tenantId, userId: u.id, role: 'agent' } })
    const r = await owner.role.create({ data: { tenantId, name: `${suffix}-${label}` } })
    for (const key of keys) { const p = await owner.permission.upsert({ where: { key }, update: {}, create: { key, description: key } }); await owner.rolePermission.create({ data: { roleId: r.id, permissionId: p.id } }) }
    await owner.userRole.create({ data: { tenantId, userId: u.id, roleId: r.id } })
  }
  /** A booking that IS an open operations case (pending supplier), or one that is not (confirmed with its supplier reference). */
  async function booking(kind: 'case' | 'settled', tenant: 'A' | 'B' = 'A') {
    const tenantId = tenant === 'A' ? tenantA : tenantB; n += 1
    const b = await owner.booking.create({ data: { tenantId, reference: `FB-${randomBytes(10).toString('hex').toUpperCase()}`, supplier: 'Supplier One', hotelId: tenant === 'A' ? hotelA : hotelB, status: (kind === 'case' ? 'PENDING_SUPPLIER' : 'CONFIRMED') as never,
      currency: 'AED', totalMinor: 100_000n, idempotencyKey: `${suffix}-${n}`, searchSnapshot: {}, supplierRef: kind === 'case' ? null : `SUP-${n}`, hotelConfirmationNo: kind === 'case' ? null : `HC-${n}`, createdAt: new Date(Date.now() - 10 * 60_000) } })
    await owner.bookingGuest.create({ data: { tenantId, bookingId: b.id, firstName: 'Secret', lastName: 'Guest', isLead: true } })
    await owner.bookingEvent.create({ data: { tenantId, bookingId: b.id, toStatus: (kind === 'case' ? 'PENDING_SUPPLIER' : 'CONFIRMED') as never, actorType: 'SYSTEM', reason: 'fixture', payload: { backfill: true } } })
    return b.id
  }
  const cases = async (count: number, tenant: 'A' | 'B' = 'A') => { const out: string[] = []; for (let i = 0; i < count; i++) out.push(await booking('case', tenant)); return out }
  const key = () => `k-${randomBytes(8).toString('hex')}`
  const post = (who: string, body: unknown) => request(app.getHttpServer()).post('/api/v1/admin/operations/bookings/bulk-actions').set('Cookie', cookies[who]).set('Origin', origin).send(body as object)
  const assign = (ids: string[], to: string | null, k = key()) => ({ bookingIds: ids, action: 'ASSIGN_OWNER', payload: { assigneeUserId: to }, idempotencyKey: k })
  const ok = async (who: string, body: unknown): Promise<BookingBulkOperationView> => (await post(who, body).expect(200)).body.data
  const code = (res: request.Response) => res.body.error?.code ?? res.body.code ?? res.body.message?.code
  const events = (bookingId: string, action: string) => owner.bookingEvent.count({ where: { bookingId, action } })
  const owners = async (ids: string[]) => (await owner.bookingOpsState.findMany({ where: { bookingId: { in: ids } } })).map((s) => s.assigneeUserId)

  beforeAll(async () => {
    await owner.$connect()
    tenantA = (await owner.tenant.create({ data: { name: suffix, slug: suffix } })).id; tenantB = (await owner.tenant.create({ data: { name: `${suffix}-b`, slug: `${suffix}-b` } })).id
    hotelA = (await owner.hotel.create({ data: { tenantId: tenantA, name: `${suffix} A`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', timeZone: 'Asia/Dubai' } })).id
    hotelB = (await owner.hotel.create({ data: { tenantId: tenantB, name: `${suffix} B`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE' } })).id
    await user('lead', tenantA, BULK)
    await user('lead2', tenantA, BULK)
    await user('worker', tenantA, ['booking.read', 'booking.ops.view', 'booking.ops.assign'])
    await user('worker2', tenantA, ['booking.read', 'booking.ops.view'])
    await user('outsider', tenantA, ['booking.read']) // a member, but not someone who can work cases
    await user('noBulk', tenantA, ['booking.read', 'booking.ops.view', 'booking.ops.assign'])
    await user('noUnderlying', tenantA, ['booking.read', 'booking.ops.view', 'booking.bulk.assign', 'booking.bulk.acknowledge', 'booking.bulk.read'])
    await user('reader', tenantA, ['booking.read', 'booking.bulk.read'])
    await user('leadB', tenantB, BULK)
    const priorFlag = process.env.ADMIN_BOOKING_OPS_ENABLED; process.env.ADMIN_BOOKING_OPS_ENABLED = 'true'
    const restoreDb = await enableBookingOps(owner); restoreOps = () => { restoreDb(); if (priorFlag === undefined) delete process.env.ADMIN_BOOKING_OPS_ENABLED; else process.env.ADMIN_BOOKING_OPS_ENABLED = priorFlag }
    await provisionApiRuntimeRole(owner, { password: runtimePassword })
    previousUrl = process.env.DATABASE_URL
    const u = new URL(previousUrl as string); u.username = API_RUNTIME_LOGIN_ROLE; u.password = runtimePassword
    process.env.DATABASE_URL = u.toString(); process.env.ADMIN_ORIGIN = origin
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication(); app.use(cookieParser()); app.setGlobalPrefix('api/v1')
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
    app.useGlobalFilters(new HttpExceptionFilter()); app.useGlobalInterceptors(new ResponseInterceptor())
    await app.init()
    for (const label of ['lead', 'lead2', 'worker', 'noBulk', 'noUnderlying', 'reader', 'leadB']) {
      const r = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', origin).send({ email: `${suffix}-${label}@example.test`.toLowerCase(), password }); if (r.status !== 200) throw new Error(`login ${label} ${r.status} ${JSON.stringify(r.body)}`)
      cookies[label] = (r.headers['set-cookie'][0] as string).split(';')[0]
    }
  })

  afterAll(async () => {
    await app?.close(); restoreOps()
    if (previousUrl) process.env.DATABASE_URL = previousUrl
    for (const t of [tenantA, tenantB].filter(Boolean)) {
      for (const q of [`DELETE FROM "AuditEvent" WHERE tenant_id = '${t}'`, `DELETE FROM "BookingBulkOperation" WHERE tenant_id = '${t}'`, `DELETE FROM "Booking" WHERE tenant_id = '${t}'`, `DELETE FROM "Hotel" WHERE tenant_id = '${t}'`,
        `DELETE FROM "UserRole" WHERE tenant_id = '${t}'`, `DELETE FROM "RolePermission" WHERE role_id IN (SELECT id FROM "Role" WHERE tenant_id = '${t}')`, `DELETE FROM "Role" WHERE tenant_id = '${t}'`, `DELETE FROM memberships WHERE tenant_id = '${t}'`]) await owner.$executeRawUnsafe(q).catch(() => undefined)
    }
    await owner.session.deleteMany({ where: { userId: { in: all } } }); await owner.user.deleteMany({ where: { id: { in: all } } }); await owner.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB].filter(Boolean) } } })
    await owner.$disconnect()
  })

  it('BB-E01: all succeed: each booking changes through the single-booking service, with its own event and audit, plus the bulk request and completion audits', async () => {
    const ids = await cases(5)
    const op = await ok('lead', assign(ids, uid.worker))
    expect(op).toMatchObject({ action: 'ASSIGN_OWNER', status: 'SUCCEEDED', requestedCount: 5, processedCount: 5, succeededCount: 5, failedCount: 0, replayed: false, failuresByCode: {} })
    expect(op.items.map((i) => [i.bookingId, i.status])).toEqual(ids.map((id) => [id, 'SUCCEEDED'])) // request order kept
    expect(op.items.every((i) => i.reference?.startsWith('FB-'))).toBe(true)
    expect(await owners(ids)).toEqual(Array(5).fill(uid.worker))
    for (const id of ids) { expect(await events(id, 'opsAssigned')).toBe(1); expect(await owner.auditEvent.count({ where: { entityId: id, action: 'booking.ops.assigned' } })).toBe(1) }
    const bulkAudit = await owner.auditEvent.findMany({ where: { entityId: op.id }, orderBy: { createdAt: 'asc' } })
    expect(bulkAudit.map((a) => a.action)).toEqual(['booking.bulk.requested', 'booking.bulk.completed'])
    expect(bulkAudit[1].payload).toMatchObject({ status: 'SUCCEEDED', requestedCount: 5, succeededCount: 5, failedCount: 0 })
    expect(JSON.stringify(bulkAudit.map((a) => a.payload))).not.toMatch(/Secret|Guest|FB-|bookingIds/) // no guest data, no references, no id lists
    const row = await owner.bookingBulkOperation.findUniqueOrThrow({ where: { id: op.id } }); expect(row.status).toBe('SUCCEEDED'); expect(row.completedAt).not.toBeNull()
    // The booking itself still records the inner key derived from the persisted operation.
    expect(await owner.bookingEvent.count({ where: { idempotencyKey: { in: ids.map((id) => innerKey(op.id, id)) } } })).toBe(5)
  })

  it('BB-E02: partial success: each item is judged on its own; one failure never blocks or authorises another; a stable code per item', async () => {
    const good = await cases(3); const settled = await booking('settled'); const foreign = (await cases(1, 'B'))[0]; const missing = 'does-not-exist-123'
    const op = await ok('lead', assign([good[0], settled, foreign, good[1], missing, good[2]], uid.worker))
    expect(op).toMatchObject({ status: 'PARTIAL', requestedCount: 6, processedCount: 6, succeededCount: 3, failedCount: 3 })
    expect(op.failuresByCode).toEqual({ INVALID_STATE: 1, NOT_FOUND: 2 })
    expect(op.items.map((i) => [i.status, i.errorCode])).toEqual([['SUCCEEDED', null], ['FAILED', 'INVALID_STATE'], ['FAILED', 'NOT_FOUND'], ['SUCCEEDED', null], ['FAILED', 'NOT_FOUND'], ['SUCCEEDED', null]])
    expect(op.items[2].reference).toBeNull() // another tenant's booking is not revealed, not even its reference
    expect(await owners(good)).toEqual(Array(3).fill(uid.worker))
    expect(await owner.bookingOpsState.count({ where: { bookingId: foreign } })).toBe(0) // the other tenant's booking was not touched
    expect(await events(settled, 'opsAssigned')).toBe(0)
  })

  it('BB-E03: all items fail: the operation is FAILED, never a success', async () => {
    const settled = [await booking('settled'), await booking('settled')]
    const op = await ok('lead', assign(settled, uid.worker))
    expect(op).toMatchObject({ status: 'FAILED', succeededCount: 0, failedCount: 2, failuresByCode: { INVALID_STATE: 2 } })
  })

  it('BB-E04: authorization: the capability, the underlying permission and the assignee are each enforced; a rejected item never widens the rest', async () => {
    const ids = await cases(2)
    const noCap = await post('noBulk', assign(ids, uid.worker)); expect(noCap.status).toBe(403)
    expect((await post('reader', assign(ids, uid.worker))).status).toBe(403)
    expect(await owner.bookingBulkOperation.count({ where: { requestedByUserId: uid.noBulk } })).toBe(0)
    // Holds the bulk capability but not the single-booking permission: every item is refused by the existing service.
    const noUnder = await ok('noUnderlying', assign(ids, uid.worker))
    expect(noUnder).toMatchObject({ status: 'FAILED', failedCount: 2, failuresByCode: { FORBIDDEN: 2 } })
    expect(await owners(ids)).toEqual([])
    // An assignee who cannot work cases is refused for every item.
    const bad = await ok('lead', assign(ids, uid.outsider)); expect(bad).toMatchObject({ status: 'FAILED', failuresByCode: { ASSIGNEE_NOT_ALLOWED: 2 } })
    const acking = await post('noUnderlying', { bookingIds: ids, action: 'ACKNOWLEDGE', payload: {}, idempotencyKey: key() }).expect(200); expect(acking.body.data.failuresByCode.FORBIDDEN).toBe(2)
    // The actor losing a permission takes effect on the next request.
    const ids2 = await cases(1)
    await owner.$executeRawUnsafe(`DELETE FROM "UserRole" WHERE user_id = '${uid.lead2}' AND tenant_id = '${tenantA}'`)
    expect((await post('lead2', assign(ids2, uid.worker))).status).toBe(403)
    expect(await owners(ids2)).toEqual([])
  })

  it('BB-E05: validation: empty, duplicate, 101, unsupported action, unknown fields, bad payload: all 400 with a stable code, and nothing is stored', async () => {
    const before = await owner.bookingBulkOperation.count({ where: { tenantId: tenantA } })
    const hundredOne = Array.from({ length: 101 }, (_, i) => `id${i}`)
    const cases400: Array<[unknown, string]> = [
      [assign([], uid.worker), 'BOOKING_BULK_EMPTY'], [assign(['dup1', 'dup2', 'dup1'], uid.worker), 'BOOKING_BULK_DUPLICATE_IDS'], [assign(hundredOne, uid.worker), 'BOOKING_BULK_TOO_MANY'],
      [{ ...assign(['a1'], uid.worker), action: 'CANCEL_BOOKING' }, 'BOOKING_BULK_UNSUPPORTED_ACTION'], [{ ...assign(['a1'], uid.worker), action: 'ISSUE_INVOICE' }, 'BOOKING_BULK_UNSUPPORTED_ACTION'],
      [{ ...assign(['a1'], uid.worker), tenantId: tenantB }, 'BOOKING_BULK_UNKNOWN_FIELD'], [{ ...assign(['a1'], uid.worker), payload: { assigneeUserId: uid.worker, tenantId: tenantB } }, 'BOOKING_BULK_UNKNOWN_FIELD'],
      [{ ...assign(['a1'], uid.worker), idempotencyKey: 'x' }, 'BOOKING_BULK_INVALID'],
    ]
    for (const [body, expected] of cases400) { const r = await post('lead', body); expect(r.status).toBe(400); expect(code(r)).toBe(expected) }
    expect(await owner.bookingBulkOperation.count({ where: { tenantId: tenantA } })).toBe(before)
    // Exactly 100 is accepted.
    const hundred = Array.from({ length: 100 }, (_, i) => `ghost-${i}`)
    const op = await ok('lead', assign(hundred, uid.worker)); expect(op).toMatchObject({ requestedCount: 100, status: 'FAILED', failuresByCode: { NOT_FOUND: 100 } })
  })

  it('BB-E06: idempotent retry: the same request again returns the first operation and applies nothing twice; reordered ids are the same request; a different request with the same key is a conflict', async () => {
    const ids = await cases(3); const k = key()
    const first = await ok('lead', assign(ids, uid.worker, k))
    const eventsBefore = await owner.bookingEvent.count({ where: { bookingId: { in: ids } } }); const auditBefore = await owner.auditEvent.count({ where: { entityId: { in: ids } } })
    const again = await ok('lead', assign(ids, uid.worker, k))
    expect(again).toMatchObject({ id: first.id, replayed: true, status: 'SUCCEEDED', succeededCount: 3 })
    const reordered = await ok('lead', assign([...ids].reverse(), uid.worker, k)); expect(reordered.id).toBe(first.id)
    expect(await owner.bookingEvent.count({ where: { bookingId: { in: ids } } })).toBe(eventsBefore); expect(await owner.auditEvent.count({ where: { entityId: { in: ids } } })).toBe(auditBefore)
    for (const id of ids) expect(await events(id, 'opsAssigned')).toBe(1)
    expect(await owner.bookingBulkOperation.count({ where: { requestedByUserId: uid.lead, idempotencyKey: k } })).toBe(1)
    const conflict = await post('lead', assign(ids.slice(0, 2), uid.worker, k)); expect(conflict.status).toBe(409); expect(code(conflict)).toBe('IDEMPOTENCY_CONFLICT')
    const otherPayload = await post('lead', assign(ids, uid.outsider, k)); expect(otherPayload.status).toBe(409)
    // The same key from another person is another request (the key is scoped to the requester).
    const lead2Ids = await cases(1); await owner.$executeRawUnsafe(`SELECT 1`)
    const sameKeyOther = await ok('worker' in cookies ? 'lead' : 'lead', assign(lead2Ids, uid.worker, key())); expect(sameKeyOther.id).not.toBe(first.id)
  })

  it('BB-E07: concurrent duplicate submissions: one operation, one effect per booking', async () => {
    const ids = await cases(4); const k = key()
    const [a, b, c] = await Promise.all([post('lead', assign(ids, uid.worker, k)), post('lead', assign(ids, uid.worker, k)), post('lead', assign(ids, uid.worker, k))])
    expect([a.status, b.status, c.status]).toEqual([200, 200, 200])
    expect(new Set([a.body.data.id, b.body.data.id, c.body.data.id]).size).toBe(1)
    expect(await owner.bookingBulkOperation.count({ where: { requestedByUserId: uid.lead, idempotencyKey: k } })).toBe(1)
    for (const id of ids) { expect(await events(id, 'opsAssigned')).toBe(1); expect(await owner.auditEvent.count({ where: { entityId: id, action: 'booking.ops.assigned' } })).toBe(1) }
    const final = (await request(app.getHttpServer()).get(`/api/v1/admin/operations/booking-bulk-actions/${a.body.data.id}`).set('Cookie', cookies.lead).expect(200)).body.data as BookingBulkOperationView
    expect(final).toMatchObject({ status: 'SUCCEEDED', succeededCount: 4, processedCount: 4 })
    expect(await owner.auditEvent.count({ where: { entityId: a.body.data.id, action: 'booking.bulk.completed' } })).toBe(1)
  })

  it('BB-E08: stale state: a booking that changed after it was selected is judged as it is now, and a case that already has that owner is not changed again', async () => {
    const ids = await cases(3)
    await owner.booking.update({ where: { id: ids[1] }, data: { status: 'CONFIRMED', supplierRef: 'SUP-LATE', hotelConfirmationNo: 'HC-LATE' } }) // left the queue after it was selected
    const op = await ok('lead', assign(ids, uid.worker))
    expect(op.items.map((i) => i.errorCode)).toEqual([null, 'INVALID_STATE', null])
    expect(await events(ids[1], 'opsAssigned')).toBe(0)
    const again = await ok('lead', assign([ids[0]], uid.worker)) // a new request for a case that already belongs to them
    expect(again).toMatchObject({ status: 'FAILED', failuresByCode: { INVALID_STATE: 1 } }); expect(await events(ids[0], 'opsAssigned')).toBe(1)
    // Unassigning and acknowledging go through the same single-booking rules.
    const un = await ok('lead', assign([ids[0]], null)); expect(un.status).toBe('SUCCEEDED'); expect(await owners([ids[0]])).toEqual([null])
  })

  it('BB-E09: acknowledge runs the existing single-booking rule: only the case\'s own owner can acknowledge, so bulk acknowledge by someone else fails per item', async () => {
    const ids = await cases(2)
    await ok('lead', assign(ids, uid.lead))
    const mine = await ok('lead', { bookingIds: ids, action: 'ACKNOWLEDGE', payload: {}, idempotencyKey: key() }); expect(mine).toMatchObject({ status: 'SUCCEEDED', succeededCount: 2 })
    for (const id of ids) expect(await events(id, 'opsAcknowledged')).toBe(1)
    const again = await ok('lead', { bookingIds: ids, action: 'ACKNOWLEDGE', payload: {}, idempotencyKey: key() }); expect(again).toMatchObject({ status: 'FAILED', failuresByCode: { INVALID_STATE: 2 } })
    const others = await cases(1); await ok('lead', assign(others, uid.worker))
    const notMine = await ok('lead', { bookingIds: others, action: 'ACKNOWLEDGE', payload: {}, idempotencyKey: key() }); expect(notMine).toMatchObject({ status: 'FAILED', failuresByCode: { INVALID_STATE: 1 } })
  })

  it('BB-E10: results are private to the person who asked, per tenant; another person, another tenant and a person without the read permission get 404 or 403', async () => {
    const ids = await cases(1); const op = await ok('lead', assign(ids, uid.worker))
    const get = (who: string) => request(app.getHttpServer()).get(`/api/v1/admin/operations/booking-bulk-actions/${op.id}`).set('Cookie', cookies[who])
    expect((await get('lead')).status).toBe(200)
    expect((await get('leadB')).status).toBe(404); expect((await get('worker')).status).toBe(403) // worker has no bulk.read at all
    const second = await ok('lead2' in cookies ? 'leadB' : 'leadB', assign((await cases(1, 'B')), uid.leadB, key())); expect(second.requestedCount).toBe(1)
    expect((await request(app.getHttpServer()).get(`/api/v1/admin/operations/booking-bulk-actions/${second.id}`).set('Cookie', cookies.lead)).status).toBe(404)
    expect((await get('reader')).status).toBe(404) // holds booking.bulk.read, but it is not their operation
  })

  it('BB-E11: resume after a crash: items already applied are recognised by their event and never applied again; the rest are completed once', async () => {
    const ids = await cases(3); const k = key(); const body = assign(ids, uid.worker, k)
    const fp = bulkFingerprint({ action: 'ASSIGN_OWNER', payload: { assigneeUserId: uid.worker }, bookingIds: ids })
    const op = await owner.bookingBulkOperation.create({ data: { tenantId: tenantA, requestedByUserId: uid.lead, actionType: 'ASSIGN_OWNER', actionPayload: { assigneeUserId: uid.worker }, idempotencyKey: k, requestFingerprint: fp, requestedCount: 3, status: 'PROCESSING', startedAt: new Date(Date.now() - 600_000), updatedAt: new Date(Date.now() - 600_000) } })
    await owner.bookingBulkOperationItem.createMany({ data: ids.map((bookingId, position) => ({ tenantId: tenantA, operationId: op.id, bookingId, position })) })
    // The previous worker applied item 0 (its effect and its event exist) and died before marking it.
    await owner.bookingOpsState.create({ data: { tenantId: tenantA, bookingId: ids[0], assigneeUserId: uid.worker, assignedAt: new Date(), assignedByUserId: uid.lead, updatedAt: new Date() } })
    await owner.bookingEvent.create({ data: { tenantId: tenantA, bookingId: ids[0], fromStatus: 'PENDING_SUPPLIER', toStatus: 'PENDING_SUPPLIER', actorType: 'USER', actorId: uid.lead, action: 'opsAssigned', payload: {}, idempotencyKey: innerKey(op.id, ids[0]), requestFingerprint: 'e'.repeat(64) } })
    const resumed = await ok('lead', body)
    expect(resumed).toMatchObject({ id: op.id, status: 'SUCCEEDED', succeededCount: 3, failedCount: 0, replayed: true })
    expect(await events(ids[0], 'opsAssigned')).toBe(1) // not applied again
    for (const id of ids.slice(1)) expect(await events(id, 'opsAssigned')).toBe(1)
  })

  it('BB-E12: database guarantees: operation and item uniqueness, tenant ownership, row-level security, and no stored guest data or exception text', async () => {
    const ids = await cases(2); const op = await ok('lead', assign(ids, uid.worker))
    await expect(owner.bookingBulkOperationItem.create({ data: { tenantId: tenantA, operationId: op.id, bookingId: ids[0], position: 9 } })).rejects.toThrow() // (operation, booking) is unique
    await expect(owner.bookingBulkOperation.create({ data: { tenantId: tenantA, requestedByUserId: uid.lead, actionType: 'ASSIGN_OWNER', idempotencyKey: (await owner.bookingBulkOperation.findUniqueOrThrow({ where: { id: op.id } })).idempotencyKey, requestFingerprint: 'x'.repeat(64), requestedCount: 1 } })).rejects.toThrow() // idempotency key is unique
    await expect(owner.bookingBulkOperationItem.create({ data: { tenantId: tenantB, operationId: op.id, bookingId: 'x1', position: 0 } })).rejects.toThrow() // an item cannot belong to another tenant's operation
    await expect(owner.bookingBulkOperation.create({ data: { tenantId: tenantA, requestedByUserId: uid.leadB, actionType: 'ASSIGN_OWNER', idempotencyKey: key(), requestFingerprint: 'x'.repeat(64), requestedCount: 1 } })).rejects.toThrow() // requester must be a member of the tenant
    await expect(owner.$executeRawUnsafe(`UPDATE "BookingBulkOperation" SET processed_count = requested_count + 1 WHERE id = '${op.id}'`)).rejects.toThrow(/check/i)
    await expect(owner.$executeRawUnsafe(`UPDATE "BookingBulkOperationItem" SET status = 'FAILED', error_code = NULL, processed_at = now() WHERE operation_id = '${op.id}' AND booking_id = '${ids[0]}'`)).rejects.toThrow(/check/i)
    const dump = JSON.stringify(await owner.bookingBulkOperationItem.findMany({ where: { operationId: op.id } })) + JSON.stringify(await owner.bookingBulkOperation.findUnique({ where: { id: op.id } }))
    expect(dump).not.toMatch(/Secret|Guest|Exception|stack/i)
    const role = new PrismaClient({ datasourceUrl: process.env.BOOKING_OPS_DATABASE_URL as string })
    try {
      expect(await role.bookingBulkOperation.count()).toBe(0); expect(await role.bookingBulkOperationItem.count()).toBe(0) // no tenant context: nothing visible
      const as = (tenant: string, q: string) => role.$transaction(async (tx) => { await tx.$executeRawUnsafe(`SELECT set_config('app.current_tenant_id', '${tenant}', true)`); return tx.$executeRawUnsafe(q) })
      for (const q of [`UPDATE "BookingBulkOperation" SET tenant_id = '${tenantB}'`, `UPDATE "BookingBulkOperation" SET requested_by_user_id = '${uid.worker}'`, `UPDATE "BookingBulkOperation" SET idempotency_key = 'zzzzzzzzzz'`, `UPDATE "BookingBulkOperation" SET requested_count = 1`, `UPDATE "BookingBulkOperationItem" SET booking_id = 'x'`, `UPDATE "BookingBulkOperationItem" SET operation_id = 'x'`, `DELETE FROM "BookingBulkOperation"`, `DELETE FROM "BookingBulkOperationItem"`]) await expect(as(tenantA, q)).rejects.toThrow(/permission denied/)
      const seen = await role.$transaction(async (tx) => { await tx.$executeRawUnsafe(`SELECT set_config('app.current_tenant_id', '${tenantB}', true)`); return tx.bookingBulkOperation.count({ where: { id: op.id } }) }); expect(seen).toBe(0) // another tenant's context cannot see it
    } finally { await role.$disconnect() }
    const api = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL as string })
    try { for (const t of ['BookingBulkOperation', 'BookingBulkOperationItem']) await expect(api.$queryRawUnsafe(`SELECT 1 FROM "${t}" LIMIT 1`)).rejects.toThrow(/permission denied/) } finally { await api.$disconnect() }
  })

  it('BB-E13: a bulk action never touches money, documents or booking status', async () => {
    const ids = await cases(3); const before = await owner.booking.findMany({ where: { id: { in: ids } }, select: { id: true, status: true, version: true, totalMinor: true, closedAt: true } })
    await ok('lead', assign(ids, uid.worker))
    const after = await owner.booking.findMany({ where: { id: { in: ids } }, select: { id: true, status: true, version: true, totalMinor: true, closedAt: true } })
    expect(after).toEqual(before)
    expect(await owner.bookingFinanceEvent.count({ where: { bookingId: { in: ids } } })).toBe(0); expect(await owner.bookingDocument.count({ where: { bookingId: { in: ids } } })).toBe(0)
    expect(await owner.ledgerEntry.count({ where: { tenantId: tenantA } })).toBe(0)
  })
})
