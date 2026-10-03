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
import { HotelQuickUpdateService } from '../src/hotel-setup/hotel-quick-update.service'

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
  const api = (method: 'get' | 'post' | 'patch' | 'put' | 'delete', path: string, who: string, body?: object) => {
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
    const manager = await user('manager', tenantA, ['supply.hotels.read', 'supply.hotels.manage', 'supply.rooms.read', 'supply.rooms.manage', 'supply.mappings.read', 'supply.mappings.manage', 'audit.read', 'supply.rates.read', 'supply.rates.manage', 'supply.availability.manage'])
    const ratesOnly = await user('ratesonly', tenantA, ['supply.rates.read', 'supply.rates.manage'])
    const availOnly = await user('availonly', tenantA, ['supply.rates.read', 'supply.availability.manage'])
    const reader = await user('reader', tenantA, ['supply.hotels.read', 'supply.rooms.read', 'supply.mappings.read', 'supply.contracts.read', 'supply.rates.read'])
    const none = await user('none', tenantA, [])
    const agent = await user('agent', tenantA, ['hotel.search'])
    const bManager = await user('bmanager', tenantB, ['supply.hotels.read', 'supply.hotels.manage', 'supply.rooms.read', 'supply.rooms.manage', 'supply.mappings.read', 'supply.mappings.manage', 'supply.rates.read', 'supply.rates.manage', 'supply.availability.manage'])
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = module.createNestApplication()
    app.use(cookieParser()); app.setGlobalPrefix('api/v1')
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
    app.useGlobalFilters(new HttpExceptionFilter()); app.useGlobalInterceptors(new ResponseInterceptor())
    await app.init()
    for (const [label, email] of Object.entries({ manager, reader, none, agent, bmanager: bManager, ratesonly: ratesOnly, availonly: availOnly })) cookies[label] = await login(email)
  })

  afterAll(async () => {
    await app?.close()
    for (const tenantId of [tenantA, tenantB].filter(Boolean)) {
      await prisma.auditEvent.deleteMany({ where: { tenantId } })
      await prisma.roomAmenity.deleteMany({ where: { tenantId } })
      await prisma.hotelAmenity.deleteMany({ where: { tenantId } })
      await prisma.hotelExternalIdentifier.deleteMany({ where: { tenantId } })
      await prisma.hotelProfile.deleteMany({ where: { tenantId } })
      await prisma.childPolicy.deleteMany({ where: { contract: { tenantId } } })
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
  const roomsPath = (hotelId: string, tail = '') => `/admin/hotels/${hotelId}/rooms${tail}`
  const loadRooms = async (hotelId: string, who = 'manager') => (await api('get', roomsPath(hotelId), who).expect(200)).body.data
  const roomBody = (patch: object = {}, idem = key()) => ({ idempotencyKey: idem, name: 'Deluxe King', code: `DK-${++seq}`, maxAdults: 2, maxChildren: 1, maxOccupancy: 3, ...patch })

  it('HR-01 rooms list with usage, parsed bedding, contract child-age rules, and amenities availability', async () => {
    const view = await loadRooms(hotels.sold)
    expect(view.hotelId).toBe(hotels.sold); expect(view.amenitiesAvailable).toBe(true)
    const room = view.rooms[0]
    expect(room.usage).toMatchObject({ ratePlans: 1, activeRatePlans: 1, mappings: { mapped: 1, pending: 0, rejected: 0 } })
    expect(room.bedding).toEqual({ description: null, beds: [], extraBed: 'UNKNOWN' })
    const contract = await prisma.contract.findFirstOrThrow({ where: { tenantId: tenantA, ratePlans: { some: { roomType: { hotelId: hotels.sold } } } } })
    await prisma.childPolicy.create({ data: { contractId: contract.id, minAge: 2, maxAge: 11, extraBedAllowed: true, supplementMinor: 2_500n, currency: 'AED' } })
    const again = await loadRooms(hotels.sold)
    expect(again.childPolicies).toEqual([expect.objectContaining({ minAge: 2, maxAge: 11, extraBedAllowed: true, supplementMinor: '2500', currency: 'AED', contractCode: contract.code })])
    await api('get', roomsPath(hotels.sold), 'none').expect(403)
    await api('get', roomsPath(hotels.sold), 'bmanager').expect(404)
  })

  it('HR-02 a room is created once, validated by the canonical occupancy rule, and unique by code', async () => {
    const id = await newDraft('rooms')
    const body = roomBody({ bedding: { description: 'One king bed', beds: [{ type: 'KING', count: 1 }], extraBed: 'SUPPORTED' }, amenities: [{ code: 'BALCONY', feeType: 'FREE' }, { code: 'WIFI', feeType: 'PAID' }] })
    const created = (await api('post', roomsPath(id), 'manager', body).expect(201)).body.data
    expect(created.replayed).toBe(false)
    expect(created.room).toMatchObject({ name: 'Deluxe King', maxAdults: 2, maxChildren: 1, maxOccupancy: 3, isActive: true, bedding: { description: 'One king bed', beds: [{ type: 'KING', count: 1 }], extraBed: 'SUPPORTED' } })
    expect(created.room.amenities).toEqual([{ code: 'BALCONY', feeType: 'FREE' }, { code: 'WIFI', feeType: 'PAID' }])
    const replay = (await api('post', roomsPath(id), 'manager', body).expect(201)).body.data
    expect(replay.replayed).toBe(true); expect(replay.room.id).toBe(created.room.id)
    expect((await loadRooms(id)).rooms).toHaveLength(1)
    const conflict = await api('post', roomsPath(id), 'manager', roomBody({ code: created.room.code })).expect(409)
    expect(conflict.body.error.code).toBe('ROOM_CODE_CONFLICT')
    const bad = await api('post', roomsPath(id), 'manager', roomBody({ maxAdults: 3, maxChildren: 2, maxOccupancy: 4, code: 'bad code!', bedding: { beds: [{ type: 'WATERBED', count: 1 }], extraBed: 'MAYBE' }, amenities: [{ code: 'POOL', feeType: 'FREE' }, { code: 'NOPE', feeType: 'FREE' }], secret: 1 })).expect(400)
    const details = bad.body.error.details.join(' | ')
    expect(details).toMatch(/maxOccupancy: must be at least/); expect(details).toMatch(/code:/); expect(details).toMatch(/bedding.beds\[0\].type/); expect(details).toMatch(/bedding.extraBed/)
    expect(details).toMatch(/amenities\[0\].code: is not in the room amenity catalogue/); expect(details).toMatch(/amenities\[1\].code/); expect(details).toMatch(/secret: is not a supported field/)
    expect((await loadRooms(id)).rooms).toHaveLength(1) // nothing from the failed request persisted
    await api('post', roomsPath(id), 'reader', roomBody()).expect(403)
    await api('post', roomsPath(id), 'bmanager', roomBody()).expect(404)
    const events = await prisma.auditEvent.findMany({ where: { tenantId: tenantA, entityId: created.room.id, action: 'hotel.room.created' } })
    expect(events).toHaveLength(1); expect(events[0].userId).toBe(ids.manager)
  })

  it('HR-03 an edit changes only what was sent, preserves unknown bedding keys, replaces amenities, and a stale token fails', async () => {
    const id = await newDraft('room-edit')
    const room = await prisma.roomType.create({ data: { hotelId: id, name: 'Twin', code: 'TW1', maxAdults: 2, maxChildren: 0, maxOccupancy: 2, beddingMetadata: { legacyKey: 'keep-me', description: 'Old text' } } })
    let view = (await loadRooms(id)).rooms[0]
    const patch = (token: string, body: object) => api('patch', roomsPath(id, `/${room.id}`), 'manager', { idempotencyKey: key(), expectedToken: token, ...body })
    const saved = (await patch(view.concurrencyToken, { name: 'Twin Superior', bedding: { description: 'Two single beds', beds: [{ type: 'TWIN', count: 1 }] }, amenities: [{ code: 'TV', feeType: 'FREE' }] }).expect(200)).body.data.room
    expect(saved).toMatchObject({ name: 'Twin Superior', code: 'TW1', maxAdults: 2, maxChildren: 0, maxOccupancy: 2, bedding: { description: 'Two single beds', beds: [{ type: 'TWIN', count: 1 }], extraBed: 'UNKNOWN' } })
    expect((await prisma.roomType.findUniqueOrThrow({ where: { id: room.id } })).beddingMetadata).toMatchObject({ legacyKey: 'keep-me', description: 'Two single beds' })
    const stale = await patch(view.concurrencyToken, { name: 'Other' }).expect(409)
    expect(stale.body.error.code).toBe('ROOM_STALE')
    view = (await loadRooms(id)).rooms[0]
    expect(view.name).toBe('Twin Superior')
    const replaced = (await patch(view.concurrencyToken, { amenities: [{ code: 'WIFI', feeType: 'FREE' }, { code: 'SEA_VIEW', feeType: 'UNKNOWN' }] }).expect(200)).body.data.room
    expect(replaced.amenities).toEqual([{ code: 'SEA_VIEW', feeType: 'UNKNOWN' }, { code: 'WIFI', feeType: 'FREE' }]) // TV was removed, unknown stays explicit
    await patch(replaced.concurrencyToken, { maxOccupancy: 1 }).expect(400) // below adults plus children
    await patch(replaced.concurrencyToken, {}).expect(400)
    const audit = (await prisma.auditEvent.findMany({ where: { tenantId: tenantA, entityId: room.id, action: 'hotel.room.updated' }, orderBy: { createdAt: 'asc' } }))[0].payload as { changes: Record<string, { from: unknown; to: unknown }>; fields: string[] }
    expect(audit.changes.name).toEqual({ from: 'Twin', to: 'Twin Superior' }); expect(audit.fields.sort()).toEqual(['amenities', 'bedding', 'name'])
  })

  it('HR-04 archiving never deletes: rate plans and mappings stay, the last room of a published hotel is protected, and restore works', async () => {
    const before = await prisma.ratePlan.count({ where: { tenantId: tenantA, roomType: { hotelId: hotels.sold } } })
    const extra = (await api('post', roomsPath(hotels.sold), 'manager', roomBody()).expect(201)).body.data.room
    const sold = (await loadRooms(hotels.sold)).rooms.find((r: { id: string }) => r.id !== extra.id)
    const archive = (token: string, id: string, reason = 'Closed for renovation') => api('post', roomsPath(hotels.sold, `/${id}/archive`), 'manager', { idempotencyKey: key(), expectedToken: token, reason })
    await api('post', roomsPath(hotels.sold, `/${sold.id}/archive`), 'manager', { idempotencyKey: key(), expectedToken: sold.concurrencyToken, reason: '' }).expect(400)
    const archived = (await archive(sold.concurrencyToken, sold.id).expect(200)).body.data.room
    expect(archived.isActive).toBe(false); expect(archived.usage).toMatchObject({ ratePlans: 1, mappings: { mapped: 1 } })
    expect(await prisma.ratePlan.count({ where: { tenantId: tenantA, roomType: { hotelId: hotels.sold } } })).toBe(before)
    expect(await prisma.supplierRoomMapping.count({ where: { tenantId: tenantA, roomTypeId: sold.id } })).toBe(1)
    const ev = (await prisma.auditEvent.findFirstOrThrow({ where: { tenantId: tenantA, entityId: sold.id, action: 'hotel.room.archived' } })).payload as { activeRatePlans: number; reason: string }
    expect(ev).toMatchObject({ activeRatePlans: 1, reason: 'Closed for renovation' })
    await archive(archived.concurrencyToken, sold.id).expect(409) // already archived
    // the last active room of a published hotel cannot be archived
    const guard = await archive(extra.concurrencyToken, extra.id).expect(422)
    expect(guard.body.error.code).toBe('HOTEL_PUBLICATION_REQUIREMENT_LOST')
    const restored = (await api('post', roomsPath(hotels.sold, `/${sold.id}/restore`), 'manager', { idempotencyKey: key(), expectedToken: archived.concurrencyToken, reason: 'Reopened' }).expect(200)).body.data.room
    expect(restored.isActive).toBe(true)
    await api('delete', roomsPath(hotels.sold, `/${sold.id}`), 'manager').expect(404) // there is no delete
    expect(await prisma.roomType.count({ where: { id: sold.id } })).toBe(1)
  })

  it('HR-05 hotel amenities: controlled catalogue, explicit fee type, shared concurrency with Setup, idempotent, audited without values', async () => {
    const id = await newDraft('amenities')
    const get = async () => (await api('get', `/admin/hotels/${id}/amenities`, 'manager').expect(200)).body.data
    const put = (token: string, amenities: unknown, idem = key(), who = 'manager') => api('put', `/admin/hotels/${id}/amenities`, who, { idempotencyKey: idem, expectedToken: token, amenities })
    let a = await get()
    expect(a.hotel).toEqual([]); expect(a.catalogue.some((c: { code: string }) => c.code === 'POOL')).toBe(true); expect(a.catalogue.some((c: { code: string }) => c.code === 'BALCONY')).toBe(false) // room-only codes are not offered
    const setupBefore = (await load(id)).concurrencyToken
    expect(setupBefore).toBe(a.concurrencyToken)
    const idem = key()
    const saved = (await put(a.concurrencyToken, [{ code: 'POOL', feeType: 'FREE' }, { code: 'SPA', feeType: 'PAID' }, { code: 'GYM', feeType: 'UNKNOWN' }], idem).expect(200)).body.data
    expect(saved.replayed).toBe(false); expect(saved.amenities.hotel).toEqual([{ code: 'GYM', feeType: 'UNKNOWN' }, { code: 'POOL', feeType: 'FREE' }, { code: 'SPA', feeType: 'PAID' }])
    expect((await put(a.concurrencyToken, [{ code: 'POOL', feeType: 'FREE' }], idem).expect(200)).body.data.replayed).toBe(true)
    // a Setup form opened before the amenity save is now stale
    await save(id, setupBefore, { area: 'Stale area' }).expect(409)
    a = await get()
    await put(a.concurrencyToken, [{ code: 'BALCONY', feeType: 'FREE' }]).expect(400)
    await put(a.concurrencyToken, [{ code: 'POOL', feeType: 'FREE' }, { code: 'POOL', feeType: 'PAID' }]).expect(400)
    await put(a.concurrencyToken, [{ code: 'POOL', feeType: 'FREE?' }]).expect(400)
    await put(a.concurrencyToken, [{ code: 'POOL', feeType: 'FREE' }], key(), 'reader').expect(403)
    await api('get', `/admin/hotels/${id}/amenities`, 'bmanager').expect(404)
    const removed = (await put(a.concurrencyToken, [{ code: 'SPA', feeType: 'FREE' }]).expect(200)).body.data.amenities.hotel
    expect(removed).toEqual([{ code: 'SPA', feeType: 'FREE' }])
    const events = await prisma.auditEvent.findMany({ where: { tenantId: tenantA, entityId: id, action: 'hotel.amenities.updated' }, orderBy: { createdAt: 'asc' } })
    expect(events).toHaveLength(2)
    expect(events[1].payload).toMatchObject({ added: [], removed: expect.arrayContaining(['POOL', 'GYM']), feeChanged: ['SPA'] })
  })
  const mapBase = '/supply/mappings/hotels'
  const mapAudit = (hotelId: string, extra = '') => api('get', `/admin/operations/hotels/${hotelId}/audit?${extra}`, 'manager').expect(200).then((r) => r.body.data)

  it('MP-01 a supplier mapping is created as PENDING (never auto-approved) and every conflict is a coded 409 naming what it collides with', async () => {
    const a = await newDraft('map-a'); const b = await newDraft('map-b')
    const created = (await api('post', mapBase, 'manager', { supplierId: supplier1, hotelId: a, supplierHotelId: `${suffix}-SH1`, confidence: 80, sourceMetadata: { source: 'supplier content feed', rawPayload: { secret: 'do-not-show' } } }).expect(201)).body.data
    expect(created.status).toBe('PENDING')
    const view = (await api('get', `/admin/operations/hotels/${a}/mappings`, 'reader').expect(200)).body.data
    expect(view.hotelMappings[0]).toMatchObject({ supplierHotelId: `${suffix}-SH1`, status: 'PENDING', confidence: 80, provenance: 'supplier content feed' })
    expect(JSON.stringify(view)).not.toContain('do-not-show') // raw source metadata is never returned
    const sameHotel = await api('post', mapBase, 'manager', { supplierId: supplier1, hotelId: a, supplierHotelId: `${suffix}-SH2` }).expect(409)
    expect(sameHotel.body.error.code).toBe('SUPPLIER_ALREADY_MAPPED_TO_HOTEL'); expect(sameHotel.body.error.message).toContain(`${suffix}-SH1`)
    const sameId = await api('post', mapBase, 'manager', { supplierId: supplier1, hotelId: b, supplierHotelId: `${suffix}-SH1` }).expect(409)
    expect(sameId.body.error.code).toBe('SUPPLIER_HOTEL_ID_CONFLICT'); expect(sameId.body.error.message).toContain(`${suffix} map-a`); expect(sameId.body.error.message).toContain(a)
    expect(await prisma.supplierHotelMapping.count({ where: { tenantId: tenantA, hotelId: b } })).toBe(0) // the refused request left nothing behind
    // a second supplier may map the same hotel (a hotel is not owned by one supplier)
    const supplier2 = (await prisma.supplier.create({ data: { tenantId: tenantA, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${suffix} Beta`, displayName: 'Beta', countryCode: 'AE', defaultCurrency: 'AED' } as never })).id
    await api('post', mapBase, 'manager', { supplierId: supplier2, hotelId: a, supplierHotelId: `${suffix}-SH1` }).expect(201) // same id, different supplier: a different identifier space
    expect(((await api('get', `/admin/operations/hotels/${a}/mappings`, 'reader').expect(200)).body.data.hotelMappings as unknown[]).length).toBe(2)
    // cross-tenant references are refused
    await api('post', mapBase, 'manager', { supplierId: supplier1, hotelId: await newDraft('other-tenant', tenantB), supplierHotelId: `${suffix}-X` }).expect(400)
    await api('post', mapBase, 'bmanager', { supplierId: supplier1, hotelId: a, supplierHotelId: `${suffix}-Y` }).expect(400)
    await api('post', mapBase, 'reader', { supplierId: supplier1, hotelId: b, supplierHotelId: `${suffix}-Z` }).expect(403)
  })

  it('MP-02 decisions are explicit, carry a reason into the audit, and keep the hotel-before-room order', async () => {
    const id = await newDraft('map-decide')
    const room = await prisma.roomType.create({ data: { hotelId: id, name: 'Deluxe', code: 'DM1', maxAdults: 2, maxChildren: 0, maxOccupancy: 2 } })
    const hm = (await api('post', mapBase, 'manager', { supplierId: supplier1, hotelId: id, supplierHotelId: `${suffix}-D1` }).expect(201)).body.data.id as string
    const rm = (await api('post', `${mapBase}/${hm}/rooms`, 'manager', { supplierRoomId: `${suffix}-R1`, roomTypeId: room.id }).expect(201)).body.data.id as string
    await api('post', `${mapBase}/${hm}/rooms`, 'manager', { supplierRoomId: `${suffix}-R1`, roomTypeId: room.id }).expect(409).then((r) => expect(r.body.error.code).toBe('SUPPLIER_ROOM_ID_CONFLICT'))
    await api('post', `${mapBase}/${hm}/rooms/${rm}/approve`, 'manager', { reason: 'Matches the supplier extranet' }).expect(400) // hotel first
    await api('post', `${mapBase}/${hm}/approve`, 'manager', { reason: 'x' }).expect(400) // reason too short
    expect((await api('post', `${mapBase}/${hm}/approve`, 'manager', { reason: 'Verified against the supplier contract' }).expect(201)).body.data.status).toBe('MAPPED')
    await api('post', `${mapBase}/${hm}/rooms/${rm}/approve`, 'manager', { reason: 'Same bedding and occupancy' }).expect(201)
    await api('post', `${mapBase}/${hm}/reopen`, 'manager', { reason: 'Re-check the property' }).expect(400) // approved rooms must be reopened first
    await api('post', `${mapBase}/${hm}/rooms/${rm}/reopen`, 'manager', { reason: 'Re-check room' }).expect(201)
    await api('post', `${mapBase}/${hm}/reject`, 'manager', { reason: 'Wrong property' }).expect(400) // only a pending mapping can be rejected
    await api('post', `${mapBase}/${hm}/reopen`, 'manager', { reason: 'Re-check the property' }).expect(201)
    await api('post', `${mapBase}/${hm}/reject`, 'manager', { reason: 'Wrong property' }).expect(201)
    await api('post', `${mapBase}/${hm}/approve`, 'reader', { reason: 'Not allowed to decide' }).expect(403)
    const events = await prisma.auditEvent.findMany({ where: { tenantId: tenantA, entityId: hm, action: { startsWith: 'supply.hotel_mapping.' } }, orderBy: { createdAt: 'asc' } })
    expect(events.map((e) => e.action)).toEqual(['supply.hotel_mapping.created', 'supply.hotel_mapping.approved', 'supply.hotel_mapping.reopened', 'supply.hotel_mapping.rejected'])
    expect(events[1].userId).toBe(ids.manager); expect(events[1].payload).toMatchObject({ reason: 'Verified against the supplier contract', previousStatus: 'PENDING', newStatus: 'MAPPED' })
    expect((events[1].payload as { requestId: string | null }).requestId).toBeTruthy()
    // history view: narrowed to mapping entity types, with the reason and status change
    const history = await mapAudit(id, 'entityType=supplier_hotel_mapping&pageSize=50')
    expect(history.items.map((e: { action: string }) => e.action).sort()).toEqual(['supply.hotel_mapping.approved', 'supply.hotel_mapping.created', 'supply.hotel_mapping.rejected', 'supply.hotel_mapping.reopened'])
    const roomHistory = await mapAudit(id, 'entityType=supplier_room_mapping&pageSize=50')
    expect(roomHistory.items.length).toBeGreaterThanOrEqual(3)
    await api('get', `/admin/operations/hotels/${id}/audit?entityType=nonsense`, 'manager').expect(400)
    // a rejected mapping is not verified, so the hotel stays unmapped for sellability
    expect((await api('get', `/admin/operations/hotels/${id}/mappings`, 'reader').expect(200)).body.data.hotelMappings[0].status).toBe('REJECTED')
  })
  it('CM-01 contracts show recorded markets as not applied, and the calendar reports closed-to-departure and source freshness without inventing values', async () => {
    const contract = await prisma.contract.findFirstOrThrow({ where: { tenantId: tenantA, ratePlans: { some: { roomType: { hotelId: hotels.sold } } } }, include: { ratePlans: true } })
    await prisma.contract.update({ where: { id: contract.id }, data: { salesMarkets: ['AE', 'IN'], nationalities: ['IN'] } })
    const planId = contract.ratePlans[0].id
    const stamp = new Date(`${day(10)}T06:00:00.000Z`)
    await prisma.dailyAvailability.update({ where: { ratePlanId_stayDate: { ratePlanId: planId, stayDate: utc(10) } }, data: { closedToDeparture: true, sourceUpdatedAt: stamp } })
    await prisma.dailyRate.update({ where: { ratePlanId_stayDate_occupancy: { ratePlanId: planId, stayDate: utc(10), occupancy: 2 } }, data: { sourceUpdatedAt: stamp } })
    const contracts = (await api('get', `/admin/operations/hotels/${hotels.sold}/contracts`, 'reader').expect(200)).body.data
    expect(contracts.contracts[0]).toMatchObject({ salesMarkets: ['AE', 'IN'], nationalities: ['IN'] })
    const cal = (await api('get', `/admin/operations/hotels/${hotels.sold}/calendar?from=${day(9)}&days=3`, 'reader').expect(200)).body.data
    const cells = cal.rows[0].cells as Array<{ date: string; closedToDeparture: boolean | null; rateSourceUpdatedAt: string | null; availabilitySourceUpdatedAt: string | null; closedToArrival: boolean | null }>
    expect(cells.find((c) => c.date === day(10))).toMatchObject({ closedToDeparture: true, rateSourceUpdatedAt: stamp.toISOString(), availabilitySourceUpdatedAt: stamp.toISOString() })
    expect(cells.find((c) => c.date === day(9))).toMatchObject({ closedToDeparture: false, rateSourceUpdatedAt: null, availabilitySourceUpdatedAt: null }) // no stamp recorded means unknown, never "fresh"
    // closed-to-departure is stored but not applied: the night stays sellable
    expect((cal.rows[0].cells as Array<{ date: string; sellable: boolean }>).find((c) => c.date === day(10))!.sellable).toBe(true)
  })
  const qu = (hotelId: string, verb: 'preview' | 'apply', who: string, body: object) => api('post', `/admin/hotels/${hotelId}/quick-update/${verb}`, who, body)
  const planOf = async (hotelId: string) => (await prisma.ratePlan.findFirstOrThrow({ where: { tenantId: tenantA, roomType: { hotelId } } })).id
  const scope = (planId: string, from: number, to: number, weekdays?: string[]) => ({ ratePlanIds: [planId], ranges: [{ from: day(from), to: day(to) }], ...(weekdays ? { weekdays } : {}) })
  const rateAt = async (planId: string, offset: number) => (await prisma.dailyRate.findUniqueOrThrow({ where: { ratePlanId_stayDate_occupancy: { ratePlanId: planId, stayDate: utc(offset), occupancy: 2 } } }))
  const availAt = async (planId: string, offset: number) => prisma.dailyAvailability.findUnique({ where: { ratePlanId_stayDate: { ratePlanId: planId, stayDate: utc(offset) } } })
  const apply = (hotelId: string, preview: { fingerprint: string }, request: object, who = 'manager', idem = key(), reason = 'Seasonal rate review') => qu(hotelId, 'apply', who, { ...request, idempotencyKey: idem, expectedFingerprint: preview.fingerprint, reason })

  it('QU-01 preview shows exact dates, old and new values and unsupported operations, and writes nothing', async () => {
    const planId = await planOf(hotels.sold)
    const request = { scope: scope(planId, 12, 18), changes: { price: { amount: '450.50', basis: 'SELL' } } }
    const before = await rateAt(planId, 12)
    const preview = (await qu(hotels.sold, 'preview', 'manager', request).expect(200)).body.data
    expect(preview.counts).toEqual({ records: 7, willChange: 7, unchanged: 0, invalid: 0 }); expect(preview.canApply).toBe(true)
    expect(preview.dates).toEqual([12, 13, 14, 15, 16, 17, 18].map(day)); expect(preview.plans[0]).toMatchObject({ id: planId, currency: 'AED', occupancy: 2 })
    expect(preview.rows[0]).toMatchObject({ date: day(12), outcome: 'CHANGE', changes: [{ field: 'price', from: '10000', to: '45050', currency: 'AED' }] })
    expect(preview.unsupported.join(' ')).toMatch(/Lock dates/); expect(preview.unsupported.join(' ')).toMatch(/Allotment pools/); expect(preview.timeZone).toBe('Asia/Dubai')
    expect((await rateAt(planId, 12)).amountMinor).toBe(before.amountMinor) // preview wrote nothing
    expect(await prisma.auditEvent.count({ where: { tenantId: tenantA, entityId: hotels.sold, action: 'hotel.quick_update.applied' } })).toBe(0)
    await qu(hotels.sold, 'preview', 'manager', { scope: scope(planId, 12, 14), changes: {} }).expect(400) // nothing opted in
    await qu(hotels.sold, 'preview', 'manager', { scope: scope(planId, 12, 14), changes: { price: { amount: '', basis: 'SELL' } } }).expect(400) // blank is not zero, it is not a request
  })

  it('QU-02 apply changes only the selected field on the selected dates, is audited with actor and request id, and is idempotent', async () => {
    const planId = await planOf(hotels.sold)
    await prisma.dailyAvailability.update({ where: { ratePlanId_stayDate: { ratePlanId: planId, stayDate: utc(5) } }, data: { stopSell: true, minStay: 3, allotment: 7 } })
    const request = { scope: scope(planId, 4, 8, ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']), changes: { price: { amount: '321.00', basis: 'NET' } } }
    const preview = (await qu(hotels.sold, 'preview', 'manager', request).expect(200)).body.data
    const idem = key()
    const res = await apply(hotels.sold, preview, request, 'manager', idem).expect(200)
    expect(res.body.data).toMatchObject({ replayed: false, records: 5, changed: { rates: 5, availabilityRows: 0 } }); expect(res.body.data.auditRequestId).toBe(res.headers['x-request-id'])
    for (const o of [4, 5, 6, 7, 8]) expect(await rateAt(planId, o)).toMatchObject({ amountMinor: 32_100n, amountBasis: 'NET', currency: 'AED' })
    expect((await rateAt(planId, 9)).amountMinor).toBe(10_000n); expect((await rateAt(planId, 3)).amountMinor).toBe(10_000n) // outside the range
    expect(await availAt(planId, 5)).toMatchObject({ stopSell: true, minStay: 3, allotment: 7 }) // an untouched field stayed exactly as stored
    // a repeated request has no second effect
    const replay = (await apply(hotels.sold, preview, request, 'manager', idem).expect(200)).body.data
    expect(replay).toMatchObject({ replayed: true, records: 5 }); expect(replay.fingerprintAfter).toBe(res.body.data.fingerprintAfter)
    const events = await prisma.auditEvent.findMany({ where: { tenantId: tenantA, entityId: hotels.sold, action: 'hotel.quick_update.applied' } })
    expect(events).toHaveLength(1); expect(events[0].userId).toBe(ids.manager)
    expect(events[0].payload).toMatchObject({ reason: 'Seasonal rate review', fields: ['price'], records: 5, changedRecords: 5, ratePlanIds: [planId], idempotencyKey: idem })
    expect((events[0].payload as { requestId: string }).requestId).toBe(res.headers['x-request-id'])
    // a fresh preview of the same scope now reports nothing to change and the same fingerprint
    const again = (await qu(hotels.sold, 'preview', 'manager', request).expect(200)).body.data
    expect(again.counts).toMatchObject({ willChange: 0, unchanged: 5 }); expect(again.fingerprint).toBe(res.body.data.fingerprintAfter); expect(again.canApply).toBe(false)
    await apply(hotels.sold, again, request).expect(409).then((r) => expect(r.body.error.code).toBe('QUICK_UPDATE_NO_CHANGE'))
  })

  it('QU-03 a stale preview is refused and writes nothing; a fresh preview then applies', async () => {
    const planId = await planOf(hotels.sold)
    const request = { scope: scope(planId, 20, 22), changes: { availability: { allotment: 3 } } }
    const preview = (await qu(hotels.sold, 'preview', 'manager', request).expect(200)).body.data
    await prisma.dailyAvailability.update({ where: { ratePlanId_stayDate: { ratePlanId: planId, stayDate: utc(21) } }, data: { stopSell: true } }) // someone else edits a record in scope
    const stale = await apply(hotels.sold, preview, request).expect(409)
    expect(stale.body.error.code).toBe('QUICK_UPDATE_STALE')
    for (const o of [20, 21, 22]) expect((await availAt(planId, o))!.allotment).toBe(5)
    const fresh = (await qu(hotels.sold, 'preview', 'manager', request).expect(200)).body.data
    expect((await apply(hotels.sold, fresh, request).expect(200)).body.data.changed.availabilityRows).toBe(3)
    for (const o of [20, 21, 22]) expect((await availAt(planId, o))!.allotment).toBe(3)
    expect((await availAt(planId, 21))!.stopSell).toBe(true) // the other person's change survived
  })

  it('QU-04 the batch is atomic: one invalid record means nothing is written', async () => {
    const planId = await planOf(hotels.sold)
    await prisma.dailyAvailability.update({ where: { ratePlanId_stayDate: { ratePlanId: planId, stayDate: utc(25) } }, data: { sold: 3, held: 1 } })
    const request = { scope: scope(planId, 24, 26), changes: { availability: { allotment: 2 }, restrictions: { minStay: 2 } } }
    const preview = (await qu(hotels.sold, 'preview', 'manager', request).expect(200)).body.data
    expect(preview.counts).toMatchObject({ records: 3, invalid: 1, willChange: 2 }); expect(preview.canApply).toBe(false)
    const bad = preview.rows.find((r: { outcome: string }) => r.outcome === 'INVALID')
    expect(bad).toMatchObject({ date: day(25) }); expect(bad.problems.join(' ')).toMatch(/below the 4 already sold or held/)
    const auditsBefore = await prisma.auditEvent.count({ where: { tenantId: tenantA, entityId: hotels.sold, action: 'hotel.quick_update.applied' } })
    const refused = await apply(hotels.sold, preview, request).expect(422)
    expect(refused.body.error.code).toBe('QUICK_UPDATE_INVALID')
    for (const o of [24, 26]) expect(await availAt(planId, o)).toMatchObject({ allotment: 5, minStay: 1 })
    expect(await prisma.auditEvent.count({ where: { tenantId: tenantA, entityId: hotels.sold, action: 'hotel.quick_update.applied' } })).toBe(auditsBefore) // a refused batch is not recorded as applied
  })

  it('QU-05 availability and restrictions: stop-sell, minimum stay and closed-to-arrival leave the other fields alone; missing inventory is not turned into zero', async () => {
    const planId = await planOf(hotels.sold)
    const request = { scope: scope(planId, 26, 28), changes: { availability: { stopSell: 'SET' }, restrictions: { minStay: 2, closedToArrival: 'SET' } } }
    const preview = (await qu(hotels.sold, 'preview', 'manager', request).expect(200)).body.data
    await apply(hotels.sold, preview, request).expect(200)
    for (const o of [26, 27, 28]) expect(await availAt(planId, o)).toMatchObject({ allotment: 5, sold: 0, stopSell: true, minStay: 2, closedToArrival: true })
    // clearing one flag leaves the rest
    const clear = { scope: scope(planId, 27, 27), changes: { availability: { stopSell: 'CLEAR' } } }
    await apply(hotels.sold, (await qu(hotels.sold, 'preview', 'manager', clear).expect(200)).body.data, clear).expect(200)
    expect(await availAt(planId, 27)).toMatchObject({ stopSell: false, minStay: 2, closedToArrival: true, allotment: 5 })
    // a night with no inventory row: a restriction alone is refused, an allotment creates the row
    const noRow = { scope: scope(planId, 40, 41), changes: { availability: { stopSell: 'SET' } } }
    const p1 = (await qu(hotels.sold, 'preview', 'manager', noRow).expect(200)).body.data
    expect(p1.counts.invalid).toBe(2); expect(p1.rows[0].problems.join(' ')).toMatch(/unknown, not zero/); expect(await availAt(planId, 40)).toBeNull()
    const withAllotment = { scope: scope(planId, 40, 41), changes: { availability: { allotment: 2, stopSell: 'SET' } } }
    await apply(hotels.sold, (await qu(hotels.sold, 'preview', 'manager', withAllotment).expect(200)).body.data, withAllotment).expect(200)
    expect(await availAt(planId, 40)).toMatchObject({ allotment: 2, sold: 0, held: 0, stopSell: true })
  })

  it('QU-06 money is validated server-side: zero, over-precise and malformed amounts are invalid and nothing is written', async () => {
    const planId = await planOf(hotels.sold)
    for (const amount of ['0', '10.505', '1e3', '-5', 'ten', '99999999999.99']) {
      const preview = (await qu(hotels.sold, 'preview', 'manager', { scope: scope(planId, 29, 29), changes: { price: { amount, basis: 'SELL' } } }).expect(200)).body.data
      expect(preview.counts.invalid).toBe(1); expect(preview.canApply).toBe(false)
    }
    expect((await rateAt(planId, 29)).amountMinor).toBe(10_000n)
  })

  it("QU-07 the hotel's own calendar day decides what is the past", async () => {
    const planId = await planOf(hotels.sold)
    const svc = app.get(HotelQuickUpdateService, { strict: false })
    const original = svc.clock
    try {
      svc.clock = () => new Date(utc(0).getTime() + 23 * 3_600_000) // 23:00 UTC on today's date
      const request = { scope: scope(planId, 0, 0), changes: { availability: { allotment: 5 } } }
      await prisma.hotel.update({ where: { id: hotels.sold }, data: { timeZone: 'Pacific/Kiritimati' } }) // UTC+14: already tomorrow there
      const early = (await qu(hotels.sold, 'preview', 'manager', request).expect(200)).body.data
      expect(early.hotelToday).toBe(day(1)); expect(early.rows[0].outcome).toBe('INVALID'); expect(early.rows[0].problems.join(' ')).toMatch(/before today in the hotel's time zone/)
      await prisma.hotel.update({ where: { id: hotels.sold }, data: { timeZone: 'Pacific/Pago_Pago' } }) // UTC-11: still today
      const late = (await qu(hotels.sold, 'preview', 'manager', request).expect(200)).body.data
      expect(late.hotelToday).toBe(day(0)); expect(late.rows[0].outcome).not.toBe('INVALID')
    } finally { svc.clock = original; await prisma.hotel.update({ where: { id: hotels.sold }, data: { timeZone: 'Asia/Dubai' } }) }
  })

  it('QU-08 each panel needs its own permission; plans of another hotel or tenant are refused; unauthenticated and cross-tenant calls fail', async () => {
    const planId = await planOf(hotels.sold)
    const price = { scope: scope(planId, 12, 12), changes: { price: { amount: '100.01', basis: 'SELL' } } }
    const avail = { scope: scope(planId, 12, 12), changes: { availability: { stopSell: 'SET' } } }
    await qu(hotels.sold, 'preview', 'reader', price).expect(403) // read-only
    await qu(hotels.sold, 'preview', 'availonly', price).expect(403)
    await qu(hotels.sold, 'preview', 'ratesonly', avail).expect(403)
    await qu(hotels.sold, 'preview', 'ratesonly', price).expect(200)
    await qu(hotels.sold, 'preview', 'availonly', avail).expect(200)
    const p = (await qu(hotels.sold, 'preview', 'manager', price).expect(200)).body.data
    await apply(hotels.sold, p, price, 'ratesonly').expect(200)
    await apply(hotels.sold, p, price, 'availonly').expect(403)
    await qu(hotels.sold, 'preview', 'none', price).expect(403)
    await qu(hotels.sold, 'preview', 'anon', price).expect(401)
    await qu(hotels.sold, 'preview', 'bmanager', price).expect(404) // another tenant cannot see the hotel
    const other = await newDraft('other-hotel')
    const foreign = (await qu(other, 'preview', 'manager', price).expect(200)).body.data // the plan is not this hotel's
    expect(foreign.errors.join(' ')).toMatch(/does not belong to this hotel/); expect(foreign.canApply).toBe(false)
    await apply(other, { fingerprint: foreign.fingerprint }, price).expect(422)
    await qu(hotels.sold, 'apply', 'manager', { ...price, idempotencyKey: key(), reason: 'No preview first' }).expect(400) // a fingerprint is required
    await qu(hotels.sold, 'apply', 'manager', { ...price, idempotencyKey: key(), expectedFingerprint: 'a'.repeat(64), reason: '' }).expect(400)
  })
  it('QU-09 two applies at once serialise: with different keys exactly one wins, with the same key there is one effect', async () => {
    const planId = await planOf(hotels.sold)
    const request = { scope: scope(planId, 10, 11), changes: { price: { amount: '222.22', basis: 'SELL' } } }
    const preview = (await qu(hotels.sold, 'preview', 'manager', request).expect(200)).body.data
    const results = await Promise.all([apply(hotels.sold, preview, request), apply(hotels.sold, preview, request)])
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]); expect(results.find((r) => r.status === 409)!.body.error.code).toBe('QUICK_UPDATE_STALE')
    expect((await rateAt(planId, 10)).amountMinor).toBe(22_222n)
    const next = { scope: scope(planId, 10, 11), changes: { price: { amount: '333.33', basis: 'SELL' } } }
    const p2 = (await qu(hotels.sold, 'preview', 'manager', next).expect(200)).body.data
    const idem = key()
    const before = await prisma.auditEvent.count({ where: { tenantId: tenantA, entityId: hotels.sold, action: 'hotel.quick_update.applied' } })
    const same = await Promise.all([apply(hotels.sold, p2, next, 'manager', idem), apply(hotels.sold, p2, next, 'manager', idem)])
    expect(same.map((r) => r.status)).toEqual([200, 200]); expect(same.map((r) => r.body.data.replayed).sort()).toEqual([false, true])
    expect(await prisma.auditEvent.count({ where: { tenantId: tenantA, entityId: hotels.sold, action: 'hotel.quick_update.applied' } })).toBe(before + 1)
    expect((await rateAt(planId, 11)).amountMinor).toBe(33_333n)
  })
  it('DR-01 distribution separates catalogue publication from transaction enablement and explains seven-day coverage by date, room, plan and supplier', async () => {
    await buildHotel(tenantA, supplier1, 'cover')
    const id = hotels.cover; const planId = await planOf(id)
    await prisma.dailyAvailability.update({ where: { ratePlanId_stayDate: { ratePlanId: planId, stayDate: utc(2) } }, data: { stopSell: true } })
    await prisma.dailyRate.delete({ where: { ratePlanId_stayDate_occupancy: { ratePlanId: planId, stayDate: utc(3), occupancy: 2 } } })
    const read = async (hotelId: string, who = 'reader') => (await api('get', `/admin/operations/hotels/${hotelId}/distribution?from=${day(0)}`, who).expect(200)).body.data
    const d = await read(id)
    expect(d.coverage.window).toEqual({ from: day(0), to: day(6), days: 7 }); expect(d.coverage).toMatchObject({ planNights: 7, sellableNights: 5, truncated: false })
    expect(d.agentSellable).toBe(true); expect(d.coverage.byRoom).toEqual([{ label: 'Deluxe', planNights: 7, sellable: 5 }]); expect(d.coverage.bySupplier).toEqual([{ label: 'Alpha', planNights: 7, sellable: 5 }])
    expect(d.blockers).toHaveLength(2)
    const byDate = Object.fromEntries(d.blockers.map((b: { dates: string[]; reason: string }) => [b.dates[0], b]))
    expect(byDate[day(2)]).toMatchObject({ nights: 1, rooms: ['Deluxe'], ratePlans: ['cover-BB'], suppliers: ['Alpha'] }); expect(byDate[day(3)]).toMatchObject({ nights: 1, rooms: ['Deluxe'], ratePlans: ['cover-BB'], suppliers: ['Alpha'] })
    expect(new Set(d.blockers.map((b: { reason: string }) => b.reason)).size).toBe(2)
    expect(d.catalogue).toMatchObject({ status: 'COMPLETE', published: true, suspended: false, starRatingValid: true, eligible: true, reasons: [] })
    expect([null, { hotel: 0, supplier: 0 }]).toContainEqual(d.restrictions)

    // an unpublished, unrated draft is not eligible, and eligibility is a separate fact from sellability
    const draft = await newDraft('not-published')
    const dd = await read(draft)
    expect(dd.catalogue).toMatchObject({ status: 'DRAFT', published: false, eligible: false }); expect(dd.catalogue.reasons).toEqual(['HOTEL_NOT_PUBLISHED', 'HOTEL_STAR_RATING_MISSING']); expect(dd.agentSellable).toBe(false)
    // publishing changes catalogue state only: the platform booking switch is the same before and after
    const bookingBefore = dd.transaction.bookingEnabled
    await prisma.roomType.create({ data: { hotelId: draft, name: 'Std', code: 'S1', maxAdults: 2, maxChildren: 0, maxOccupancy: 2 } })
    let setup = await load(draft)
    setup = (await save(draft, setup.concurrencyToken, FULL).expect(200)).body.data.setup
    await api('post', `${setupPath(draft)}/status`, 'manager', { idempotencyKey: key(), expectedToken: setup.concurrencyToken, to: 'COMPLETE', reason: 'Reviewed' }).expect(200)
    const after = await read(draft)
    expect(after.catalogue).toMatchObject({ published: true, eligible: true }); expect(after.transaction.bookingEnabled).toBe(bookingBefore); expect(after.agentSellable).toBe(false) // still nothing to sell
    await api('post', `${setupPath(draft)}/status`, 'manager', { idempotencyKey: key(), expectedToken: (await load(draft)).concurrencyToken, to: 'SUSPENDED', reason: 'Withdrawn' }).expect(200)
    expect((await read(draft)).catalogue).toMatchObject({ suspended: true, eligible: false, reasons: ['HOTEL_SUSPENDED'] })
    await api('get', `/admin/operations/hotels/${id}/distribution`, 'none').expect(403)
    await api('get', `/admin/operations/hotels/${id}/distribution`, 'bmanager').expect(404)
    await api('get', `/admin/operations/hotels/${id}/distribution?from=2026-02-30`, 'reader').expect(400)
  })
  it('DR-02 the Admin readiness view agrees with what Agent search actually offers (read-only compatibility)', async () => {
    await buildHotel(tenantA, supplier1, 'compat')
    const id = hotels.compat; const planId = await planOf(id)
    const offered = async () => new Set<string>(((await search('agent').expect(201)).body.data.hotels as Array<{ hotelId: string }>).map((h) => h.hotelId))
    const adminSays = async () => (await api('get', `/admin/operations/hotels/${id}/distribution?from=${day(10)}`, 'reader').expect(200)).body.data
    // sellable and published: both agree
    expect((await adminSays()).agentSellable).toBe(true); expect((await offered()).has(id)).toBe(true)
    // a stop-sell on every night: both agree it is not sellable
    await prisma.dailyAvailability.updateMany({ where: { ratePlanId: planId }, data: { stopSell: true } })
    expect((await adminSays()).agentSellable).toBe(false); expect((await offered()).has(id)).toBe(false)
    await prisma.dailyAvailability.updateMany({ where: { ratePlanId: planId }, data: { stopSell: false } })
    expect((await offered()).has(id)).toBe(true)
    // withdrawn from the catalogue: Agent search stops listing it and the Admin says so, while the rates themselves are unchanged
    await prisma.hotel.update({ where: { id }, data: { contentStatus: 'SUSPENDED' } })
    const suspended = await adminSays()
    expect(suspended.catalogue).toMatchObject({ suspended: true, eligible: false }); expect(suspended.agentSellable).toBe(false); expect((await offered()).has(id)).toBe(false)
    await prisma.hotel.update({ where: { id }, data: { contentStatus: 'DRAFT' } })
    const draft = await adminSays()
    expect(draft.catalogue).toMatchObject({ published: false, eligible: false }); expect(draft.agentSellable).toBe(false); expect((await offered()).has(id)).toBe(false)
    // eligible is false in both unpublished cases, so the page never presents an unpublished hotel as ready for Agents
    expect([suspended.catalogue.eligible, draft.catalogue.eligible]).toEqual([false, false])
  })
})
