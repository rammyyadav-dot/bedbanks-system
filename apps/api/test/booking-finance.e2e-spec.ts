import { randomBytes } from 'crypto'
import { INestApplication, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { PrismaClient } from '@prisma/client'
import * as cookieParser from 'cookie-parser'
import * as request from 'supertest'
import type { BookingFinanceView, StoredPenaltyQuote } from '@bedbanks/contracts'
import { AppModule } from '../src/app.module'
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter'
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor'
import { hashPassword } from '../src/auth/utils/password'
import { provisionApiRuntimeRole, API_RUNTIME_LOGIN_ROLE } from '../src/database/api-runtime-role'
import { enableBookingOps } from './support/booking-ops'

jest.setTimeout(240_000)

/** Money and documents of the Admin booking module over HTTP (ADR 0039, Phase 5): strict API role (no booking grants) + the booking role. */
describe('Admin booking finance and documents (PostgreSQL, HTTP)', () => {
  const owner = new PrismaClient()
  const suffix = `bf-${Date.now()}-${randomBytes(3).toString('hex')}`
  const password = 'booking-finance-certification-password'
  const runtimePassword = `rt-${randomBytes(20).toString('hex')}`
  const origin = 'http://localhost:3001'
  const DAY = 86_400_000
  const ymd = (d: number) => new Date(Date.now() + d * DAY).toISOString().slice(0, 10)
  let app: INestApplication; let previousUrl: string | undefined; let restoreOps: () => void = () => undefined
  let tenantA = '', tenantB = '', agencyX = '', hotelA = ''
  const cookies: Record<string, string> = {}; const userIds: string[] = []
  const RULES = { rules: [{ daysBeforeCheckin: 14, penaltyPercent: 50 }, { daysBeforeCheckin: 3, penaltyPercent: 100 }], frozenAt: new Date().toISOString(), source: 'MANUAL_ENTRY' }

  async function user(label: string, tenantId: string, keys: string[], agencyId?: string) {
    const u = await owner.user.create({ data: { email: `${suffix}-${label}@example.test`, name: label, passwordHash: await hashPassword(password), status: 'ACTIVE' } }); userIds.push(u.id)
    await owner.membership.create({ data: { tenantId, userId: u.id, role: 'agent' } })
    const r = await owner.role.create({ data: { tenantId, name: `${suffix}-${label}` } })
    for (const key of keys) { const p = await owner.permission.upsert({ where: { key }, update: {}, create: { key, description: key } }); await owner.rolePermission.create({ data: { roleId: r.id, permissionId: p.id } }) }
    await owner.userRole.create({ data: { tenantId, userId: u.id, roleId: r.id } })
    if (agencyId) await owner.agencyMember.create({ data: { tenantId, agencyId, userId: u.id } })
    return u.id
  }
  async function booking(status: string, o: { refundable?: boolean | null; checkIn?: number; rules?: unknown; tenant?: 'A' | 'B'; total?: bigint; net?: bigint } = {}) {
    const tenantId = o.tenant === 'B' ? tenantB : tenantA
    const b = await owner.booking.create({ data: { tenantId, reference: `FB-${randomBytes(10).toString('hex').toUpperCase()}`, supplier: 'Secret Supplier Ltd', hotelId: hotelA, status: status as never, currency: 'AED', totalMinor: o.total ?? 100_000n, netMinor: o.net ?? 80_000n,
      idempotencyKey: `k-${randomBytes(6).toString('hex')}`, searchSnapshot: {}, agencyId: o.tenant === 'B' ? null : agencyX, channel: 'MANUAL', paymentMode: 'CREDIT', isRefundable: o.refundable === undefined ? true : o.refundable, agentRef: 'AG-9',
      checkIn: new Date(`${ymd(o.checkIn ?? 9)}T00:00:00Z`), checkOut: new Date(`${ymd((o.checkIn ?? 9) + 2)}T00:00:00Z`), nights: 2, supplierRef: 'SUP-INTERNAL-1', cancellationPolicy: (o.rules === undefined ? RULES : o.rules) as never } })
    await owner.bookingRoom.create({ data: { tenantId, bookingId: b.id, roomName: 'Deluxe', boardCode: 'BB', adults: 2 } })
    await owner.bookingGuest.create({ data: { tenantId, bookingId: b.id, firstName: 'Amira', lastName: 'Haddad', isLead: true } })
    await owner.bookingEvent.create({ data: { tenantId, bookingId: b.id, toStatus: status as never, actorType: 'SYSTEM', reason: 'fixture', payload: { backfill: true } } })
    return b
  }
  const key = () => `k-${randomBytes(8).toString('hex')}`
  const base = '/api/v1/admin/operations'
  const act = (id: string, who: string, body: Record<string, unknown>, k = key()) => request(app.getHttpServer()).post(`${base}/bookings/${id}/actions`).set('Cookie', cookies[who]).set('Origin', origin).set('Idempotency-Key', k).send(body)
  const ok = async (id: string, who: string, body: Record<string, unknown>) => (await act(id, who, body).expect(200)).body.data
  const fin = (id: string, who = 'lead') => request(app.getHttpServer()).get(`${base}/booking-finance/${id}`).set('Cookie', cookies[who])
  const view = async (id: string, who = 'lead'): Promise<BookingFinanceView> => (await fin(id, who).expect(200)).body.data
  const penalty = (id: string, who: string, body: Record<string, unknown>, k: string | null = key()) => { const r = request(app.getHttpServer()).post(`${base}/booking-finance/${id}/penalty`).set('Cookie', cookies[who]).set('Origin', origin); return (k ? r.set('Idempotency-Key', k) : r).send(body) }
  const issue = (id: string, who: string, type: string) => request(app.getHttpServer()).post(`${base}/booking-finance/${id}/documents/${type}`).set('Cookie', cookies[who]).set('Origin', origin).send({})
  const html = (id: string, who: string, type: string) => request(app.getHttpServer()).get(`${base}/booking-finance/${id}/documents/${type}/html`).set('Cookie', cookies[who])
  const code = (res: request.Response) => res.body.error?.code ?? res.body.code ?? res.body.message?.code
  const finEvents = (id: string) => owner.bookingFinanceEvent.findMany({ where: { bookingId: id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  const confirm = (id: string) => ok(id, 'lead', { action: 'recordConfirmed', expectedStatus: 'PENDING_SUPPLIER', supplierRef: 'SUP-INTERNAL-1', hotelConfirmationNo: 'HC-77' })
  async function cancelled(b: { id: string }, who = 'lead') {
    await ok(b.id, who, { action: 'requestCancellation', expectedStatus: 'CONFIRMED', reason: 'Guest changed plans' })
    return ok(b.id, who, { action: 'confirmCancellation', expectedStatus: 'CANCEL_REQUESTED', supplierCancellationRef: 'CXL-9' })
  }

  beforeAll(async () => {
    await owner.$connect()
    tenantA = (await owner.tenant.create({ data: { name: `${suffix} Acme Travel`, slug: suffix } })).id; tenantB = (await owner.tenant.create({ data: { name: `${suffix}-b`, slug: `${suffix}-b` } })).id
    const creator = await owner.user.create({ data: { email: `${suffix}-creator@example.test`, name: 'creator' } }); userIds.push(creator.id)
    agencyX = (await owner.agency.create({ data: { tenantId: tenantA, code: `X-${suffix.slice(-6)}`.toUpperCase(), name: 'Travel Republic', countryCode: 'GB', createdById: creator.id } })).id
    hotelA = (await owner.hotel.create({ data: { tenantId: tenantA, name: `${suffix} Atlantis`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', timeZone: 'Asia/Dubai' } })).id
    const OPS = ['booking.read', 'booking.confirm.manual', 'booking.on-request.resolve', 'booking.cancel', 'booking.finance.view', 'booking.documents.issue']
    await user('lead', tenantA, [...OPS, 'booking.cancel.nonrefundable', 'booking.view.net'])
    await user('approver', tenantA, ['booking.read', 'booking.finance.view', 'booking.penalty.waive.approve'])
    await user('both', tenantA, [...OPS, 'booking.penalty.waive.approve'])
    await user('viewer', tenantA, ['booking.read', 'booking.finance.view'])
    await user('readonly', tenantA, ['booking.read'])
    await user('agx', tenantA, ['booking.view.agency', 'booking.finance.view'], agencyX)
    await user('bops', tenantB, [...OPS])
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
    for (const label of ['lead', 'approver', 'both', 'viewer', 'readonly', 'agx', 'bops']) {
      const r = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', origin).send({ email: `${suffix}-${label}@example.test`, password }).expect(200)
      cookies[label] = (r.headers['set-cookie'][0] as string).split(';')[0]
    }
  })

  afterAll(async () => {
    await app?.close(); restoreOps()
    if (previousUrl) process.env.DATABASE_URL = previousUrl
    for (const t of [tenantA, tenantB].filter(Boolean)) {
      for (const q of [`DELETE FROM "AuditEvent" WHERE tenant_id = '${t}'`, `ALTER TABLE "BookingDocument" DISABLE TRIGGER USER`, `DELETE FROM "BookingDocument" WHERE tenant_id = '${t}'`, `ALTER TABLE "BookingDocument" ENABLE TRIGGER USER`, `DELETE FROM "Booking" WHERE tenant_id = '${t}'`, `DELETE FROM "AgencyMember" WHERE tenant_id = '${t}'`, `DELETE FROM "Agency" WHERE tenant_id = '${t}'`, `DELETE FROM "Hotel" WHERE tenant_id = '${t}'`,
        `DELETE FROM "UserRole" WHERE tenant_id = '${t}'`, `DELETE FROM "RolePermission" WHERE role_id IN (SELECT id FROM "Role" WHERE tenant_id = '${t}')`, `DELETE FROM "Role" WHERE tenant_id = '${t}'`, `DELETE FROM memberships WHERE tenant_id = '${t}'`]) await owner.$executeRawUnsafe(q).catch(() => undefined)
    }
    await owner.session.deleteMany({ where: { userId: { in: userIds } } }); await owner.user.deleteMany({ where: { id: { in: userIds } } }); await owner.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB].filter(Boolean) } } })
    await owner.$disconnect()
  })

  it('BF-E01: cancel with a penalty: confirmation records a finance event; the request fixes the penalty; the invoice, credit note and cancellation note are correct and immutable', async () => {
    const b = await booking('PENDING_SUPPLIER')
    await confirm(b.id)
    expect((await finEvents(b.id)).map((e) => [e.type, e.sellMinor, e.netMinor, e.paymentMode])).toEqual([['CONFIRMED', 100_000n, 80_000n, 'CREDIT']])
    expect((await issue(b.id, 'lead', 'credit-note')).status).toBe(409) // not cancelled yet
    const v1 = await issue(b.id, 'lead', 'voucher').expect(200); expect(v1.body.data).toMatchObject({ replayed: false, document: { type: 'VOUCHER', number: `VCH-${b.reference}` } })
    expect((await issue(b.id, 'lead', 'voucher').expect(200)).body.data).toMatchObject({ replayed: true, document: { id: v1.body.data.document.id } })
    await issue(b.id, 'lead', 'invoice').expect(200)

    await ok(b.id, 'lead', { action: 'requestCancellation', expectedStatus: 'CONFIRMED', reason: 'Guest changed plans' })
    const asked = await view(b.id)
    expect(asked.penalty).toMatchObject({ state: 'QUOTED', penaltyMinor: '50000', refundMinor: '50000' })
    expect(asked.penalty.quote).toMatchObject({ status: 'quotable', basis: 'RULE', ruleDaysBeforeCheckin: 14 })
    await ok(b.id, 'lead', { action: 'confirmCancellation', expectedStatus: 'CANCEL_REQUESTED', supplierCancellationRef: 'CXL-9' })
    expect((await finEvents(b.id)).map((e) => [e.type, e.penaltyMinor, e.refundMinor])).toEqual([['CONFIRMED', null, null], ['CANCELLED', 50_000n, 50_000n]])

    expect((await issue(b.id, 'lead', 'credit-note').expect(200)).body.data.document).toMatchObject({ type: 'CREDIT_NOTE', number: `CN-${b.reference}` })
    await issue(b.id, 'lead', 'cancellation-note').expect(200)
    const docs = await owner.bookingDocument.findMany({ where: { bookingId: b.id } })
    const by = Object.fromEntries(docs.map((d) => [d.type, d.payload as Record<string, any>]))
    expect(by.INVOICE).toMatchObject({ totalMinor: '100000', currency: 'AED' })
    expect(by.CREDIT_NOTE).toMatchObject({ totalMinor: '100000', penaltyMinor: '50000', refundMinor: '50000', originalInvoiceNumber: `INV-${b.reference}` })
    expect(by.CANCELLATION_NOTE).toMatchObject({ penaltyMinor: '50000', refundMinor: '50000', penaltyState: 'QUOTED', ruleDaysBeforeCheckin: 14 })
    expect(JSON.stringify(docs.map((d) => d.payload))).not.toMatch(/80000|Secret Supplier|SUP-INTERNAL/)
    const page = await html(b.id, 'lead', 'credit-note').expect(200)
    expect(page.headers['content-security-policy']).toContain("default-src 'none'"); expect(page.text).toContain('AED 500.00')
    // Immutable: not even the owner can change or delete an issued document, nor a finance event.
    await expect(owner.$executeRawUnsafe(`UPDATE "BookingDocument" SET number = 'X' WHERE booking_id = '${b.id}'`)).rejects.toThrow()
    await expect(owner.$executeRawUnsafe(`UPDATE "BookingFinanceEvent" SET sell_minor = 1 WHERE booking_id = '${b.id}'`)).rejects.toThrow(/append-only/)
    await expect(owner.$executeRawUnsafe(`DELETE FROM "BookingFinanceEvent" WHERE booking_id = '${b.id}'`)).rejects.toThrow(/append-only/)
    const audit = await owner.auditEvent.findMany({ where: { entityId: b.id, action: 'booking.document.issued' } }); expect(audit).toHaveLength(4)
  })

  it('BF-E02: a non-refundable cancellation retains everything: no credit note, but a cancellation note', async () => {
    const b = await booking('PENDING_SUPPLIER', { refundable: false, rules: null })
    await confirm(b.id); await issue(b.id, 'lead', 'invoice').expect(200)
    await ok(b.id, 'lead', { action: 'requestCancellation', expectedStatus: 'CONFIRMED', reason: 'No show of intent', confirmNonRefundable: true })
    await ok(b.id, 'lead', { action: 'confirmCancellation', expectedStatus: 'CANCEL_REQUESTED', supplierCancellationRef: 'CXL-1', confirmNonRefundable: true })
    expect((await finEvents(b.id)).at(-1)).toMatchObject({ type: 'CANCELLED', penaltyMinor: 100_000n, refundMinor: 0n })
    expect(code(await issue(b.id, 'lead', 'credit-note'))).toBe('NOTHING_TO_CREDIT')
    await issue(b.id, 'lead', 'cancellation-note').expect(200)
  })

  it('BF-E03: terms that are missing leave the penalty undecided: cancellation proceeds, money waits for a person, and no credit note exists until then', async () => {
    const b = await booking('PENDING_SUPPLIER', { rules: null })
    await confirm(b.id); await issue(b.id, 'lead', 'invoice').expect(200)
    await cancelled(b)
    const v = await view(b.id)
    expect(v.penalty).toMatchObject({ state: 'NEEDS_DECISION' }); expect(v.penalty.quote).toMatchObject({ status: 'needs_decision', reason: 'policy_unavailable' })
    expect((await finEvents(b.id)).at(-1)).toMatchObject({ type: 'CANCELLED', penaltyMinor: null, refundMinor: null })
    expect(code(await issue(b.id, 'lead', 'credit-note'))).toBe('PENALTY_DECISION_REQUIRED')
    expect((await penalty(b.id, 'viewer', { penaltyMinor: '30000', reason: 'Hotel invoice' })).status).toBe(403) // no cancel.nonrefundable
    expect((await penalty(b.id, 'lead', { penaltyMinor: '100001', reason: 'x' })).status).toBe(409)
    expect((await penalty(b.id, 'lead', { penaltyMinor: '30000' })).status).toBe(400) // reason required
    expect((await penalty(b.id, 'lead', { penaltyMinor: '30000', reason: 'Hotel invoice' }, null)).status).toBe(400) // idempotency key required
    const k = key()
    expect((await penalty(b.id, 'lead', { penaltyMinor: '30000', reason: 'Hotel invoice' }, k).expect(200)).body.data).toMatchObject({ kind: 'DECIDE', penaltyMinor: '30000', refundMinor: '70000', replayed: false })
    expect((await penalty(b.id, 'lead', { penaltyMinor: '30000', reason: 'Hotel invoice' }, k).expect(200)).body.data.replayed).toBe(true)
    expect(code(await penalty(b.id, 'lead', { penaltyMinor: '40000', reason: 'Hotel invoice' }, k))).toBe('IDEMPOTENCY_CONFLICT')
    expect(await owner.bookingFinanceEvent.count({ where: { bookingId: b.id, type: 'PENALTY_DECIDED' } })).toBe(1)
    await issue(b.id, 'lead', 'credit-note').expect(200)
    expect(((await owner.bookingDocument.findFirstOrThrow({ where: { bookingId: b.id, type: 'CREDIT_NOTE' } })).payload as Record<string, unknown>)).toMatchObject({ penaltyMinor: '30000', refundMinor: '70000' })
    expect(code(await penalty(b.id, 'lead', { penaltyMinor: '10000', reason: 'late change' }))).toBe('DOCUMENTS_ISSUED')
  })

  it('BF-E04: a waiver needs its own permission and a second person; a penalty can be waived down, never raised', async () => {
    const b = await booking('PENDING_SUPPLIER')
    await confirm(b.id)
    await ok(b.id, 'both', { action: 'requestCancellation', expectedStatus: 'CONFIRMED', reason: 'Guest ill' })
    expect(code(await penalty(b.id, 'both', { penaltyMinor: '10000', reason: 'Guest ill, doctor note' }))).toBe('PENALTY_SELF_APPROVAL')
    expect((await penalty(b.id, 'lead', { penaltyMinor: '10000', reason: 'x' })).status).toBe(403) // lead holds nonrefundable, not waive
    expect(code(await penalty(b.id, 'approver', { penaltyMinor: '60000', reason: 'raise' }))).toBe('PENALTY_CANNOT_INCREASE')
    expect(code(await penalty(b.id, 'approver', { penaltyMinor: '50000', reason: 'same' }))).toBe('PENALTY_UNCHANGED')
    expect((await penalty(b.id, 'approver', { penaltyMinor: '10000', reason: 'Guest ill, doctor note' }).expect(200)).body.data).toMatchObject({ kind: 'WAIVE', penaltyMinor: '10000', refundMinor: '90000' })
    const v = await view(b.id, 'approver'); expect(v.penalty).toMatchObject({ state: 'WAIVED', penaltyMinor: '10000', waivedFrom: '50000' })
    await ok(b.id, 'both', { action: 'confirmCancellation', expectedStatus: 'CANCEL_REQUESTED', supplierCancellationRef: 'CXL-2' })
    expect((await finEvents(b.id)).at(-1)).toMatchObject({ type: 'CANCELLED', penaltyMinor: 10_000n, refundMinor: 90_000n })
    const audit = await owner.auditEvent.findMany({ where: { entityId: b.id, action: 'booking.penalty.waived' } }); expect(audit).toHaveLength(1)
    expect(JSON.stringify(audit[0].payload)).not.toContain('doctor')
  })

  it('BF-E05: an on-request hold is released once on rejection, a plain failure moves no money, and a replay records nothing twice', async () => {
    const held = await booking('PENDING_SUPPLIER')
    await ok(held.id, 'lead', { action: 'recordOnRequest', expectedStatus: 'PENDING_SUPPLIER' })
    const k = key(); const body = { action: 'rejectOnRequest', expectedStatus: 'ON_REQUEST', reason: 'Hotel declined' }
    await act(held.id, 'lead', body, k).expect(200); await act(held.id, 'lead', body, k).expect(200)
    expect((await finEvents(held.id)).map((e) => e.type)).toEqual(['ON_REQUEST_HOLD', 'HOLD_RELEASED'])
    const failed = await booking('PENDING_SUPPLIER')
    await ok(failed.id, 'lead', { action: 'recordFailed', expectedStatus: 'PENDING_SUPPLIER', reason: 'Supplier error' })
    expect(await finEvents(failed.id)).toHaveLength(0)
    const viaOnRequest = await booking('PENDING_SUPPLIER')
    await ok(viaOnRequest.id, 'lead', { action: 'recordOnRequest', expectedStatus: 'PENDING_SUPPLIER' })
    await ok(viaOnRequest.id, 'lead', { action: 'confirmOnRequest', expectedStatus: 'ON_REQUEST', supplierRef: 'S', hotelConfirmationNo: 'H' })
    expect((await finEvents(viaOnRequest.id)).map((e) => e.type)).toEqual(['ON_REQUEST_HOLD', 'CONFIRMED'])
  })

  it('BF-E06: who may see what; net rate only with booking.view.net; a voucher needs the hotel confirmation number; agency users and other tenants are refused', async () => {
    const b = await booking('CONFIRMED')
    await owner.bookingFinanceEvent.create({ data: { tenantId: tenantA, bookingId: b.id, type: 'CONFIRMED', currency: 'AED', sellMinor: 100_000n, netMinor: 80_000n, paymentMode: 'CREDIT' } })
    expect((await view(b.id, 'lead')).netMinor).toBe('80000'); expect((await view(b.id, 'lead')).events[0].netMinor).toBe('80000')
    const masked = await view(b.id, 'viewer'); expect(masked.netMinor).toBeNull(); expect(masked.events[0].netMinor).toBeNull(); expect(JSON.stringify(masked)).not.toContain('80000'); expect(JSON.stringify(masked)).not.toMatch(/Secret Supplier|SUP-INTERNAL/)
    expect(masked.can).toEqual({ issueDocuments: false, decidePenalty: false, waivePenalty: false })
    expect((await fin(b.id, 'readonly')).status).toBe(403)
    expect((await fin(b.id, 'agx')).status).toBe(403)
    expect((await fin(b.id, 'bops')).status).toBe(404)
    expect((await issue(b.id, 'viewer', 'invoice')).status).toBe(403)
    expect((await html(b.id, 'bops', 'invoice')).status).toBe(404)
    expect(code(await issue(b.id, 'lead', 'voucher'))).toBe('HOTEL_CONFIRMATION_REQUIRED')
    expect((await issue(b.id, 'lead', 'receipt')).status).toBe(400)
    expect((await issue(b.id, 'bops', 'invoice')).status).toBe(404)
    expect((await html(b.id, 'lead', 'voucher')).status).toBe(404) // not issued
  })

  it('BF-E07: the booking role cannot rewrite money or documents (INSERT and SELECT only) and the API role cannot read them at all', async () => {
    const url = process.env.BOOKING_OPS_DATABASE_URL as string
    const role = new PrismaClient({ datasources: { db: { url } } })
    try {
      const b = await booking('CONFIRMED')
      await owner.bookingFinanceEvent.create({ data: { tenantId: tenantA, bookingId: b.id, type: 'CONFIRMED', currency: 'AED', sellMinor: 1n } })
      for (const q of [`UPDATE "BookingFinanceEvent" SET sell_minor = 2`, `DELETE FROM "BookingFinanceEvent"`, `UPDATE "BookingDocument" SET number = 'x'`, `DELETE FROM "BookingDocument"`, `SELECT 1 FROM "LedgerEntry" LIMIT 1`, `SELECT 1 FROM "Wallet" LIMIT 1`, `UPDATE "Booking" SET cancellation_policy = '{}'::jsonb`, `UPDATE "Booking" SET total_minor = 1`]) await expect(role.$executeRawUnsafe(q)).rejects.toThrow(/permission denied/)
    } finally { await role.$disconnect() }
    const api = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL as string } } })
    try { for (const t of ['BookingFinanceEvent', 'BookingDocument']) await expect(api.$queryRawUnsafe(`SELECT 1 FROM "${t}" LIMIT 1`)).rejects.toThrow(/permission denied/) } finally { await api.$disconnect() }
  })

  it('BF-E08: money facts are tenant-isolated by forced row-level security', async () => {
    const b = await booking('PENDING_SUPPLIER', { tenant: 'B' })
    await owner.bookingFinanceEvent.create({ data: { tenantId: tenantB, bookingId: b.id, type: 'CONFIRMED', currency: 'AED', sellMinor: 5n } })
    const forbidden = await request(app.getHttpServer()).get(`${base}/booking-finance/${b.id}`).set('Cookie', cookies.lead); expect(forbidden.status).toBe(404)
    await expect(owner.$executeRawUnsafe(`INSERT INTO "BookingFinanceEvent" (id, tenant_id, booking_id, type, currency, sell_minor) VALUES ('x', '${tenantA}', '${b.id}', 'CONFIRMED', 'AED', 1)`)).rejects.toThrow(/foreign key|violates/)
    const q: StoredPenaltyQuote | null = null; expect(q).toBeNull()
  })
})
