import { randomBytes } from 'crypto'
import { INestApplication, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { PrismaClient } from '@prisma/client'
import * as cookieParser from 'cookie-parser'
import * as request from 'supertest'
import { BOOKING_EXPORT_MAX_ROWS } from '@bedbanks/contracts'
import { AppModule } from '../src/app.module'
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter'
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor'
import { hashPassword } from '../src/auth/utils/password'
import { provisionApiRuntimeRole, API_RUNTIME_LOGIN_ROLE } from '../src/database/api-runtime-role'
import { enableBookingOps } from './support/booking-ops'

jest.setTimeout(240_000)

/** Booking export over HTTP (ADR 0039, Phase 6D): strict API role + the booking role. Scope, permission, masking, net visibility, the row limit and the audit trail. */
describe('Booking export (PostgreSQL, HTTP, strict roles)', () => {
  const owner = new PrismaClient()
  const suffix = `bx-${Date.now()}-${randomBytes(3).toString('hex')}`
  const password = 'booking-export-certification-password'
  const runtimePassword = `rt-${randomBytes(20).toString('hex')}`
  const origin = 'http://localhost:3001'
  let app: INestApplication; let previousUrl: string | undefined; let restoreOps: () => void = () => undefined
  let tenantA = '', tenantB = '', hotelA = '', hotelB = '', agencyX = '', agencyY = ''
  const cookies: Record<string, string> = {}; const uid: Record<string, string> = {}; const all: string[] = []; let n = 0
  const URL_ = '/api/v1/admin/operations/bookings/export'

  async function user(label: string, tenantId: string, keys: string[], agencyId?: string) {
    const u = await owner.user.create({ data: { email: `${suffix}-${label}@example.test`.toLowerCase(), name: `User ${label}`, passwordHash: await hashPassword(password), status: 'ACTIVE' } }); all.push(u.id); uid[label] = u.id
    await owner.membership.create({ data: { tenantId, userId: u.id, role: 'agent' } })
    if (agencyId) await owner.agencyMember.create({ data: { tenantId, agencyId, userId: u.id } })
    const r = await owner.role.create({ data: { tenantId, name: `${suffix}-${label}` } })
    for (const key of keys) { const p = await owner.permission.upsert({ where: { key }, update: {}, create: { key, description: key } }); await owner.rolePermission.create({ data: { roleId: r.id, permissionId: p.id } }) }
    await owner.userRole.create({ data: { tenantId, userId: u.id, roleId: r.id } })
  }
  async function booking(over: { tenant?: 'A' | 'B'; agencyId?: string; supplier?: string; guest?: [string, string]; supplierRef?: string | null; netMinor?: bigint } = {}) {
    const tenantId = over.tenant === 'B' ? tenantB : tenantA; n += 1
    const b = await owner.booking.create({ data: { tenantId, reference: `FB-${randomBytes(10).toString('hex').toUpperCase()}`, supplier: over.supplier ?? 'Supplier One', hotelId: over.tenant === 'B' ? hotelB : hotelA, agencyId: over.agencyId ?? null,
      status: 'CONFIRMED' as never, currency: 'AED', totalMinor: 73_000n, netMinor: over.netMinor ?? 65_000n, idempotencyKey: `${suffix}-${n}`, searchSnapshot: {}, supplierRef: over.supplierRef === undefined ? `SUP-${n}` : over.supplierRef, hotelConfirmationNo: `HC-${n}` } })
    const [firstName, lastName] = over.guest ?? ['Secret', 'Guest']
    await owner.bookingGuest.create({ data: { tenantId, bookingId: b.id, firstName, lastName, isLead: true } })
    return b
  }
  const get = (who: string, query = '') => request(app.getHttpServer()).get(`${URL_}${query}`).set('Cookie', cookies[who]).set('Origin', origin).buffer(true).parse((res, cb) => { let data = ''; res.setEncoding('utf8'); res.on('data', (c) => { data += c }); res.on('end', () => cb(null, data)) })
  const audits = (tenantId: string, action: string) => owner.auditEvent.findMany({ where: { tenantId, action }, orderBy: { createdAt: 'asc' } })
  const lines = (csv: string) => csv.replace('﻿', '').split('\r\n').filter(Boolean)

  beforeAll(async () => {
    await owner.$connect()
    tenantA = (await owner.tenant.create({ data: { name: suffix, slug: suffix } })).id; tenantB = (await owner.tenant.create({ data: { name: `${suffix}-b`, slug: `${suffix}-b` } })).id
    hotelA = (await owner.hotel.create({ data: { tenantId: tenantA, name: `${suffix} A`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', timeZone: 'Asia/Dubai' } })).id
    hotelB = (await owner.hotel.create({ data: { tenantId: tenantB, name: `${suffix} B`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE' } })).id
    const creator = await owner.user.create({ data: { email: `${suffix}-creator@example.test`, name: 'Creator', passwordHash: await hashPassword(password), status: 'ACTIVE' } }); all.push(creator.id)
    agencyX = (await owner.agency.create({ data: { tenantId: tenantA, code: `X-${suffix.slice(-6)}`.toUpperCase(), name: 'Travel Republic', countryCode: 'GB', createdById: creator.id } })).id
    agencyY = (await owner.agency.create({ data: { tenantId: tenantA, code: `Y-${suffix.slice(-6)}`.toUpperCase(), name: 'Atlas Getaways', countryCode: 'AE', createdById: creator.id } })).id
    await user('full', tenantA, ['booking.read', 'booking.export', 'booking.view.net', 'booking.pii.view'])
    await user('plain', tenantA, ['booking.read', 'booking.export'])
    await user('noExport', tenantA, ['booking.read', 'booking.view.net', 'booking.pii.view'])
    await user('agencyExport', tenantA, ['booking.view.agency', 'booking.export.agency'], agencyX)
    await user('agencyNoExport', tenantA, ['booking.view.agency'], agencyX)
    await user('operatorWithAgencyKey', tenantA, ['booking.read', 'booking.export.agency']) // an operator needs booking.export; the agency key does not stand in for it
    await user('fullB', tenantB, ['booking.read', 'booking.export', 'booking.view.net', 'booking.pii.view'])
    const restoreDb = await enableBookingOps(owner); restoreOps = restoreDb
    await provisionApiRuntimeRole(owner, { password: runtimePassword })
    previousUrl = process.env.DATABASE_URL
    const u = new URL(previousUrl as string); u.username = API_RUNTIME_LOGIN_ROLE; u.password = runtimePassword
    process.env.DATABASE_URL = u.toString(); process.env.ADMIN_ORIGIN = origin
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication(); app.use(cookieParser()); app.setGlobalPrefix('api/v1')
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
    app.useGlobalFilters(new HttpExceptionFilter()); app.useGlobalInterceptors(new ResponseInterceptor())
    await app.init()
    for (const label of ['full', 'plain', 'noExport', 'agencyExport', 'agencyNoExport', 'operatorWithAgencyKey', 'fullB']) {
      const r = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', origin).send({ email: `${suffix}-${label}@example.test`.toLowerCase(), password }); if (r.status !== 200) throw new Error(`login ${label} ${r.status} ${JSON.stringify(r.body)}`)
      cookies[label] = (r.headers['set-cookie'][0] as string).split(';')[0]
    }
  })

  afterAll(async () => {
    await app?.close(); restoreOps()
    if (previousUrl) process.env.DATABASE_URL = previousUrl
    for (const t of [tenantA, tenantB].filter(Boolean)) {
      for (const q of [`DELETE FROM "AuditEvent" WHERE tenant_id = '${t}'`, `DELETE FROM "Booking" WHERE tenant_id = '${t}'`, `DELETE FROM "Hotel" WHERE tenant_id = '${t}'`, `DELETE FROM "AgencyMember" WHERE tenant_id = '${t}'`, `DELETE FROM "Agency" WHERE tenant_id = '${t}'`,
        `DELETE FROM "UserRole" WHERE tenant_id = '${t}'`, `DELETE FROM "RolePermission" WHERE role_id IN (SELECT id FROM "Role" WHERE tenant_id = '${t}')`, `DELETE FROM "Role" WHERE tenant_id = '${t}'`, `DELETE FROM memberships WHERE tenant_id = '${t}'`]) await owner.$executeRawUnsafe(q).catch(() => undefined)
    }
    await owner.session.deleteMany({ where: { userId: { in: all } } }); await owner.user.deleteMany({ where: { id: { in: all } } }); await owner.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB].filter(Boolean) } } })
    await owner.$disconnect()
  })

  it('BX-E01: the file is the filtered list: right headers, only this tenant, net and unmasked guest only with the permissions, and an audit event per export', async () => {
    const mine = await booking({ agencyId: agencyX }); const other = await booking({ tenant: 'B' })
    const res = await get('full', '?supplier=Supplier%20One').expect(200)
    expect(res.headers['content-type']).toContain('text/csv'); expect(res.headers['content-disposition']).toMatch(/^attachment; filename="bookings-\d{4}-\d{2}-\d{2}\.csv"$/); expect(res.headers['cache-control']).toBe('private, no-store'); expect(res.headers['x-content-type-options']).toBe('nosniff')
    const csv = res.body as string
    expect(csv.startsWith('﻿')).toBe(true)
    expect(csv).toContain(mine.reference); expect(csv).not.toContain(other.reference)
    expect(lines(csv)[0]).toContain('Net'); expect(lines(csv)[0]).toContain('Margin')
    expect(csv).toContain('Secret Guest'); expect(csv).toContain('650.00'); expect(csv).toContain('730.00'); expect(csv).toContain('Travel Republic')
    expect(res.headers['x-export-row-count']).toBe(String(lines(csv).length - 1))
    const events = await audits(tenantA, 'booking.exported')
    expect(events.length).toBeGreaterThanOrEqual(1)
    const last = events[events.length - 1]
    expect(last).toMatchObject({ userId: uid.full, entityType: 'booking_export' })
    expect(last.payload).toMatchObject({ rowCount: lines(csv).length - 1, level: 'OPERATOR', includesNet: true, guestNamesUnmasked: true })
    expect(JSON.stringify(last.payload)).not.toContain('Supplier One') // filter VALUES are not stored, only which filters applied
    expect((last.payload as { appliedFilters: string[] }).appliedFilters).toEqual(expect.arrayContaining(['supplier']))
    expect((await audits(tenantA, 'booking.pii.exported')).length).toBeGreaterThanOrEqual(1)
  })

  it('BX-E02: without net or guest permission the file has no net/margin column, the guest is masked, and no PII-export audit is written for it', async () => {
    const b = await booking({ guest: ['Zed', 'Hidden'] })
    const before = (await audits(tenantA, 'booking.pii.exported')).length
    const res = await get('plain', `?reference=${b.reference}`).expect(200)
    const csv = res.body as string
    expect(lines(csv)[0]).not.toContain('Net'); expect(lines(csv)[0]).not.toContain('Margin')
    expect(csv).not.toContain('650.00'); expect(csv).not.toContain('Zed Hidden'); expect(csv).toContain('Z••• H•••')
    expect((await audits(tenantA, 'booking.pii.exported')).length).toBe(before)
    const last = (await audits(tenantA, 'booking.exported')).pop()!
    expect(last.payload).toMatchObject({ includesNet: false, guestNamesUnmasked: false, rowCount: 1 })
  })

  it('BX-E03: no export permission is a 403 and is audited as a denial; the export-agency key does not stand in for the operator key; nothing is returned', async () => {
    const before = (await audits(tenantA, 'booking.exported')).length
    for (const who of ['noExport', 'agencyNoExport', 'operatorWithAgencyKey']) {
      const res = await get(who).expect(403)
      expect(String(res.body)).not.toContain('FB-')
    }
    expect((await audits(tenantA, 'booking.exported')).length).toBe(before)
    expect((await audits(tenantA, 'permission.denied')).length).toBeGreaterThanOrEqual(1)
  })

  it('BX-E04: an agency user exports their own agency only, and may not widen the query with another agency id', async () => {
    const own = await booking({ agencyId: agencyX }); const foreign = await booking({ agencyId: agencyY }); const unassigned = await booking()
    const res = await get('agencyExport').expect(200)
    const csv = res.body as string
    expect(csv).toContain(own.reference); expect(csv).not.toContain(foreign.reference); expect(csv).not.toContain(unassigned.reference)
    // The list refuses another agency's id outright (403) rather than ignoring it; the export inherits that.
    const widened = await get('agencyExport', `?agencyId=${agencyY}`).expect(403)
    expect(String(widened.body)).not.toContain(foreign.reference)
    const last = (await audits(tenantA, 'booking.exported')).pop()!
    expect(last.payload).toMatchObject({ level: 'AGENCY', agencyId: agencyX })
  })

  it('BX-E05: another tenant\'s operator never sees this tenant\'s bookings in a file', async () => {
    const mine = await booking(); const theirs = await booking({ tenant: 'B' })
    const csv = (await get('fullB').expect(200)).body as string
    expect(csv).toContain(theirs.reference); expect(csv).not.toContain(mine.reference)
  })

  it('BX-E06: a hostile guest name and supplier reference are neutralised in the file', async () => {
    const b = await booking({ guest: ['=HYPERLINK("http://evil","x")', 'Smith'], supplierRef: '+cmd' })
    const csv = (await get('full', `?reference=${b.reference}`).expect(200)).body as string
    expect(csv).toContain("'=HYPERLINK"); expect(csv).toContain("'+cmd")
    expect(lines(csv).slice(1).every((l) => !/(^|,)=/.test(l))).toBe(true)
  })

  it('BX-E07: bad queries are rejected like the list rejects them; an unexportable filter is refused with a reason', async () => {
    await get('full', '?tenantId=someone-else').expect(400)
    await get('full', '?status=NOPE').expect(400)
    const res = await get('full', '?attention=true').expect(400)
    expect(String(res.body)).toContain('BOOKING_EXPORT_UNSUPPORTED_FILTER')
  })

  it('BX-E08: more than the limit is refused with 422 and the limit, never truncated; narrowing below the limit works; the refusal writes no export audit', async () => {
    const data = Array.from({ length: BOOKING_EXPORT_MAX_ROWS + 1 }, (_, i) => ({ tenantId: tenantB, reference: `FB-${randomBytes(10).toString('hex').toUpperCase()}`, supplier: 'Bulk Supplier', hotelId: hotelB, status: 'CONFIRMED' as never, currency: 'AED', totalMinor: 10_000n, idempotencyKey: `${suffix}-bulk-${i}`, searchSnapshot: {}, supplierRef: `B-${i}` }))
    await owner.booking.createMany({ data })
    const before = (await audits(tenantB, 'booking.exported')).length
    const refused = await get('fullB', '?supplier=Bulk%20Supplier').expect(422)
    const body = JSON.parse(refused.body as string)
    expect(JSON.stringify(body)).toContain('BOOKING_EXPORT_TOO_LARGE'); expect(JSON.stringify(body)).toContain(String(BOOKING_EXPORT_MAX_ROWS))
    expect((await audits(tenantB, 'booking.exported')).length).toBe(before)
    const exact = await owner.booking.findMany({ where: { tenantId: tenantB, supplier: 'Bulk Supplier' }, select: { id: true }, take: 1 })
    expect(exact.length).toBe(1)
    await owner.booking.deleteMany({ where: { tenantId: tenantB, supplier: 'Bulk Supplier', supplierRef: { not: 'B-0' } } })
    const ok = await get('fullB', '?supplier=Bulk%20Supplier').expect(200)
    expect(lines(ok.body as string).length).toBe(2)
  })
})
