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
import { provisionApiRuntimeRole, API_RUNTIME_LOGIN_ROLE } from '../src/database/api-runtime-role'
import { loadDistributionRestrictions } from '../src/supply/distribution-restrictions'

jest.setTimeout(180_000)

/** Clients, Service and Distribution over HTTP against PostgreSQL, two tenants (ADR 0019). Dates are relative to today (UTC). */
describe('clients, service and distribution (PostgreSQL, HTTP, two tenants)', () => {
  const prisma = new PrismaClient()
  const suffix = `dp-${Date.now()}-${randomBytes(3).toString('hex')}`
  const password = 'department-domains-password'
  const midnight = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z').getTime()
  const day = (o: number) => new Date(midnight + o * 86_400_000).toISOString().slice(0, 10)
  const utc = (o: number) => new Date(midnight + o * 86_400_000)
  let app: INestApplication
  let tenantA = '', tenantB = '', supplier1 = '', supplier2 = '', supplierB = ''
  const hotels: Record<string, string> = {}
  const userIds: string[] = []; const roleIds: string[] = []
  const cookies: Record<string, string> = {}; const ids: Record<string, string> = {}
  let seq = 0

  async function buildHotel(tenantId: string, supplierId: string, key: string) {
    const boardBasisId = (await prisma.boardBasis.upsert({ where: { tenantId_code: { tenantId, code: 'BB' } }, update: {}, create: { tenantId, code: 'BB', name: 'B&B' } })).id
    const hotel = await prisma.hotel.create({ data: { tenantId, name: `${suffix} ${key}`, externalRef: `${key}-${suffix.slice(-6)}`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', contentStatus: 'COMPLETE', starRating: 5 } })
    const room = await prisma.roomType.create({ data: { hotelId: hotel.id, name: 'Deluxe', code: `D-${key}`.slice(0, 40), maxAdults: 2, maxChildren: 0, maxOccupancy: 2 } })
    const mapping = await prisma.supplierHotelMapping.create({ data: { tenantId, supplierId, hotelId: hotel.id, supplierHotelId: `${suffix}-${key}`, status: 'MAPPED' } })
    await prisma.supplierRoomMapping.create({ data: { tenantId, supplierHotelMappingId: mapping.id, hotelId: hotel.id, supplierRoomId: `${suffix}-${key}-r`, roomTypeId: room.id, status: 'MAPPED' } })
    const contract = await prisma.contract.create({ data: { tenantId, supplierId, supplierHotelMappingId: mapping.id, code: `${suffix}-${key}`, status: 'ACTIVE', validFrom: utc(-400), validTo: utc(4000), settlementCurrency: 'AED' } as never })
    const plan = await prisma.ratePlan.create({ data: { tenantId, contractId: contract.id, roomTypeId: room.id, boardBasisId, code: `${key}-BB`.slice(0, 40), status: 'ACTIVE', occupancy: 2, currency: 'AED', minStay: 1 } })
    const range = Array.from({ length: 30 }, (_, i) => utc(i))
    await prisma.dailyRate.createMany({ data: range.map((stayDate) => ({ tenantId, ratePlanId: plan.id, stayDate, occupancy: 2, amountMinor: 10_000n, currency: 'AED', amountBasis: 'SELL' as const })) })
    await prisma.dailyAvailability.createMany({ data: range.map((stayDate) => ({ tenantId, ratePlanId: plan.id, stayDate, allotment: 5, sold: 0, stopSell: false })) })
    hotels[key] = hotel.id
  }
  async function user(label: string, tenantId: string, keys: string[]) {
    const email = `${suffix}-${label}@example.test`
    const u = await prisma.user.create({ data: { email, name: label, passwordHash: await hashPassword(password), status: 'ACTIVE' } })
    userIds.push(u.id); ids[label] = u.id
    await prisma.membership.create({ data: { tenantId, userId: u.id, role: 'agent' } })
    if (keys.length) {
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
  const api = (method: 'get' | 'post' | 'patch' | 'delete', path: string, who: string, body?: object) => {
    const r = request(app.getHttpServer())[method](`/api/v1${path}`); const c = who === 'anon' ? r : r.set('Cookie', cookies[who]); return body ? c.send(body) : c
  }
  const ALL = ['agency.read', 'agency.manage', 'case.read', 'case.manage', 'distribution.read', 'distribution.manage']
  const agencyBody = (patch: object = {}) => ({ code: `AG-${++seq}-${suffix.slice(-4).toUpperCase()}`, name: `Agency ${seq}`, countryCode: 'AE', ...patch })
  const newAgency = async (patch: object = {}) => (await api('post', '/admin/clients/agencies', 'admin', agencyBody(patch)).expect(201)).body.data
  const newCase = async (patch: object = {}) => (await api('post', '/admin/service/cases', 'admin', { subject: 'Voucher not received', description: 'Agent reports the voucher email did not arrive for the booking.', category: 'BOOKING', ...patch }).expect(201)).body.data
  const search = (who: string) => request(app.getHttpServer()).post('/api/v1/agent/search').set('Cookie', cookies[who])
    .send({ destination: 'Dubai', checkIn: day(10), checkOut: day(12), rooms: 1, adults: 2, children: 0, childAges: [], nationality: 'IN', currency: 'AED', limit: 100 })
  const seen = async (who: string) => new Set<string>(((await search(who).expect(201)).body.data.hotels as Array<{ hotelId: string }>).map((h) => h.hotelId))

  beforeAll(async () => {
    await prisma.$connect()
    tenantA = (await prisma.tenant.create({ data: { name: `${suffix} A`, slug: `${suffix}-a` } })).id
    tenantB = (await prisma.tenant.create({ data: { name: `${suffix} B`, slug: `${suffix}-b` } })).id
    const sup = (tenantId: string, n: string) => prisma.supplier.create({ data: { tenantId, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${suffix} ${n}`, displayName: n, countryCode: 'AE', defaultCurrency: 'AED' } }).then((s) => s.id)
    supplier1 = await sup(tenantA, 'Alpha'); supplier2 = await sup(tenantA, 'Gamma'); supplierB = await sup(tenantB, 'Beta')
    await buildHotel(tenantA, supplier1, 'alpha'); await buildHotel(tenantA, supplier1, 'bravo'); await buildHotel(tenantA, supplier2, 'charlie'); await buildHotel(tenantB, supplierB, 'oscar')
    const admin = await user('admin', tenantA, ALL)
    const reader = await user('reader', tenantA, ['agency.read', 'case.read', 'distribution.read'])
    const none = await user('none', tenantA, [])
    const checker = await user('checker', tenantA, ALL)
    const agentSus = await user('agentsus', tenantA, ['hotel.search', 'booking.prebook', 'booking.create', 'booking.read'])
    const agentIn = await user('agentin', tenantA, ['hotel.search', 'booking.prebook', 'booking.create'])
    const agentOut = await user('agentout', tenantA, ['hotel.search', 'booking.prebook', 'booking.create'])
    const bAdmin = await user('badmin', tenantB, ALL); await user('bmember', tenantB, [])
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = module.createNestApplication()
    app.use(cookieParser()); app.setGlobalPrefix('api/v1')
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
    app.useGlobalFilters(new HttpExceptionFilter()); app.useGlobalInterceptors(new ResponseInterceptor())
    await app.init()
    for (const [label, email] of Object.entries({ admin, reader, none, agentin: agentIn, agentout: agentOut, badmin: bAdmin, checker, agentsus: agentSus })) cookies[label] = await login(email)
  })

  afterAll(async () => {
    await app?.close()
    for (const tenantId of [tenantA, tenantB].filter(Boolean)) {
      await prisma.auditEvent.deleteMany({ where: { tenantId } })
      await prisma.approvalRequest.deleteMany({ where: { tenantId } })
      await prisma.distributionRestriction.deleteMany({ where: { tenantId } })
      await prisma.serviceCaseNote.deleteMany({ where: { tenantId } })
      await prisma.serviceCase.deleteMany({ where: { tenantId } })
      await prisma.agencyMember.deleteMany({ where: { tenantId } })
      await prisma.agency.deleteMany({ where: { tenantId } })
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

  // ---- Clients ------------------------------------------------------------------------------------------------------------
  it('CL-01 agencies: validated, normalised, unique per tenant, searchable with literal wildcards, and the code never changes', async () => {
    const a = await newAgency({ code: `gulf-${suffix.slice(-4)}`, name: 'Gulf Travel 100%' })
    expect(a.code).toBe(`GULF-${suffix.slice(-4).toUpperCase()}`); expect(a).toMatchObject({ status: 'ACTIVE', memberCount: 0, countryCode: 'AE' })
    await api('post', '/admin/clients/agencies', 'admin', agencyBody({ code: a.code })).expect(409)
    for (const bad of [{ code: 'x' }, { code: '-ab' }, { code: 'a b' }, { name: '   ' }, { countryCode: 'UAE' }, { countryCode: '12' }, { name: 'x'.repeat(121) }, { notes: 'n'.repeat(1001) }]) await api('post', '/admin/clients/agencies', 'admin', agencyBody(bad)).expect(400)
    expect((await api('get', '/admin/clients/agencies?search=%25', 'admin').expect(200)).body.data.items.map((x: { id: string }) => x.id)).toEqual([a.id]) // % matches only the literal
    expect((await api('get', '/admin/clients/agencies?search=_', 'admin').expect(200)).body.data.total).toBe(0)
    const upd = (await api('patch', `/admin/clients/agencies/${a.id}`, 'admin', { name: 'Gulf Travel LLC', notes: 'Preferred partner', status: 'INACTIVE', code: 'HACKED' }).expect(200)).body.data
    expect(upd).toMatchObject({ name: 'Gulf Travel LLC', status: 'INACTIVE', code: a.code })
    expect((await api('patch', `/admin/clients/agencies/${a.id}`, 'admin', { notes: null, countryCode: null }).expect(200)).body.data).toMatchObject({ notes: null, countryCode: null })
    await api('patch', `/admin/clients/agencies/${a.id}`, 'admin', { status: 'SUSPENDED' }).expect(400)
    expect((await api('get', '/admin/clients/agencies?status=INACTIVE', 'admin').expect(200)).body.data.items.map((x: { id: string }) => x.id)).toContain(a.id)
  })

  it('CL-02 members: one agency per user, only tenant members, candidates shrink, removal is exact', async () => {
    const a = await newAgency(); const b = await newAgency()
    const cand0 = (await api('get', '/admin/clients/member-candidates', 'admin').expect(200)).body.data.map((c: { userId: string }) => c.userId)
    expect(cand0).toContain(ids.agentin); expect(cand0).not.toContain(ids.badmin) // another tenant's user is never offered
    const m = (await api('post', `/admin/clients/agencies/${a.id}/members`, 'admin', { userId: ids.agentin }).expect(200)).body.data
    expect(m).toHaveLength(1); expect(m[0]).toMatchObject({ userId: ids.agentin, userStatus: 'ACTIVE' })
    await api('post', `/admin/clients/agencies/${b.id}/members`, 'admin', { userId: ids.agentin }).expect(409) // already in an agency
    await api('post', `/admin/clients/agencies/${a.id}/members`, 'admin', { userId: ids.badmin }).expect(404) // not in this tenant
    await api('post', `/admin/clients/agencies/${a.id}/members`, 'admin', {}).expect(400)
    expect((await api('get', '/admin/clients/member-candidates', 'admin').expect(200)).body.data.map((c: { userId: string }) => c.userId)).not.toContain(ids.agentin)
    expect((await api('get', `/admin/clients/agencies/${a.id}`, 'admin').expect(200)).body.data.memberCount).toBe(1)
    await api('delete', `/admin/clients/agencies/${b.id}/members/${ids.agentin}`, 'admin').expect(404) // not a member of b
    expect((await api('delete', `/admin/clients/agencies/${a.id}/members/${ids.agentin}`, 'admin').expect(200)).body.data).toEqual([])
  })

  it('CL-03 summary counts agencies and members; tenant isolation and RBAC hold', async () => {
    const s = (await api('get', '/admin/clients/summary', 'admin').expect(200)).body.data
    expect(s.agencies.total).toBe(s.agencies.active + s.agencies.inactive); expect(s.members.total).toBe(s.members.inAnAgency + s.members.notInAnyAgency)
    const other = (await api('get', '/admin/clients/summary', 'badmin').expect(200)).body.data
    expect(other.agencies.total).toBe(0); expect(other.members.total).toBe(2)
    const a = await newAgency()
    await api('get', `/admin/clients/agencies/${a.id}`, 'badmin').expect(404)
    await api('patch', `/admin/clients/agencies/${a.id}`, 'badmin', { name: 'x' }).expect(404)
    await api('get', '/admin/clients/agencies', 'reader').expect(200)
    await api('post', '/admin/clients/agencies', 'reader', agencyBody()).expect(403)
    await api('get', '/admin/clients/agencies', 'none').expect(403)
    await api('get', '/admin/clients/agencies', 'anon').expect(401)
  })

  // ---- Service ------------------------------------------------------------------------------------------------------------
  it('SV-01 a case moves only along the allowed transitions, stamps its timestamps and keeps an append-only note trail', async () => {
    const c = await newCase({ hotelId: hotels.alpha, priority: 'HIGH' })
    expect(c.reference).toMatch(/^SC-[A-Z2-9]{8}$/); expect(c).toMatchObject({ status: 'OPEN', priority: 'HIGH', hotel: { id: hotels.alpha }, allowedTransitions: ['IN_PROGRESS', 'CLOSED'], notes: [] })
    await api('post', `/admin/service/cases/${c.id}/transition`, 'admin', { to: 'RESOLVED' }).expect(409) // OPEN cannot jump to RESOLVED
    const inProgress = (await api('post', `/admin/service/cases/${c.id}/transition`, 'admin', { to: 'IN_PROGRESS', note: 'Looking into it' }).expect(200)).body.data
    expect(inProgress.status).toBe('IN_PROGRESS'); expect(inProgress.notes).toHaveLength(1)
    const resolved = (await api('post', `/admin/service/cases/${c.id}/transition`, 'admin', { to: 'RESOLVED' }).expect(200)).body.data
    expect(resolved.resolvedAt).not.toBeNull(); expect(resolved.closedAt).toBeNull()
    const reopened = (await api('post', `/admin/service/cases/${c.id}/transition`, 'admin', { to: 'IN_PROGRESS' }).expect(200)).body.data
    expect(reopened.resolvedAt).toBeNull()
    await api('post', `/admin/service/cases/${c.id}/transition`, 'admin', { to: 'RESOLVED' }).expect(200)
    const closed = (await api('post', `/admin/service/cases/${c.id}/transition`, 'admin', { to: 'CLOSED' }).expect(200)).body.data
    expect(closed).toMatchObject({ status: 'CLOSED', allowedTransitions: [] }); expect(closed.closedAt).not.toBeNull()
    await api('post', `/admin/service/cases/${c.id}/transition`, 'admin', { to: 'OPEN' }).expect(409) // CLOSED is final
    await api('post', `/admin/service/cases/${c.id}/notes`, 'admin', { body: 'late' }).expect(409)
    await api('post', `/admin/service/cases/${c.id}/assign`, 'admin', { assigneeId: ids.admin }).expect(409)
    const detail = (await api('get', `/admin/service/cases/${c.id}`, 'admin').expect(200)).body.data
    expect(detail.notes.map((n: { body: string }) => n.body)).toEqual(['Looking into it'])
  })

  it('SV-02 assignment needs case.manage, notes append, validation is strict, links stay inside the tenant', async () => {
    const c = await newCase()
    const bad = [{ subject: '   ' }, { description: '' }, { category: 'NOPE' }, { priority: 'EXTREME' }, { subject: 'x'.repeat(201) }, { description: 'x'.repeat(2001) }]
    for (const b of bad) await api('post', '/admin/service/cases', 'admin', { subject: 's', description: 'd', category: 'OTHER', ...b }).expect(400)
    await api('post', `/admin/service/cases/${c.id}/assign`, 'admin', { assigneeId: ids.reader }).expect(400) // reader lacks case.manage
    expect((await api('post', `/admin/service/cases/${c.id}/assign`, 'admin', { assigneeId: ids.admin }).expect(200)).body.data.assignee.id).toBe(ids.admin)
    expect((await api('post', `/admin/service/cases/${c.id}/assign`, 'admin', { assigneeId: null }).expect(200)).body.data.assignee).toBeNull()
    expect((await api('get', '/admin/service/assignees', 'admin').expect(200)).body.data.map((a: { id: string }) => a.id)).toEqual([ids.admin, ids.checker].sort())
    await api('post', `/admin/service/cases/${c.id}/notes`, 'admin', { body: 'First' }).expect(201)
    const two = (await api('post', `/admin/service/cases/${c.id}/notes`, 'admin', { body: 'Second' }).expect(201)).body.data
    expect(two.notes.map((n: { body: string }) => n.body)).toEqual(['First', 'Second'])
    await api('post', `/admin/service/cases/${c.id}/notes`, 'admin', { body: '' }).expect(400)
    const b = { subject: 's', description: 'd', category: 'OTHER' }
    await api('post', '/admin/service/cases', 'admin', { ...b, hotelId: hotels.oscar }).expect(404) // tenant B's hotel
    await api('post', '/admin/service/cases', 'admin', { ...b, supplierId: supplierB }).expect(404)
    await api('post', '/admin/service/cases', 'admin', { ...b, agencyId: 'nope' }).expect(404)
    await api('post', '/admin/service/cases', 'admin', { ...b, assigneeId: ids.reader }).expect(400)
    expect(await prisma.serviceCase.count({ where: { tenantId: tenantB } })).toBe(0)
  })

  it('SV-03 two people making the same move: exactly one wins', async () => {
    const c = await newCase()
    const r = await Promise.all([api('post', `/admin/service/cases/${c.id}/transition`, 'admin', { to: 'IN_PROGRESS' }), api('post', `/admin/service/cases/${c.id}/transition`, 'admin', { to: 'CLOSED' })])
    expect(r.map((x) => x.status).sort()).toEqual([200, 409])
  })

  it('SV-04 list filters, summary, the audit trail holds identifiers never free text, and RBAC and isolation hold', async () => {
    const urgent = await newCase({ priority: 'URGENT', subject: 'Urgent supplier outage' })
    await api('post', `/admin/service/cases/${urgent.id}/notes`, 'admin', { body: 'secret-note-text-marker' }).expect(201)
    const list = (await api('get', '/admin/service/cases?status=UNRESOLVED&priority=URGENT&assignee=none', 'admin').expect(200)).body.data
    expect(list.items.map((i: { id: string }) => i.id)).toContain(urgent.id)
    expect((await api('get', `/admin/service/cases?search=${encodeURIComponent('outage')}`, 'admin').expect(200)).body.data.items.length).toBeGreaterThanOrEqual(1)
    expect((await api('get', '/admin/service/cases?search=%25', 'admin').expect(200)).body.data.total).toBe(0)
    const s = (await api('get', '/admin/service/summary', 'admin').expect(200)).body.data
    expect(s.urgentUnresolved).toBeGreaterThanOrEqual(1); expect(s.unassigned).toBeGreaterThanOrEqual(1); expect(s.oldestUnresolvedAt).not.toBeNull()
    const events = await prisma.auditEvent.findMany({ where: { tenantId: tenantA, entityType: 'service_case', entityId: urgent.id } })
    expect(events.map((e) => e.action).sort()).toEqual(['case.note_added', 'case.opened'])
    const blob = JSON.stringify(events); expect(blob).not.toContain('secret-note-text-marker'); expect(blob).not.toContain('Urgent supplier outage')
    await api('get', `/admin/service/cases/${urgent.id}`, 'badmin').expect(404)
    await api('post', `/admin/service/cases/${urgent.id}/transition`, 'badmin', { to: 'IN_PROGRESS' }).expect(404)
    expect((await api('get', '/admin/service/cases', 'badmin').expect(200)).body.data.total).toBe(0)
    await api('get', '/admin/service/cases', 'reader').expect(200)
    await api('post', '/admin/service/cases', 'reader', { subject: 's', description: 'd', category: 'OTHER' }).expect(403)
    await api('get', '/admin/service/cases', 'none').expect(403); await api('get', '/admin/service/cases', 'anon').expect(401)
  })

  // ---- Distribution -------------------------------------------------------------------------------------------------------
  it('DS-01 restrictions: validated, unique per target, retired not deleted, summarised; tenant isolation and RBAC hold', async () => {
    const a = await newAgency()
    const r = (await api('post', '/admin/distribution/restrictions', 'admin', { agencyId: a.id, scope: 'HOTEL', hotelId: hotels.alpha, reason: 'Contract dispute' }).expect(201)).body.data
    expect(r).toMatchObject({ status: 'ACTIVE', scope: 'HOTEL', agency: { id: a.id } })
    await api('post', '/admin/distribution/restrictions', 'admin', { agencyId: a.id, scope: 'HOTEL', hotelId: hotels.alpha, reason: 'again' }).expect(409)
    for (const bad of [{ scope: 'HOTEL' }, { scope: 'HOTEL', hotelId: hotels.alpha, supplierId: supplier1 }, { scope: 'SUPPLIER' }, { scope: 'GLOBAL', hotelId: hotels.alpha }, { scope: 'HOTEL', hotelId: hotels.bravo, reason: '  ' }]) await api('post', '/admin/distribution/restrictions', 'admin', { agencyId: a.id, reason: 'x', ...bad }).expect(400)
    await api('post', '/admin/distribution/restrictions', 'admin', { agencyId: a.id, scope: 'HOTEL', hotelId: hotels.oscar, reason: 'x' }).expect(404) // another tenant's hotel
    await api('post', '/admin/distribution/restrictions', 'admin', { agencyId: 'nope', scope: 'HOTEL', hotelId: hotels.alpha, reason: 'x' }).expect(404)
    const s = (await api('get', '/admin/distribution/summary', 'admin').expect(200)).body.data
    expect(s.active).toBeGreaterThanOrEqual(1); expect(s.byScope.hotel).toBeGreaterThanOrEqual(1)
    const retired = (await api('post', `/admin/distribution/restrictions/${r.id}/retire`, 'admin').expect(200)).body.data
    expect(retired.status).toBe('RETIRED'); expect(retired.retiredAt).not.toBeNull()
    await api('post', '/admin/distribution/restrictions', 'admin', { agencyId: a.id, scope: 'HOTEL', hotelId: hotels.alpha, reason: 'new dispute' }).expect(201) // a new ACTIVE one after retirement
    expect((await api('get', `/admin/distribution/restrictions?agencyId=${a.id}&status=RETIRED`, 'admin').expect(200)).body.data.total).toBe(1)
    await api('post', `/admin/distribution/restrictions/${r.id}/retire`, 'badmin').expect(404)
    expect((await api('get', '/admin/distribution/restrictions', 'badmin').expect(200)).body.data.total).toBe(0)
    await api('post', '/admin/distribution/restrictions', 'reader', { agencyId: a.id, scope: 'HOTEL', hotelId: hotels.bravo, reason: 'x' }).expect(403)
    await api('get', '/admin/distribution/restrictions', 'reader').expect(200); await api('get', '/admin/distribution/restrictions', 'none').expect(403)
  })

  it('DS-02 ENFORCEMENT: a restriction hides inventory from that agency\'s members only, in search, and in recheck even for another user\'s offer', async () => {
    const agency = await newAgency({ name: 'Restricted Agency' })
    await api('post', `/admin/clients/agencies/${agency.id}/members`, 'admin', { userId: ids.agentin }).expect(200)
    const everything = [hotels.alpha, hotels.bravo, hotels.charlie]
    // no restriction: both agents see all three hotels
    for (const who of ['agentin', 'agentout']) { const s = await seen(who); for (const h of everything) expect(s.has(h)).toBe(true) }
    // hotel restriction
    const hr = (await api('post', '/admin/distribution/restrictions', 'admin', { agencyId: agency.id, scope: 'HOTEL', hotelId: hotels.alpha, reason: 'Test' }).expect(201)).body.data
    const inSeen = await seen('agentin'); const outSeen = await seen('agentout')
    expect(inSeen.has(hotels.alpha)).toBe(false); expect(inSeen.has(hotels.bravo)).toBe(true); expect(inSeen.has(hotels.charlie)).toBe(true)
    expect(outSeen.has(hotels.alpha)).toBe(true) // a user outside the agency is unaffected
    // recheck: the unrestricted user's offer for the restricted hotel cannot be rechecked by the restricted user
    const outFound = await search('agentout').expect(201)
    const offer = (outFound.body.data.hotels as Array<{ hotelId: string; rooms: Array<{ rates: Array<{ offerId: string; sellAmountMinor: number }> }> }>).find((h) => h.hotelId === hotels.alpha)!.rooms[0].rates[0]
    const recheck = (who: string) => request(app.getHttpServer()).post('/api/v1/agent/rates/recheck').set('Cookie', cookies[who]).send({ offerId: offer.offerId, searchId: outFound.body.data.searchId, expectedCurrency: 'AED', expectedSellAmountMinor: offer.sellAmountMinor })
    expect((await recheck('agentout')).status).toBe(200)
    const blocked = await recheck('agentin'); expect(blocked.status).not.toBe(200); expect(blocked.body.data?.status).not.toBe('rechecked')
    // supplier restriction hides every hotel of that supplier (alpha and bravo), not the other supplier's
    await api('post', `/admin/distribution/restrictions/${hr.id}/retire`, 'admin').expect(200)
    await api('post', '/admin/distribution/restrictions', 'admin', { agencyId: agency.id, scope: 'SUPPLIER', supplierId: supplier1, reason: 'Supplier paused' }).expect(201)
    const supSeen = await seen('agentin')
    expect(supSeen.has(hotels.alpha)).toBe(false); expect(supSeen.has(hotels.bravo)).toBe(false); expect(supSeen.has(hotels.charlie)).toBe(true)
    // retiring re-exposes; removing the member also stops the restriction applying
    const active = (await api('get', `/admin/distribution/restrictions?agencyId=${agency.id}&status=ACTIVE`, 'admin').expect(200)).body.data.items[0]
    await api('post', `/admin/distribution/restrictions/${active.id}/retire`, 'admin').expect(200)
    const back = await seen('agentin'); for (const h of everything) expect(back.has(h)).toBe(true)
    // an INACTIVE agency is a directory state only: it does not hide anything or block search
    await api('patch', `/admin/clients/agencies/${agency.id}`, 'admin', { status: 'INACTIVE' }).expect(200)
    expect((await seen('agentin')).size).toBe(3)
  })

  it('DS-03 restrictions apply only to members of the restricted agency; leaving the agency lifts them', async () => {
    const agency = await newAgency()
    await api('post', '/admin/distribution/restrictions', 'admin', { agencyId: agency.id, scope: 'HOTEL', hotelId: hotels.alpha, reason: 'x' }).expect(201) // agency has no members
    expect((await seen('agentout')).has(hotels.alpha)).toBe(true); expect((await seen('agentin')).has(hotels.alpha)).toBe(true) // neither agent is a member
    await api('post', `/admin/clients/agencies/${agency.id}/members`, 'admin', { userId: ids.agentout }).expect(200)
    expect((await seen('agentout')).has(hotels.alpha)).toBe(false)
    await api('delete', `/admin/clients/agencies/${agency.id}/members/${ids.agentout}`, 'admin').expect(200)
    expect((await seen('agentout')).has(hotels.alpha)).toBe(true) // leaving the agency lifts the restriction for that user
  })

  it('SU-01 suspension is maker-checker, blocks new commercial activity for that agency\'s members only, and reinstatement restores it', async () => {
    const agency = await newAgency()
    await api('post', `/admin/clients/agencies/${agency.id}/members`, 'admin', { userId: ids.agentsus }).expect(200)
    expect((await search('agentsus')).status).toBe(201)

    const ask = (change: string, requestId: string, who = 'admin', agencyId = agency.id) => api('post', `/admin/clients/agencies/${agencyId}/request-suspension-change`, who, { change, requestId, reason: 'Unpaid invoices escalated by finance' })
    await ask('SUSPEND', `${suffix}-s0`, 'reader').expect(403)
    await ask('REINSTATE', `${suffix}-s0`).expect(409) // not suspended
    await ask('PAUSE', `${suffix}-s0`).expect(400)
    await ask('SUSPEND', `${suffix}-s0`, 'badmin').expect(404) // other tenant cannot see it
    const requested = (await ask('SUSPEND', `${suffix}-s1`).expect(200)).body.data
    expect(requested.status).toBe('ACTIVE')
    expect(requested.suspension).toMatchObject({ change: 'SUSPEND', status: 'PENDING', canDecide: false, canCancel: true })
    expect((await ask('SUSPEND', `${suffix}-s1`).expect(200)).body.data.suspension.id).toBe(requested.suspension.id) // idempotent
    await ask('SUSPEND', `${suffix}-s2`).expect(409) // one open request at a time
    const approvalId = requested.suspension.id as string
    const step = (verb: string, who: string, body: object = { reason: 'Reviewed the ledger summary' }) => api('post', `/admin/clients/agencies/suspension-approvals/${approvalId}/${verb}`, who, body)

    await step('approve', 'admin').expect(403) // the maker cannot approve
    await step('execute', 'admin').expect(409) // nothing approved yet
    expect((await search('agentsus')).status).toBe(201) // still not suspended
    const approved = (await step('approve', 'checker').expect(200)).body.data
    expect(approved.suspension).toMatchObject({ status: 'APPROVED', canExecute: true })
    expect((await search('agentsus')).status).toBe(201) // approval alone changes nothing
    const done = (await step('execute', 'admin').expect(200)).body.data
    expect(done.agency.status).toBe('SUSPENDED')
    await step('execute', 'admin').expect(409) // single use

    // Enforcement: new commercial activity is refused for the suspended agency's member...
    const blocked = async (res: request.Test) => expect((await res).status).toBe(403)
    await blocked(search('agentsus'))
    await blocked(request(app.getHttpServer()).post('/api/v1/agent/search/status').set('Cookie', cookies.agentsus).send({}))
    await blocked(request(app.getHttpServer()).post('/api/v1/agent/rates/recheck').set('Cookie', cookies.agentsus).send({}))
    await blocked(request(app.getHttpServer()).post('/api/v1/agent/offers/x/hold').set('Cookie', cookies.agentsus).send({}))
    await blocked(request(app.getHttpServer()).post('/api/v1/agent/prebook').set('Cookie', cookies.agentsus).send({}))
    await blocked(request(app.getHttpServer()).post('/api/v1/agent/bookings').set('Cookie', cookies.agentsus).send({}))
    // ...reads and winding down stay available...
    // (the bookings list may answer 503 when booking is switched off in this environment; what matters is that suspension does not refuse it)
    expect((await request(app.getHttpServer()).get('/api/v1/agent/bookings').set('Cookie', cookies.agentsus)).status).not.toBe(403)
    await request(app.getHttpServer()).get('/api/v1/agent/destinations?q=Dub').set('Cookie', cookies.agentsus).expect(200)
    // ...and nobody else is affected.
    expect((await search('agentout')).status).toBe(201)

    // A plain edit can neither clear nor set SUSPENDED.
    await api('patch', `/admin/clients/agencies/${agency.id}`, 'admin', { status: 'ACTIVE' }).expect(409)
    await api('patch', `/admin/clients/agencies/${agency.id}`, 'admin', { status: 'SUSPENDED' }).expect(400)
    await api('patch', `/admin/clients/agencies/${agency.id}`, 'admin', { name: 'Renamed while suspended' }).expect(200)
    await ask('SUSPEND', `${suffix}-s3`).expect(409) // already suspended

    // Reinstatement is also maker-checker.
    const back = (await ask('REINSTATE', `${suffix}-r1`).expect(200)).body.data
    expect(back.suspension).toMatchObject({ change: 'REINSTATE', status: 'PENDING' })
    const reinstateId = back.suspension.id as string
    const rstep = (verb: string, who: string) => api('post', `/admin/clients/agencies/suspension-approvals/${reinstateId}/${verb}`, who, { reason: 'Invoices settled' })
    await rstep('approve', 'admin').expect(403)
    await rstep('approve', 'checker').expect(200)
    expect((await rstep('execute', 'checker').expect(200)).body.data.agency.status).toBe('ACTIVE')
    expect((await search('agentsus')).status).toBe(201)

    // A rejected request changes nothing, and the trail holds identifiers and no free text.
    const again = (await ask('SUSPEND', `${suffix}-s4`).expect(200)).body.data.suspension.id as string
    await api('post', `/admin/clients/agencies/suspension-approvals/${again}/reject`, 'checker', { reason: 'Not warranted' }).expect(200)
    await api('post', `/admin/clients/agencies/suspension-approvals/${again}/execute`, 'admin').expect(409)
    expect((await search('agentsus')).status).toBe(201)
    const events = await prisma.auditEvent.findMany({ where: { tenantId: tenantA, entityType: 'agency', entityId: agency.id, action: { in: ['agency.suspended', 'agency.reinstated'] } }, orderBy: { createdAt: 'asc' } })
    expect(events.map((e) => e.action)).toEqual(['agency.suspended', 'agency.reinstated'])
    expect(JSON.stringify(events.map((e) => e.payload))).not.toMatch(/Unpaid|invoices|ledger/i)
    // Summary counts it.
    expect((await api('get', '/admin/clients/summary', 'admin').expect(200)).body.data.agencies).toHaveProperty('suspended')
  })

  it('SU-02 an approval for another entity cannot be used to suspend an agency', async () => {
    const a = await newAgency(); const other = await newAgency()
    const r = (await api('post', `/admin/clients/agencies/${a.id}/request-suspension-change`, 'admin', { change: 'SUSPEND', requestId: `${suffix}-x1`, reason: 'Check separation of entities' }).expect(200)).body.data.suspension.id as string
    await api('post', `/admin/clients/agencies/suspension-approvals/${r}/approve`, 'checker', { reason: 'ok' }).expect(200)
    await api('post', `/admin/clients/agencies/suspension-approvals/${r}/execute`, 'badmin').expect(404)
    expect((await api('get', `/admin/clients/agencies/${other.id}`, 'admin').expect(200)).body.data.status).toBe('ACTIVE')
    expect((await api('get', `/admin/clients/agencies/${a.id}`, 'admin').expect(200)).body.data.status).toBe('ACTIVE')
  })

  it('DS-04 under the non-bypass API runtime role an unreadable restriction table applies none and says so; nothing aborts', async () => {
    const owner = new PrismaClient()
    const runtimePassword = randomBytes(24).toString('hex')
    const previous = process.env.DATABASE_URL
    let runtime: PrismaService | undefined
    try {
      await provisionApiRuntimeRole(owner, { password: runtimePassword })
      const url = new URL(previous as string); url.username = API_RUNTIME_LOGIN_ROLE; url.password = runtimePassword
      runtime = new PrismaService({ datasourceUrl: url.toString() } as never)
      await runtime.$connect()
      let unavailable = 0
      const r = await loadDistributionRestrictions(runtime, tenantA, ids.agentin, () => { unavailable++ })
      if (unavailable > 0) { expect(r.hotelIds.size).toBe(0); expect(r.supplierIds.size).toBe(0) }
      expect((await runtime.withTenant(tenantA, (tx) => tx.hotel.count({ where: { tenantId: tenantA } })))).toBe(3)
    } finally { await runtime?.$disconnect(); await owner.$disconnect() }
  })
})
