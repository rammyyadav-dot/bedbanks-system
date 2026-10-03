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
import { HotelSetupService } from '../src/hotel-setup/hotel-setup.service'

jest.setTimeout(180_000)

/** Hotel Setup over HTTP against PostgreSQL, two tenants (ADR 0021). */
describe('hotel setup (PostgreSQL, HTTP, two tenants)', () => {
  const prisma = new PrismaClient()
  const suffix = `hs-${Date.now()}-${randomBytes(3).toString('hex')}`
  const password = 'hotel-setup-password'
  const midnight = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z').getTime()
  const day = (o: number) => new Date(midnight + o * 86_400_000).toISOString().slice(0, 10)
  const utc = (o: number) => new Date(midnight + o * 86_400_000)
  let app: INestApplication
  let tenantA = '', tenantB = '', supplier1 = ''
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
  const setupPath = (hotelId: string) => `/admin/hotels/${hotelId}/setup`
  const key = () => `${suffix}-k${++seq}-${randomBytes(2).toString('hex')}`
  const load = async (hotelId: string, who = 'manager') => (await api('get', setupPath(hotelId), who).expect(200)).body.data
  const save = (hotelId: string, token: string, patch: object, who = 'manager', idem = key()) => api('patch', setupPath(hotelId), who, { idempotencyKey: idem, expectedToken: token, ...patch })
  const newDraft = async (label: string, tenantId = tenantA) => (await prisma.hotel.create({ data: { tenantId, name: `${suffix} ${label}`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', contentStatus: 'DRAFT' } })).id
  const FULL = { address: '1 Palm Road', latitude: '25.1234', longitude: '55.1234', starRating: 4, starVerified: true, starSource: 'Tourism authority register', shortDescription: 'A quiet hotel on the Palm.', checkInTime: '14:00', checkOutTime: '12:00', contacts: { reservations: { name: 'Front desk', email: 'private-res@hotel.test' } } }
  const search = (who: string) => request(app.getHttpServer()).post('/api/v1/agent/search').set('Cookie', cookies[who])
    .send({ destination: 'Dubai', checkIn: day(10), checkOut: day(12), rooms: 1, adults: 2, children: 0, childAges: [], nationality: 'IN', currency: 'AED', limit: 100 })

  beforeAll(async () => {
    await prisma.$connect()
    tenantA = (await prisma.tenant.create({ data: { name: `${suffix} A`, slug: `${suffix}-a` } })).id
    tenantB = (await prisma.tenant.create({ data: { name: `${suffix} B`, slug: `${suffix}-b` } })).id
    supplier1 = (await prisma.supplier.create({ data: { tenantId: tenantA, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${suffix} Alpha`, displayName: 'Alpha', countryCode: 'AE', defaultCurrency: 'AED' } as never })).id
    await buildHotel(tenantA, supplier1, 'sold')
    const manager = await user('manager', tenantA, ['supply.hotels.read', 'supply.hotels.manage'])
    const reader = await user('reader', tenantA, ['supply.hotels.read'])
    const none = await user('none', tenantA, [])
    const agent = await user('agent', tenantA, ['hotel.search'])
    const bManager = await user('bmanager', tenantB, ['supply.hotels.read', 'supply.hotels.manage'])
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = module.createNestApplication()
    app.use(cookieParser()); app.setGlobalPrefix('api/v1')
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
    app.useGlobalFilters(new HttpExceptionFilter()); app.useGlobalInterceptors(new ResponseInterceptor())
    await app.init()
    for (const [label, email] of Object.entries({ manager, reader, none, agent, bmanager: bManager })) cookies[label] = await login(email)
  })

  afterAll(async () => {
    await app?.close()
    for (const tenantId of [tenantA, tenantB].filter(Boolean)) {
      await prisma.auditEvent.deleteMany({ where: { tenantId } })
      await prisma.hotelExternalIdentifier.deleteMany({ where: { tenantId } })
      await prisma.hotelProfile.deleteMany({ where: { tenantId } })
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

  it('HS-01 a draft with no profile loads with an explicit completeness, and private contacts only for managers', async () => {
    const id = await newDraft('draft')
    const setup = await load(id)
    expect(setup.profileExists).toBe(false)
    expect(setup.completeness.publishable).toBe(false)
    expect(setup.completeness.requirements.find((r: { key: string }) => r.key === 'ACTIVE_ROOM').met).toBe(false)
    expect(setup.contacts).toEqual({})
    expect((await load(id, 'reader')).contacts).toBeNull()
    await api('get', setupPath(id), 'none').expect(403)
    await api('get', setupPath(id), 'anon').expect(401)
  })

  it('HS-02 a save persists across reloads, bumps the version, and a stale token fails visibly', async () => {
    const id = await newDraft('persist')
    const first = await load(id)
    const saved = (await save(id, first.concurrencyToken, { ...FULL, area: 'Palm Jumeirah', legalName: 'Palm View LLC', languages: ['en', 'ar'], policies: { pets: 'Pets are not allowed.' } }).expect(200)).body.data
    expect(saved.replayed).toBe(false)
    const again = await load(id)
    expect(again).toMatchObject({ profileExists: true, location: { area: 'Palm Jumeirah', address: '1 Palm Road', latitude: '25.1234', longitude: '55.1234' }, content: { languages: ['en', 'ar'] }, operations: { checkInTime: '14:00', checkOutTime: '12:00' }, identity: { legalName: 'Palm View LLC' } })
    expect(again.contacts.reservations.email).toBe('private-res@hotel.test')
    expect(again.classification).toMatchObject({ starRating: 4, verified: true, source: 'Tourism authority register' })
    expect(again.concurrencyToken).not.toBe(first.concurrencyToken)
    expect((await prisma.hotelProfile.findUnique({ where: { hotelId: id } }))!.version).toBe(1)

    const stale = await save(id, first.concurrencyToken, { area: 'Other' }).expect(409)
    expect(stale.body.error.code).toBe('HOTEL_SETUP_STALE')
    expect((await load(id)).location.area).toBe('Palm Jumeirah') // the stale write changed nothing

    // an edit through the legacy hotel endpoint also invalidates an open form
    await api('patch', `/supply/hotels/${id}`, 'manager', { name: `${suffix} renamed` }).expect(200)
    await save(id, again.concurrencyToken, { area: 'Again' }).expect(409)
  })

  it('HS-03 a repeated request does not duplicate its effect or its audit trail', async () => {
    const id = await newDraft('idem')
    const t = (await load(id)).concurrencyToken
    const idem = key()
    await save(id, t, { area: 'Marina' }, 'manager', idem).expect(200)
    const replay = (await save(id, t, { area: 'Marina' }, 'manager', idem).expect(200)).body.data
    expect(replay.replayed).toBe(true)
    expect((await prisma.hotelProfile.findUnique({ where: { hotelId: id } }))!.version).toBe(1)
    expect(await prisma.auditEvent.count({ where: { tenantId: tenantA, entityId: id, action: 'hotel.setup.updated' } })).toBe(1)
  })

  it('HS-04 validation failures name the field, keep the stored data, and never echo values', async () => {
    const id = await newDraft('invalid')
    const t = (await load(id)).concurrencyToken
    const res = await save(id, t, { latitude: '95', checkInTime: '25:61', languages: ['EN'], contacts: { reservations: { email: 'secret-not-an-email' } }, timeZone: 'Mars/Base' }).expect(400)
    expect(res.body.error.details.join(' ')).toMatch(/latitude/); expect(res.body.error.details.join(' ')).toMatch(/timeZone/); expect(res.body.error.details.join(' ')).toMatch(/contacts.reservations.email/)
    expect(JSON.stringify(res.body)).not.toContain('secret-not-an-email')
    expect(await prisma.hotelProfile.findUnique({ where: { hotelId: id } })).toBeNull()
    await save(id, t, { latitude: '25.1' }).expect(400) // coordinates are set together
    await save(id, t, { tenantId: tenantB }).expect(400)
    await api('patch', setupPath(id), 'manager', { expectedToken: t, area: 'x' }).expect(400) // idempotency key required
    await api('patch', setupPath(id), 'manager', { idempotencyKey: key(), expectedToken: t }).expect(400) // nothing to save
  })

  it('HS-05 mutations need supply.hotels.manage; another tenant cannot see or change the hotel', async () => {
    const id = await newDraft('rbac')
    const t = (await load(id)).concurrencyToken
    await save(id, t, { area: 'x' }, 'reader').expect(403)
    await save(id, t, { area: 'x' }, 'none').expect(403)
    await save(id, t, { area: 'x' }, 'anon').expect(401)
    await api('post', `${setupPath(id)}/status`, 'reader', { idempotencyKey: key(), expectedToken: t, to: 'SUSPENDED', reason: 'testing' }).expect(403)
    await api('get', setupPath(id), 'bmanager').expect(404)
    await save(id, t, { area: 'x' }, 'bmanager').expect(404)
    expect(await prisma.hotelProfile.findUnique({ where: { hotelId: id } })).toBeNull()
  })

  it('HS-06 publication is gated on explicit requirements, cannot be lost by an edit, and enables no transaction path', async () => {
    const id = await newDraft('publish')
    const status = (to: string, token: string, reason = 'Reviewed against the register', idem = key()) => api('post', `${setupPath(id)}/status`, 'manager', { idempotencyKey: idem, expectedToken: token, to, reason })
    let setup = await load(id)
    const blocked = await status('COMPLETE', setup.concurrencyToken).expect(422)
    expect(blocked.body.error.code).toBe('HOTEL_PUBLICATION_REQUIREMENTS_UNMET'); expect(blocked.body.error.message).toMatch(/Street address|Verified star category/)
    await status('COMPLETE', setup.concurrencyToken, '').expect(400) // a reason is required
    await save(id, setup.concurrencyToken, FULL).expect(200)
    setup = await load(id)
    expect(setup.completeness.publishable).toBe(false) // still no active room
    await prisma.roomType.create({ data: { hotelId: id, name: 'Deluxe', code: 'D1', maxAdults: 2, maxChildren: 0, maxOccupancy: 2 } })
    setup = await load(id)
    expect(setup.completeness.publishable).toBe(true)
    const published = (await status('COMPLETE', setup.concurrencyToken).expect(200)).body.data.setup
    expect(published.governance).toMatchObject({ status: 'COMPLETE', approvedById: ids.manager })
    expect(published.governance.approvedAt).toBeTruthy()
    await status('COMPLETE', published.concurrencyToken).expect(409) // already complete

    // a published hotel cannot lose a publication requirement through an edit
    const lost = await save(id, published.concurrencyToken, { address: null }).expect(422)
    expect(lost.body.error.code).toBe('HOTEL_PUBLICATION_REQUIREMENT_LOST')
    expect((await load(id)).location.address).toBe('1 Palm Road')

    // publication is catalogue state only: no contract, rates or mapping were created, and the hotel is still not offered to Agents
    expect(await prisma.contract.count({ where: { tenantId: tenantA, ratePlans: { some: { roomType: { hotelId: id } } } } })).toBe(0)
    const offered = new Set<string>(((await search('agent').expect(201)).body.data.hotels as Array<{ hotelId: string }>).map((h) => h.hotelId))
    expect(offered.has(id)).toBe(false); expect(offered.has(hotels.sold)).toBe(true)

    const suspended = (await status('SUSPENDED', (await load(id)).concurrencyToken, 'Withdrawn pending licence check').expect(200)).body.data.setup
    expect(suspended.governance).toMatchObject({ status: 'SUSPENDED', approvedById: null, approvedAt: null })
  })

  it('HS-07 changing the star category clears its verification until it is verified again', async () => {
    const id = await newDraft('stars')
    let s = await load(id)
    await save(id, s.concurrencyToken, { starRating: 3, starVerified: true }).expect(200)
    s = await load(id); expect(s.classification).toMatchObject({ starRating: 3, verified: true })
    await save(id, s.concurrencyToken, { starRating: 5 }).expect(200)
    s = await load(id); expect(s.classification).toMatchObject({ starRating: 5, verified: false, verifiedAt: null })
    await save(id, s.concurrencyToken, { starVerified: true, starRating: null }).expect(400) // cannot verify an absent category
  })

  it('HS-08 external identifiers are separate from the canonical id, unique per tenant and scheme, and isolated between tenants', async () => {
    const a = await newDraft('giata-a'); const b = await newDraft('giata-b'); const other = await newDraft('giata-other', tenantB)
    const ta = (await load(a)).concurrencyToken
    const saved = (await save(a, ta, { externalIdentifiers: [{ scheme: 'giata', value: ' 424242 ' }] }).expect(200)).body.data.setup
    expect(saved.identity.externalIdentifiers).toMatchObject([{ scheme: 'GIATA', value: '424242' }])
    expect(saved.hotelId).toBe(a); expect(saved.identity.code).toBeNull() // the canonical id and the legacy code are untouched
    const conflict = await save(b, (await load(b)).concurrencyToken, { externalIdentifiers: [{ scheme: 'GIATA', value: '424242' }] }).expect(409)
    expect(conflict.body.error.code).toBe('EXTERNAL_IDENTIFIER_CONFLICT')
    expect((await load(b)).identity.externalIdentifiers).toEqual([]) // the failed save changed nothing
    // another tenant may use the same value
    await api('patch', setupPath(other), 'bmanager', { idempotencyKey: key(), expectedToken: (await load(other, 'bmanager')).concurrencyToken, externalIdentifiers: [{ scheme: 'GIATA', value: '424242' }] }).expect(200)
    // replacing and removing
    const next = (await save(a, (await load(a)).concurrencyToken, { externalIdentifiers: [{ scheme: 'GIATA', value: '999' }] }).expect(200)).body.data.setup
    expect(next.identity.externalIdentifiers[0].value).toBe('999')
    expect((await save(a, next.concurrencyToken, { externalIdentifiers: [] }).expect(200)).body.data.setup.identity.externalIdentifiers).toEqual([])
  })

  it('HS-09 audit records actor, server request id and field names, and holds no contact or description text', async () => {
    const id = await newDraft('audit')
    const t = (await load(id)).concurrencyToken
    const res = await save(id, t, { name: `${suffix} audited`, area: 'Downtown', shortDescription: 'Distinctive-description-text', contacts: { reservations: { name: 'Hidden Person', email: 'hidden-person@hotel.test' } }, reason: 'Initial onboarding' }).expect(200)
    const events = await prisma.auditEvent.findMany({ where: { tenantId: tenantA, entityId: id, action: 'hotel.setup.updated' } })
    expect(events).toHaveLength(1)
    expect(events[0].userId).toBe(ids.manager)
    const payload = events[0].payload as { requestId: string; fields: string[]; reason: string; changes: Record<string, { from: unknown; to: unknown }>; fromVersion: number; toVersion: number }
    expect(payload.requestId).toBe(res.headers['x-request-id']); expect(res.body.data.auditRequestId).toBe(res.headers['x-request-id'])
    expect(payload.fields.sort()).toEqual(['area', 'contacts', 'name', 'shortDescription'])
    expect(payload).toMatchObject({ reason: 'Initial onboarding', fromVersion: 0, toVersion: 1 }); expect(payload.changes.name.to).toBe(`${suffix} audited`)
    const text = JSON.stringify(events)
    expect(text).not.toContain('hidden-person@hotel.test'); expect(text).not.toContain('Hidden Person'); expect(text).not.toContain('Distinctive-description-text')
  })

  it('HS-10 private contacts never appear in Agent search, and the setup read reports an unreadable table instead of an empty profile', async () => {
    const t = (await load(hotels.sold)).concurrencyToken
    await save(hotels.sold, t, { contacts: { reservations: { name: 'Hidden Person', email: 'never-for-agents@hotel.test', phone: '+971 4 000 0000' } }, operationalNotes: 'Never-for-agents-note' }).expect(200)
    const body = JSON.stringify((await search('agent').expect(201)).body)
    expect(body).toContain(hotels.sold)
    expect(body).not.toContain('never-for-agents@hotel.test'); expect(body).not.toContain('Hidden Person'); expect(body).not.toContain('Never-for-agents-note')

    const owner = new PrismaClient()
    const runtimePassword = randomBytes(24).toString('hex')
    let runtime: PrismaService | undefined
    try {
      await provisionApiRuntimeRole(owner, { password: runtimePassword })
      const url = new URL(process.env.DATABASE_URL as string); url.username = API_RUNTIME_LOGIN_ROLE; url.password = runtimePassword
      runtime = new PrismaService({ datasourceUrl: url.toString() } as never)
      await runtime.$connect()
      const outcome = await new HotelSetupService(runtime).get(tenantA, hotels.sold, true).then(() => 'readable', (e: { getStatus?: () => number; getResponse?: () => { code?: string } }) => `${e.getStatus?.()}:${e.getResponse?.()?.code}`)
      // Without the reviewed grants the read is refused explicitly; with them it is readable. It is never an empty profile.
      expect(['readable', '503:OPERATIONS_READ_DENIED']).toContain(outcome)
    } finally { await runtime?.$disconnect(); await owner.$disconnect() }
  })
  it('HS-11 the directory finds a hotel by canonical id or external identifier, filters by type and stars, and reports profile completeness', async () => {
    const id = await newDraft('directory')
    await prisma.hotel.update({ where: { id }, data: { propertyType: 'RESORT' } })
    await save(id, (await load(id)).concurrencyToken, { starRating: 5, starVerified: true, area: 'Marina', externalIdentifiers: [{ scheme: 'GIATA', value: 'DIR-77177' }] }).expect(200)
    const list = (query: string) => api('get', `/admin/operations/hotels?${query}`, 'reader').expect(200).then((r) => r.body.data)
    const byGiata = await list('search=DIR-77')
    expect(byGiata.items.map((h: { id: string }) => h.id)).toEqual([id]); expect(byGiata.total).toBe(1)
    expect((await list(`search=${id}`)).items.map((h: { id: string }) => h.id)).toEqual([id]) // canonical id, exact
    expect((await list(`search=${id.slice(0, 8)}`)).total).toBe(0) // a partial canonical id is not a match
    const row = byGiata.items[0]
    expect(row).toMatchObject({ verifiedMappings: 0, profile: { exists: true, starVerified: true, area: 'Marina', publishable: false, externalIdentifiers: [{ scheme: 'GIATA', value: 'DIR-77177' }] } })
    expect(row.profile.updatedBy).toBeTruthy(); expect(row.profile.completenessPercent).toBeGreaterThan(0)
    expect(byGiata.profilesAvailable).toBe(true)
    expect((await list(`propertyType=RESORT&search=${suffix}`)).items.map((h: { id: string }) => h.id)).toEqual([id])
    expect((await list(`stars=5&search=${suffix}`)).items.map((h: { id: string }) => h.id)).toContain(id)
    expect((await list(`stars=UNRATED&search=${suffix}`)).items.map((h: { id: string }) => h.id)).not.toContain(id)
    await api('get', '/admin/operations/hotels?propertyType=resort', 'reader').expect(400)
    await api('get', '/admin/operations/hotels?stars=9', 'reader').expect(400)
    // the hotel that has an approved supplier mapping reports it, and a hotel with none reports zero
    expect((await list(`search=${suffix} sold`)).items[0].verifiedMappings).toBe(1)
  })
})
