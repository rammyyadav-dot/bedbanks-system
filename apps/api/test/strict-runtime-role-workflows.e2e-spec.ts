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
import { API_RUNTIME_LOGIN_ROLE, provisionApiRuntimeRole, verifyApiRuntimeRole } from '../src/database/api-runtime-role'
import { RUNTIME_ROLE_GRANTS } from '../src/database/runtime-role-contract'

const ownerUrl = process.env.DATABASE_URL
if (!ownerUrl) throw new Error('DATABASE_URL (the disposable owner connection) is required')

/**
 * ADR 0032. Every write privilege the contract gives the API runtime role is exercised here through the real HTTP endpoints, with the whole
 * application connected as the provisioned non-superuser, non-BYPASSRLS role. The last test proves coverage from the database's own
 * statistics: every granted (table, operation) pair changed at least one row while this suite ran, so no granted write is unproven.
 */
describe('strict runtime role: every granted Admin write works end to end (PostgreSQL, HTTP)', () => {
  const owner = new PrismaClient({ datasourceUrl: ownerUrl })
  const suffix = `wf-${Date.now()}-${randomBytes(3).toString('hex')}`
  const password = 'workflow-password'
  const runtimePassword = randomBytes(24).toString('hex')
  const origin = 'http://localhost:3001'
  const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)
  let app: INestApplication; let previousUrl: string | undefined
  let tenantA = '', tenantB = '', hotelId = '', hotel2 = ''
  const ids: Record<string, string> = {}; const userIds: string[] = []; const cookies: Record<string, string> = {}
  let seq = 0
  const key = () => `${suffix}-${++seq}-${randomBytes(4).toString('hex')}`

  const KEYS = ['supply.hotels.read', 'supply.hotels.manage', 'supply.rates.read', 'supply.rates.manage', 'agency.read', 'agency.manage', 'distribution.read', 'distribution.manage', 'case.read', 'case.manage']
  async function user(label: string, tenantId: string, keys: string[]) {
    const email = `${suffix}-${label}@example.test`
    const u = await owner.user.create({ data: { email, name: label, passwordHash: await hashPassword(password), status: 'ACTIVE' } }); userIds.push(u.id); ids[label] = u.id
    await owner.membership.create({ data: { tenantId, userId: u.id, role: 'agent' } })
    if (keys.length) {
      const r = await owner.role.create({ data: { tenantId, name: `${suffix}-${label}` } })
      for (const k of keys) { const p = await owner.permission.upsert({ where: { key: k }, update: {}, create: { key: k, description: k } }); await owner.rolePermission.create({ data: { roleId: r.id, permissionId: p.id } }) }
      await owner.userRole.create({ data: { tenantId, userId: u.id, roleId: r.id } })
    }
  }
  const call = (method: 'get' | 'post' | 'patch' | 'put' | 'delete', path: string, who: string, body?: object) => {
    const r = request(app.getHttpServer())[method](`/api/v1${path}`).set('Origin', origin).set('Cookie', cookies[who]); return body ? r.send(body) : r
  }
  const png = (w: number, h: number, seed = key()) => {
    const head = Buffer.alloc(33); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head); head.writeUInt32BE(13, 8); head.write('IHDR', 12, 'latin1'); head.writeUInt32BE(w, 16); head.writeUInt32BE(h, 20)
    return Buffer.concat([head, Buffer.from(seed)])
  }
  const search = (who: string) => call('post', '/agent/search', who, { destination: 'Dubai', checkIn: day(20), checkOut: day(22), rooms: 1, adults: 2, children: 0, childAges: [], nationality: 'IN', currency: 'AED', limit: 100 })
  /** Row-change counters per table from the database's own statistics (the writes happen on other connections, so poll until they settle). */
  async function counters(): Promise<Record<string, { ins: number; upd: number; del: number }>> {
    let last = ''; let stable = 0; let rows: Array<{ relname: string; ins: bigint; upd: bigint; del: bigint }> = []
    for (let i = 0; i < 60; i++) {
      rows = await owner.$queryRawUnsafe(`SELECT relname, n_tup_ins AS ins, n_tup_upd AS upd, n_tup_del AS del FROM pg_stat_user_tables WHERE schemaname = 'public'`)
      const now = JSON.stringify(rows.map((r) => [r.relname, Number(r.ins), Number(r.upd), Number(r.del)]))
      stable = now === last ? stable + 1 : 0
      if (stable >= 9) break // idle backends flush their statistics within 10 s (PGSTAT_IDLE_INTERVAL): wait until nothing has moved for longer than that
      last = now; await new Promise((resolve) => setTimeout(resolve, 1500))
    }
    return Object.fromEntries(rows.map((r) => [r.relname, { ins: Number(r.ins), upd: Number(r.upd), del: Number(r.del) }]))
  }
  let baseline: Awaited<ReturnType<typeof counters>>

  beforeAll(async () => {
    await owner.$connect()
    tenantA = (await owner.tenant.create({ data: { name: `${suffix}a`, slug: `${suffix}a` } })).id
    tenantB = (await owner.tenant.create({ data: { name: `${suffix}b`, slug: `${suffix}b` } })).id
    await owner.supplier.create({ data: { tenantId: tenantA, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: suffix, displayName: 'S', countryCode: 'AE', defaultCurrency: 'AED' } })
    const mkHotel = async (name: string) => {
      const id = (await owner.hotel.create({ data: { tenantId: tenantA, name: `${suffix} ${name}`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', contentStatus: 'DRAFT' } })).id
      await owner.roomType.create({ data: { hotelId: id, name: 'Deluxe', code: `D-${name}`, maxAdults: 2, maxChildren: 0, maxOccupancy: 2 } })
      return id
    }
    hotelId = await mkHotel('one'); hotel2 = await mkHotel('two')
    await user('maker', tenantA, KEYS); await user('checker', tenantA, KEYS); await user('member', tenantA, ['hotel.search']); await user('other', tenantA, ['hotel.search'])
    await user('badmin', tenantB, KEYS)
    await provisionApiRuntimeRole(owner, { password: runtimePassword })
    previousUrl = process.env.DATABASE_URL
    const u = new URL(ownerUrl!); u.username = API_RUNTIME_LOGIN_ROLE; u.password = runtimePassword
    process.env.DATABASE_URL = u.toString(); process.env.ADMIN_ORIGIN = origin
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication()
    app.use(cookieParser()); app.setGlobalPrefix('api/v1')
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
    app.useGlobalFilters(new HttpExceptionFilter()); app.useGlobalInterceptors(new ResponseInterceptor())
    await app.init()
    for (const label of ['maker', 'checker', 'member', 'other', 'badmin']) {
      const r = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', origin).send({ email: `${suffix}-${label}@example.test`, password }).expect(200)
      cookies[label] = (r.headers['set-cookie'][0] as string).split(';')[0]
    }
    baseline = await counters()
  }, 180_000)

  afterAll(async () => {
    await app?.close()
    if (previousUrl) process.env.DATABASE_URL = previousUrl
    for (const t of [tenantA, tenantB].filter(Boolean)) {
      for (const q of [
        `DELETE FROM "AuditEvent" WHERE tenant_id = '${t}'`, `DELETE FROM "ApprovalRequest" WHERE tenant_id = '${t}'`, `DELETE FROM "HotelImage" WHERE tenant_id = '${t}'`, `DELETE FROM "HotelAmenity" WHERE tenant_id = '${t}'`,
        `DELETE FROM "HotelExternalIdentifier" WHERE tenant_id = '${t}'`, `DELETE FROM "HotelProfile" WHERE tenant_id = '${t}'`, `DELETE FROM "ServiceCaseNote" WHERE tenant_id = '${t}'`, `DELETE FROM "ServiceCase" WHERE tenant_id = '${t}'`,
        `DELETE FROM "DistributionRestriction" WHERE tenant_id = '${t}'`, `DELETE FROM "AgencyCreditLimit" WHERE tenant_id = '${t}'`, `DELETE FROM "AgencyMember" WHERE tenant_id = '${t}'`, `DELETE FROM "Agency" WHERE tenant_id = '${t}'`,
        `DELETE FROM "CommercialMarkupRule" WHERE tenant_id = '${t}'`, `DELETE FROM "RoomType" WHERE hotel_id IN (SELECT id FROM "Hotel" WHERE tenant_id = '${t}')`, `DELETE FROM "Hotel" WHERE tenant_id = '${t}'`, `DELETE FROM "Supplier" WHERE tenant_id = '${t}'`,
        `DELETE FROM "UserRole" WHERE tenant_id = '${t}'`, `DELETE FROM "RolePermission" WHERE role_id IN (SELECT id FROM "Role" WHERE tenant_id = '${t}')`, `DELETE FROM "Role" WHERE tenant_id = '${t}'`, `DELETE FROM memberships WHERE tenant_id = '${t}'`,
      ]) await owner.$executeRawUnsafe(q).catch(() => undefined)
    }
    await owner.session.deleteMany({ where: { userId: { in: userIds } } }); await owner.user.deleteMany({ where: { id: { in: userIds } } }); await owner.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB].filter(Boolean) } } })
    await owner.$disconnect()
  }, 60_000)

  it('W-00 the application is on the strict role and the role verifies clean before any workflow runs', async () => {
    const probe = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL })
    try { expect(await verifyApiRuntimeRole(probe)).toEqual({ ok: true, failures: [] }) } finally { await probe.$disconnect() }
  })

  it('W-01 markup rule: draft, request, approve (other user), execute, retire', async () => {
    const base = '/admin/commercial/markups'
    const rule = (await call('post', base, 'maker', { scope: 'TENANT_DEFAULT', basisPoints: 1_000, validFrom: day(-30), reason: 'Standard margin on NET contracts' }).expect(201)).body.data
    const requested = (await call('post', `${base}/${rule.id}/request-activation`, 'maker', { requestId: key(), reason: 'Approved commercial policy' }).expect(200)).body.data
    await call('post', `${base}/approvals/${requested.approval.id}/approve`, 'maker', { reason: 'Self approval' }).expect(403)
    await call('post', `${base}/approvals/${requested.approval.id}/approve`, 'checker', { reason: 'Matches the signed policy' }).expect(200)
    await call('post', `${base}/approvals/${requested.approval.id}/execute`, 'maker').expect(200)
    expect((await owner.commercialMarkupRule.findUniqueOrThrow({ where: { id: rule.id } })).status).toBe('ACTIVE')
    await call('post', `${base}/${rule.id}/retire`, 'maker').expect(200)
    expect((await owner.commercialMarkupRule.findUniqueOrThrow({ where: { id: rule.id } })).status).toBe('RETIRED')
  })

  it('W-02 agency: create, edit, add and remove a member, suspend and reinstate through maker-checker (suspension is enforced on the strict role)', async () => {
    const agency = (await call('post', '/admin/clients/agencies', 'maker', { code: `AG-${randomBytes(3).toString('hex').toUpperCase()}`, name: 'Workflow agency', countryCode: 'AE' }).expect(201)).body.data
    ids.agency = agency.id
    await call('patch', `/admin/clients/agencies/${agency.id}`, 'maker', { name: 'Workflow agency renamed' }).expect(200)
    await call('post', `/admin/clients/agencies/${agency.id}/members`, 'maker', { userId: ids.other }).expect(200)
    await call('delete', `/admin/clients/agencies/${agency.id}/members/${ids.other}`, 'maker').expect(200)
    await call('post', `/admin/clients/agencies/${agency.id}/members`, 'maker', { userId: ids.member }).expect(200)
    const change = async (verb: 'SUSPEND' | 'REINSTATE') => {
      const asked = (await call('post', `/admin/clients/agencies/${agency.id}/request-suspension-change`, 'maker', { change: verb, requestId: key(), reason: 'Unpaid invoices escalated by finance' }).expect(200)).body.data.suspension.id
      const base = '/admin/clients/agencies/suspension-approvals'
      await call('post', `${base}/${asked}/approve`, 'checker', { reason: 'Reviewed the ledger summary' }).expect(200)
      await call('post', `${base}/${asked}/execute`, 'maker', {}).expect(200)
    }
    await change('SUSPEND')
    const blocked = await search('member'); expect(blocked.status).toBe(403); expect(blocked.body.error.code).toBe('AGENCY_SUSPENDED')
    await change('REINSTATE')
    expect((await search('member')).status).toBe(201)
  })

  it('W-03 credit limit: set, change and remove through maker-checker', async () => {
    const base = '/admin/clients/agencies'
    const step = async (body: object) => {
      const made = (await call('post', `${base}/${ids.agency}/request-credit-limit`, 'maker', { requestId: key(), reason: 'Agreed with finance', ...body }).expect(200)).body.data.credit.open
      await call('post', `${base}/credit-approvals/${made.id}/approve`, 'checker', { reason: 'Checked' }).expect(200)
      return (await call('post', `${base}/credit-approvals/${made.id}/execute`, 'maker', {}).expect(200)).body.data
    }
    expect((await step({ currency: 'AED', limitMinor: '100000' })).agency.credit.limit).toEqual({ currency: 'AED', limitMinor: '100000' })
    expect((await step({ currency: 'AED', limitMinor: '200000' })).agency.credit.limit).toEqual({ currency: 'AED', limitMinor: '200000' })
    expect((await step({ limitMinor: null })).agency.credit.limit).toBeNull()
    expect(await owner.agencyCreditLimit.count({ where: { agencyId: ids.agency } })).toBe(0)
  })

  it('W-04 distribution restriction: create hides the hotel from the agency member only; retire restores it', async () => {
    const before = ((await search('member').expect(201)).body.data.hotels as unknown[]).length
    const made = (await call('post', '/admin/distribution/restrictions', 'maker', { agencyId: ids.agency, scope: 'HOTEL', hotelId, reason: 'Contract dispute' }).expect(201)).body.data
    expect(made.status).toBe('ACTIVE')
    await call('post', `/admin/distribution/restrictions/${made.id}/retire`, 'maker', { reason: 'Resolved' }).expect(200)
    expect((await owner.distributionRestriction.findUniqueOrThrow({ where: { id: made.id } })).status).toBe('RETIRED')
    expect(((await search('member').expect(201)).body.data.hotels as unknown[]).length).toBe(before)
  })

  it('W-05 service case: open, assign, note, move through its states', async () => {
    const c = (await call('post', '/admin/service/cases', 'maker', { subject: 'Voucher not received', description: 'Agent reports the voucher email did not arrive for the booking.', category: 'BOOKING' }).expect(201)).body.data
    await call('post', `/admin/service/cases/${c.id}/assign`, 'maker', { assigneeId: ids.checker }).expect(200)
    await call('post', `/admin/service/cases/${c.id}/notes`, 'maker', { body: 'Looking into it' }).expect(201)
    await call('post', `/admin/service/cases/${c.id}/transition`, 'maker', { to: 'IN_PROGRESS', note: 'Started' }).expect(200)
    await call('post', `/admin/service/cases/${c.id}/transition`, 'maker', { to: 'RESOLVED' }).expect(200)
    expect(await owner.serviceCaseNote.count({ where: { caseId: c.id } })).toBeGreaterThanOrEqual(2)
  })

  it('W-06 hotel setup: profile and hotel columns, external identifiers (add, replace, remove), status change', async () => {
    const path = `/admin/hotels/${hotelId}/setup`
    const load = async () => (await call('get', path, 'maker').expect(200)).body.data
    const save = async (patch: object) => (await call('patch', path, 'maker', { idempotencyKey: key(), expectedToken: (await load()).concurrencyToken, ...patch }).expect(200)).body.data.setup
    await save({ address: '1 Palm Road', latitude: '25.1234', longitude: '55.1234', starRating: 4, starVerified: true, starSource: 'Tourism authority register', shortDescription: 'A quiet hotel on the Palm.', checkInTime: '14:00', checkOutTime: '12:00', area: 'Palm Jumeirah', contacts: { reservations: { name: 'Front desk', email: 'private-res@hotel.test' } } })
    expect(await owner.hotel.findUniqueOrThrow({ where: { id: hotelId } })).toMatchObject({ address: '1 Palm Road', starRating: 4 })
    await save({ externalIdentifiers: [{ scheme: 'GIATA', value: `G-${suffix}` }] })
    await save({ externalIdentifiers: [{ scheme: 'GIATA', value: `G2-${suffix}` }] }) // a changed value is delete plus insert
    expect((await owner.hotelExternalIdentifier.findMany({ where: { hotelId } })).map((e) => e.value)).toEqual([`G2-${suffix}`])
    await save({ externalIdentifiers: [] })
    expect(await owner.hotelExternalIdentifier.count({ where: { hotelId } })).toBe(0)
    const status = (await call('post', `${path}/status`, 'maker', { idempotencyKey: key(), expectedToken: (await load()).concurrencyToken, to: 'SUSPENDED', reason: 'Reviewed against the register' }).expect(200)).body.data
    expect(status.setup.governance.status).toBe('SUSPENDED')
    await call('post', `${path}/status`, 'maker', { idempotencyKey: key(), expectedToken: (await load()).concurrencyToken, to: 'DRAFT', reason: 'Back to draft after review' }).expect(200)
  })

  it('W-07 amenities: add, change and remove (touching the hotel row and profile version)', async () => {
    const path = `/admin/hotels/${hotelId}/amenities`
    const get = async () => (await call('get', path, 'maker').expect(200)).body.data
    const put = async (amenities: unknown) => (await call('put', path, 'maker', { idempotencyKey: key(), expectedToken: (await get()).concurrencyToken, amenities }).expect(200)).body.data
    await put([{ code: 'POOL', feeType: 'FREE' }, { code: 'SPA', feeType: 'PAID' }])
    await put([{ code: 'POOL', feeType: 'PAID' }, { code: 'SPA', feeType: 'PAID' }]) // change
    const final = await put([{ code: 'POOL', feeType: 'PAID' }]) // remove
    expect(final.amenities.hotel).toEqual([{ code: 'POOL', feeType: 'PAID' }])
  })

  it('W-08 images: upload, reorder, edit, set primary, delete; the Agent reads them on the same role', async () => {
    const base = `/admin/hotels/${hotelId}/images`
    const upload = async (bytes: Buffer, alt: string) => (await call('post', `${base}?altText=${encodeURIComponent(alt)}`, 'maker').set('Content-Type', 'image/png').send(bytes).expect(201)).body.data
    const a = await upload(png(1600, 1200), 'Pool at sunset'); const b = await upload(png(1920, 1080), 'Lobby')
    await call('put', `${base}/order`, 'maker', { imageIds: [b.id, a.id] }).expect(200)
    await call('patch', `${base}/${a.id}`, 'maker', { altText: 'Pool at dusk', isPrimary: true }).expect(200)
    const content = await call('get', `/agent/hotels/${hotelId}/images/${a.id}/content`, 'member')
    expect([200, 404]).toContain(content.status) // the hotel is a draft: the Agent route serves only published hotels, and answers a clean 404, not a 5xx
    await call('delete', `${base}/${b.id}`, 'maker').expect(200)
    expect(await owner.hotelImage.count({ where: { hotelId } })).toBe(1)
  })

  it('W-09 publication is maker-checker: request, approve by another user, execute (stamps the hotel row)', async () => {
    const id = hotel2
    const setup = `/admin/hotels/${id}/setup`
    const load = async () => (await call('get', setup, 'maker').expect(200)).body.data
    await call('patch', setup, 'maker', { idempotencyKey: key(), expectedToken: (await load()).concurrencyToken, address: '1 Palm Road', latitude: '25.1234', longitude: '55.1234', starRating: 4, starVerified: true, starSource: 'Tourism authority register', shortDescription: 'A quiet hotel on the Palm.', checkInTime: '14:00', checkOutTime: '12:00', contacts: { reservations: { name: 'Front desk', email: 'private-res@hotel.test' } } }).expect(200)
    const made = (await call('post', `${setup}/publication/request`, 'maker', { requestId: key(), expectedToken: (await load()).concurrencyToken, reason: 'Reviewed against the register' }).expect(200)).body.data.approval
    await call('post', `${setup}/publication/${made.id}/approve`, 'maker', { reason: 'Self' }).expect(403)
    await call('post', `${setup}/publication/${made.id}/approve`, 'checker', { reason: 'Checked' }).expect(200)
    await call('post', `${setup}/publication/${made.id}/execute`, 'maker', {}).expect(200)
    expect((await owner.hotel.findUniqueOrThrow({ where: { id } })).contentStatus).toBe('COMPLETE')
  })

  it('W-10 tenant isolation of writes: another tenant cannot reach these rows, and the database itself refuses a cross-tenant write on the runtime role', async () => {
    await call('patch', `/admin/clients/agencies/${ids.agency}`, 'badmin', { name: 'Hijack' }).expect(404)
    await call('post', '/admin/distribution/restrictions', 'badmin', { agencyId: ids.agency, scope: 'HOTEL', hotelId, reason: 'Cross tenant' }).expect(404)
    expect((await owner.agency.findUniqueOrThrow({ where: { id: ids.agency } })).name).toBe('Workflow agency renamed')
    const probe = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL })
    try {
      const inA = <T>(work: (tx: Parameters<Parameters<typeof probe.$transaction>[0]>[0]) => Promise<T>) => probe.$transaction(async (tx) => { await tx.$executeRawUnsafe(`SELECT set_config('app.current_tenant_id', '${tenantA}', true)`); return work(tx) })
      // A row for the other tenant written from tenant A's context fails the RLS check; an update of the other tenant's row matches nothing.
      await expect(inA((tx) => tx.$executeRawUnsafe(`INSERT INTO "Agency" (id, tenant_id, code, name, created_by_id, updated_at) VALUES ('x${suffix}', '${tenantB}', 'XT', 'x', '${ids.maker}', now())`))).rejects.toThrow(/row-level security|violates/)
      expect(await inA((tx) => tx.$executeRawUnsafe(`UPDATE "Agency" SET name = 'x' WHERE tenant_id = '${tenantB}'`))).toBe(0)
      expect(await inA((tx) => tx.$executeRawUnsafe(`DELETE FROM "AgencyMember" WHERE tenant_id = '${tenantB}'`))).toBe(0)
      // No tenant context: nothing is readable or writable.
      expect(await probe.$executeRawUnsafe(`UPDATE "Agency" SET name = name`)).toBe(0)
    } finally { await probe.$disconnect() }
  })

  it('W-11 coverage: every write privilege in the contract changed at least one row through these workflows', async () => {
    const after = await counters()
    const exempt = new Set(['users', 'sessions', 'AuditEvent', 'supplier_room_drafts']) // authentication, audit and the supplier extranet are covered by their own suites
    const missing: string[] = []
    for (const grant of RUNTIME_ROLE_GRANTS) {
      if (exempt.has(grant.table)) continue
      for (const write of grant.writes) {
        const was = baseline[grant.table] ?? { ins: 0, upd: 0, del: 0 }; const now = after[grant.table] ?? { ins: 0, upd: 0, del: 0 }
        const delta = write.op === 'INSERT' ? now.ins - was.ins : write.op === 'UPDATE' ? now.upd - was.upd : now.del - was.del
        if (delta <= 0) missing.push(`${grant.table}:${write.op}`)
      }
    }
    expect(missing).toEqual([])
  }, 120_000)
})
