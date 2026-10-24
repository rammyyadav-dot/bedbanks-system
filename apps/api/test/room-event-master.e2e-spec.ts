import { INestApplication, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import * as cookieParser from 'cookie-parser'
import * as request from 'supertest'
import { PrismaClient } from '@prisma/client'
import { AppModule } from '../src/app.module'
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor'
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter'
import { hashPassword } from '../src/auth/utils/password'

/**
 * ADR 0089: Room Event Master and event/exhibition supplements, over the real HTTP API against a disposable PostgreSQL.
 *
 * Covers the maker-checker lifecycle of both entities (a submitter cannot decide their own request; another tenant cannot reach either
 * entity), the cross-entity validation on EventSupplement.create (an unapproved RoomEvent, a rate plan from a different contract), the
 * FIXED/PERCENTAGE amount-shape validation the database CHECK constraint also enforces, and — the point of the whole module — that an
 * ACTIVE event supplement actually changes the price Agent search returns, and a SUSPENDED one stops doing so.
 */
const prisma = new PrismaClient()
const DAY = 86_400_000
const iso = (offsetDays: number) => new Date(Math.floor(Date.now() / DAY) * DAY + offsetDays * DAY).toISOString().slice(0, 10)

describe('Room Event Master and event supplements (ADR 0089)', () => {
  const suffix = `room-event-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const password = 'room-event-certification-password'
  let app: INestApplication
  let tenantId: string, otherTenantId: string
  let maker: string, checker: string, readOnly: string, outsider: string
  const userIds: string[] = []
  const roleIds: string[] = []
  let supplierId: string, hotelId: string, contractId: string, ratePlanId: string, otherRatePlanId: string

  const api = (cookie: string, tenant = tenantId) => {
    const configure = (test: request.Test) => test.set('Cookie', cookie).set('x-fbeds-tenant-id', tenant)
    return {
      get: (path: string) => configure(request(app.getHttpServer()).get(`/api/v1${path}`)),
      post: (path: string, body: object = {}) => configure(request(app.getHttpServer()).post(`/api/v1${path}`)).send(body),
      patch: (path: string, body: object) => configure(request(app.getHttpServer()).patch(`/api/v1${path}`)).send(body),
    }
  }
  const login = async (email: string) => {
    const response = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', 'http://localhost:3001').send({ email, password }).expect(200)
    return (response.headers['set-cookie'][0] as string).split(';')[0]
  }
  const expectStatus = (r: request.Response, status: number) => { if (r.status !== status) throw new Error(`expected ${status}, got ${r.status}: ${JSON.stringify(r.body)}`); return r }
  const search = (currency = 'AED') => request(app.getHttpServer()).post('/api/v1/agent/search').set('Cookie', maker)
    .send({ destination: 'Dubai', checkIn: iso(10), checkOut: iso(12), rooms: 1, adults: 2, children: 0, childAges: [], nationality: 'IN', currency, limit: 100 })
  const sellAmount = (body: { data: { hotels: Array<{ hotelId: string; rooms: Array<{ rates: Array<{ total: { amountMinor: number } }> }> }> } }) =>
    body.data.hotels.find((h) => h.hotelId === hotelId)?.rooms[0]?.rates[0]?.total.amountMinor

  // The search window used throughout (checkIn iso(10), checkOut iso(12): nights iso(10) and iso(11)). The default event and supplement
  // window matches it exactly, so the one pricing test below can assert precise before/after amounts.
  async function buildEvent(patch: object = {}) {
    return (await api(maker).post('/admin/room-events', {
      name: `${suffix} Gulfood`, eventType: 'EXHIBITION', destinationCity: 'Dubai', destinationCountry: 'AE', eventStartDate: iso(10), eventEndDate: iso(11), ...patch,
    }).expect(201)).body.data
  }
  async function approvedEvent() {
    const event = await buildEvent()
    const submitted = (await api(maker).post(`/admin/room-events/${event.id}/submit`, { reason: 'Signed exhibition notice attached' }).expect(201)).body.data
    await api(checker).post(`/admin/room-event-approvals/${submitted.approval.id}/approve`, { reason: 'Confirmed with the convention centre' }).expect(201)
    return (await api(maker).get(`/admin/room-events/${event.id}`).expect(200)).body.data
  }
  const fixedSupplement = (roomEventId: string, over: object = {}) => ({
    roomEventId, contractId, amountKind: 'FIXED', basis: 'PER_ROOM', frequency: 'PER_NIGHT', amountMinor: '15000', currency: 'AED',
    validFrom: iso(10), validTo: iso(11), evidenceRef: `${suffix}-evidence`, ...over,
  })

  beforeAll(async () => {
    await prisma.$connect()
    const [tenant, other] = await Promise.all([
      prisma.tenant.create({ data: { name: `${suffix} Tenant`, slug: suffix } }),
      prisma.tenant.create({ data: { name: `${suffix} Other`, slug: `${suffix}-other` } }),
    ])
    tenantId = tenant.id; otherTenantId = other.id
    const passwordHash = await hashPassword(password)
    const users = await Promise.all(['maker', 'checker', 'readonly', 'outsider'].map((name) => prisma.user.create({ data: { email: `${suffix}-${name}@example.test`, passwordHash } })))
    userIds.push(...users.map((user) => user.id))
    const keys = ['supply.room_events.read', 'supply.room_events.manage', 'supply.event_supplements.read', 'supply.event_supplements.manage']
    const permissions = await Promise.all(keys.map((key) => prisma.permission.upsert({ where: { key }, update: {}, create: { key, description: key } })))
    const grant = async (tenant: string, name: string, granted: typeof permissions) => {
      const role = await prisma.role.create({ data: { tenantId: tenant, name: `${suffix}-${name}` } })
      roleIds.push(role.id)
      await prisma.rolePermission.createMany({ data: granted.map((permission) => ({ roleId: role.id, permissionId: permission.id })) })
      return role.id
    }
    const makerRole = await grant(tenantId, 'maker', permissions)
    const checkerRole = await grant(tenantId, 'checker', permissions)
    const readOnlyRole = await grant(tenantId, 'readonly', permissions.filter((p) => p.key.endsWith('.read')))
    const outsiderRole = await grant(otherTenantId, 'outsider', permissions)
    await prisma.membership.createMany({ data: [{ tenantId, userId: userIds[0], role: 'owner' }, { tenantId, userId: userIds[1], role: 'member' }, { tenantId, userId: userIds[2], role: 'member' }, { tenantId: otherTenantId, userId: userIds[3], role: 'owner' }] })
    await prisma.userRole.createMany({ data: [{ tenantId, userId: userIds[0], roleId: makerRole }, { tenantId, userId: userIds[1], roleId: checkerRole }, { tenantId, userId: userIds[2], roleId: readOnlyRole }, { tenantId: otherTenantId, userId: userIds[3], roleId: outsiderRole }] })

    // Contracted inventory, built directly (ADR 0067 contract authoring is not what this suite tests): one ACTIVE contract with two
    // ACTIVE rate plans (so an EventSupplement can be scoped to one plan and the validation can refuse a plan from elsewhere), SELL rates,
    // and open availability over the event window and the search window used below.
    supplierId = (await prisma.supplier.create({ data: { tenantId, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${suffix} Supplier`, displayName: 'Event Supplier', countryCode: 'AE', defaultCurrency: 'AED' } })).id
    hotelId = (await prisma.hotel.create({ data: { tenantId, name: `${suffix} Hotel`, externalRef: `${suffix}-hotel`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', contentStatus: 'COMPLETE', starRating: 5 } })).id
    const room = await prisma.roomType.create({ data: { hotelId, name: 'Deluxe', code: 'DLX', maxAdults: 2, maxChildren: 0, maxOccupancy: 2 } })
    const boardBasisId = (await prisma.boardBasis.upsert({ where: { tenantId_code: { tenantId, code: 'BB' } }, update: {}, create: { tenantId, code: 'BB', name: 'B&B' } })).id
    const mapping = await prisma.supplierHotelMapping.create({ data: { tenantId, supplierId, hotelId, supplierHotelId: `${suffix}-hotel`, status: 'MAPPED' } })
    await prisma.supplierRoomMapping.create({ data: { tenantId, supplierHotelMappingId: mapping.id, hotelId, supplierRoomId: `${suffix}-room`, roomTypeId: room.id, status: 'MAPPED' } })
    const contract = await prisma.contract.create({ data: { tenantId, supplierId, supplierHotelMappingId: mapping.id, code: `${suffix}-C1`, status: 'ACTIVE', validFrom: new Date(iso(-30)), validTo: new Date(iso(365)), settlementCurrency: 'AED' } as never })
    contractId = contract.id
    const plan = await prisma.ratePlan.create({ data: { tenantId, contractId, roomTypeId: room.id, boardBasisId, code: 'EVT-BB', status: 'ACTIVE', occupancy: 2, currency: 'AED', minStay: 1 } })
    ratePlanId = plan.id
    // A second contract and plan, kept DRAFT (never searchable) so it cannot compete with ratePlanId's offer in Agent search — it exists
    // only so the cross-entity validation test can prove a rate plan from a different contract is refused.
    const otherContract = await prisma.contract.create({ data: { tenantId, supplierId, supplierHotelMappingId: mapping.id, code: `${suffix}-C2`, status: 'ACTIVE', validFrom: new Date(iso(-30)), validTo: new Date(iso(365)), settlementCurrency: 'AED' } as never })
    const otherPlan = await prisma.ratePlan.create({ data: { tenantId, contractId: otherContract.id, roomTypeId: room.id, boardBasisId, code: 'EVT-BB2', status: 'DRAFT', occupancy: 2, currency: 'AED', minStay: 1 } })
    otherRatePlanId = otherPlan.id
    const range = Array.from({ length: 30 }, (_, i) => new Date(iso(i)))
    await prisma.dailyRate.createMany({ data: range.map((stayDate) => ({ tenantId, ratePlanId, stayDate, occupancy: 2, amountMinor: 29_900n, currency: 'AED', amountBasis: 'SELL' as const })) })
    await prisma.dailyAvailability.createMany({ data: range.map((stayDate) => ({ tenantId, ratePlanId, stayDate, allotment: 5, sold: 0, stopSell: false })) })

    const module = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = module.createNestApplication()
    app.use(cookieParser())
    app.setGlobalPrefix('api/v1')
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
    app.useGlobalFilters(new HttpExceptionFilter())
    app.useGlobalInterceptors(new ResponseInterceptor())
    await app.init()
    maker = await login(`${suffix}-maker@example.test`)
    checker = await login(`${suffix}-checker@example.test`)
    readOnly = await login(`${suffix}-readonly@example.test`)
    outsider = await login(`${suffix}-outsider@example.test`)
  }, 90_000)

  afterAll(async () => {
    await app?.close()
    const scope = { in: [tenantId, otherTenantId] }
    await prisma.$transaction([prisma.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`), prisma.$executeRaw`DELETE FROM "EventSupplementVersion" WHERE tenant_id = ANY(${[tenantId, otherTenantId]})`])
    await prisma.auditEvent.deleteMany({ where: { tenantId: scope } })
    await prisma.approvalRequest.deleteMany({ where: { tenantId: scope } })
    await prisma.eventSupplement.deleteMany({ where: { tenantId: scope } })
    await prisma.roomEvent.deleteMany({ where: { tenantId: scope } })
    await prisma.dailyRate.deleteMany({ where: { tenantId: scope } })
    await prisma.dailyAvailability.deleteMany({ where: { tenantId: scope } })
    await prisma.ratePlan.deleteMany({ where: { tenantId: scope } })
    await prisma.contract.deleteMany({ where: { tenantId: scope } })
    await prisma.supplierRoomMapping.deleteMany({ where: { tenantId: scope } })
    await prisma.supplierHotelMapping.deleteMany({ where: { tenantId: scope } })
    await prisma.boardBasis.deleteMany({ where: { tenantId: scope } })
    await prisma.roomType.deleteMany({ where: { hotel: { tenantId: scope } } })
    await prisma.hotel.deleteMany({ where: { tenantId: scope } })
    await prisma.supplier.deleteMany({ where: { tenantId: scope } })
    await prisma.userRole.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.rolePermission.deleteMany({ where: { roleId: { in: roleIds } } })
    await prisma.role.deleteMany({ where: { id: { in: roleIds } } })
    await prisma.membership.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.session.deleteMany({ where: { userId: { in: userIds } } })
    await prisma.user.deleteMany({ where: { id: { in: userIds } } })
    await prisma.tenant.deleteMany({ where: { id: scope } })
    await prisma.$disconnect()
  })

  describe('Room Event Master lifecycle', () => {
    it('creates a draft, validates required fields, and only a draft can be edited', async () => {
      await api(maker).post('/admin/room-events', { name: '', eventType: 'EXHIBITION', destinationCity: 'Dubai', destinationCountry: 'AE', eventStartDate: iso(5), eventEndDate: iso(9) }).expect(400)
      await api(maker).post('/admin/room-events', { name: 'x', eventType: 'NOT_A_TYPE', destinationCity: 'Dubai', destinationCountry: 'AE', eventStartDate: iso(5), eventEndDate: iso(9) }).expect(400)
      await api(maker).post('/admin/room-events', { name: 'x', eventType: 'EXHIBITION', destinationCity: 'Dubai', destinationCountry: 'AE', eventStartDate: iso(9), eventEndDate: iso(5) }).expect(400)
      const event = await buildEvent()
      expect(event).toMatchObject({ status: 'DRAFT', name: `${suffix} Gulfood`, approvedById: null })
      await api(maker).patch(`/admin/room-events/${event.id}`, { name: `${suffix} Gulfood Expo` }).expect(200)
      await api(readOnly).patch(`/admin/room-events/${event.id}`, { name: 'nope' }).expect(403)
      await api(outsider, otherTenantId).get(`/admin/room-events/${event.id}`).expect(404)
    })

    it('submit opens a maker-checker request; the submitter cannot decide it; approval stamps approvedById', async () => {
      const event = await buildEvent()
      await api(readOnly).post(`/admin/room-events/${event.id}/submit`, { reason: 'x' }).expect(403)
      const submitted = expectStatus(await api(maker).post(`/admin/room-events/${event.id}/submit`, { reason: 'Signed exhibition notice attached' }), 201).body.data
      expect(submitted).toMatchObject({ status: 'PENDING_APPROVAL' })
      await api(maker).post(`/admin/room-events/${event.id}/submit`, { reason: 'again' }).expect(409)
      await api(maker).post(`/admin/room-event-approvals/${submitted.approval.id}/approve`, { reason: 'self' }).expect(403)
      await api(outsider, otherTenantId).post(`/admin/room-event-approvals/${submitted.approval.id}/approve`, { reason: 'x' }).expect(404)
      const approved = expectStatus(await api(checker).post(`/admin/room-event-approvals/${submitted.approval.id}/approve`, { reason: 'Confirmed with the convention centre' }), 201).body.data
      expect(approved).toMatchObject({ status: 'APPROVED', approvedById: expect.any(String) })
      expect(approved.approvedAt).toBeTruthy()
    })

    it('a rejected request returns the event to DRAFT for correction', async () => {
      const event = await buildEvent()
      const submitted = (await api(maker).post(`/admin/room-events/${event.id}/submit`, { reason: 'first pass' }).expect(201)).body.data
      const rejected = expectStatus(await api(checker).post(`/admin/room-event-approvals/${submitted.approval.id}/reject`, { reason: 'Dates do not match the official notice' }), 201).body.data
      expect(rejected).toMatchObject({ status: 'DRAFT' })
      await api(maker).patch(`/admin/room-events/${event.id}`, { eventEndDate: iso(10) }).expect(200)
    })

    it('cancel and archive are single-actor terminal moves', async () => {
      const event = await buildEvent()
      await api(maker).post(`/admin/room-events/${event.id}/archive`, { reason: 'too early' }).expect(409)
      const cancelled = expectStatus(await api(maker).post(`/admin/room-events/${event.id}/cancel`, { reason: 'Event postponed indefinitely' }), 201).body.data
      expect(cancelled.status).toBe('CANCELLED')
      const archived = expectStatus(await api(maker).post(`/admin/room-events/${event.id}/archive`, { reason: 'Closing out the record' }), 201).body.data
      expect(archived.status).toBe('ARCHIVED')
      await api(maker).post(`/admin/room-events/${event.id}/cancel`, { reason: 'x' }).expect(409)
    })
  })

  describe('Event supplement lifecycle and cross-entity validation', () => {
    it('refuses a supplement against an unapproved room event, a mismatched rate plan, or a malformed amount', async () => {
      const draftEvent = await buildEvent({ name: `${suffix} Unapproved` })
      await api(maker).post('/admin/event-supplements', fixedSupplement(draftEvent.id)).expect(400)
      const approved = await approvedEvent()
      await api(maker).post('/admin/event-supplements', fixedSupplement(approved.id, { ratePlanId: otherRatePlanId })).expect(400)
      await api(maker).post('/admin/event-supplements', fixedSupplement(approved.id, { amountKind: 'FIXED', basis: 'PER_ROOM', frequency: 'PER_NIGHT', amountMinor: '0' })).expect(400)
      await api(maker).post('/admin/event-supplements', fixedSupplement(approved.id, { amountKind: 'PERCENTAGE', percentBp: 20_000 })).expect(400)
      await api(maker).post('/admin/event-supplements', { ...fixedSupplement(approved.id), evidenceRef: '' }).expect(400)
    })

    it('creates a draft FIXED supplement scoped to one rate plan, and a PERCENTAGE supplement with no basis/frequency', async () => {
      const approved = await approvedEvent()
      const fixed = (await api(maker).post('/admin/event-supplements', fixedSupplement(approved.id, { ratePlanId })).expect(201)).body.data
      expect(fixed).toMatchObject({ status: 'DRAFT', amountKind: 'FIXED', amountMinor: '15000', basis: 'PER_ROOM', ratePlanId, version: 1 })
      const percent = (await api(maker).post('/admin/event-supplements', { roomEventId: approved.id, contractId, amountKind: 'PERCENTAGE', percentBp: 1_000, currency: 'AED', validFrom: iso(5), validTo: iso(9), evidenceRef: `${suffix}-pct` }).expect(201)).body.data
      expect(percent).toMatchObject({ status: 'DRAFT', amountKind: 'PERCENTAGE', percentBp: 1_000, basis: null, frequency: null, amountMinor: null })
    })

    it('submit -> approve -> activate writes an immutable version and moves the row to ACTIVE; only ACTIVE prices', async () => {
      // Baseline: two contracted SELL nights at AED 299.00, no event supplement in effect yet.
      const baseline = sellAmount((await search().expect(201)).body)
      expect(baseline).toBe(59_800)

      const approved = await approvedEvent()
      const supplement = (await api(maker).post('/admin/event-supplements', fixedSupplement(approved.id, { ratePlanId })).expect(201)).body.data
      await api(maker).post(`/admin/event-supplements/${supplement.id}/activate`, { reason: 'x' }).expect(409) // not yet approved
      const submitted = (await api(maker).post(`/admin/event-supplements/${supplement.id}/submit`, { reason: 'Contracted event supplement for Gulfood' }).expect(201)).body.data
      await api(maker).post(`/admin/event-supplement-approvals/${submitted.approval.id}/approve`, { reason: 'self' }).expect(403)
      await api(checker).post(`/admin/event-supplement-approvals/${submitted.approval.id}/approve`, { reason: 'Matches the contract amendment' }).expect(201)
      await api(readOnly).post(`/admin/event-supplements/${supplement.id}/activate`, { reason: 'x' }).expect(403)
      const activated = expectStatus(await api(maker).post(`/admin/event-supplements/${supplement.id}/activate`, { reason: 'Going live for the event window' }), 201).body.data
      expect(activated).toMatchObject({ status: 'ACTIVE' })
      expect(activated.activatedAt).toBeTruthy()
      const versions = await prisma.eventSupplementVersion.findMany({ where: { eventSupplementId: supplement.id } })
      expect(versions).toHaveLength(1)
      expect(versions[0]).toMatchObject({ kind: 'ACTIVATION', version: 1 })
      expect(versions[0].requestedById).not.toBe(versions[0].approvedById)

      // The point of the module: AED 150.00 per room per night, two nights, one room = AED 300.00 added to the total — exactly the
      // contracted base plus the supplement, never a rewrite of the DailyRate itself.
      const withSupplement = sellAmount((await search().expect(201)).body)
      expect(withSupplement).toBe(baseline! + 30_000)
      expect(await prisma.dailyRate.findMany({ where: { tenantId, ratePlanId } })).toEqual(expect.arrayContaining([expect.objectContaining({ amountMinor: 29_900n })]))

      // Suspending stops new applications immediately; the price returns exactly to baseline.
      await api(maker).post(`/admin/event-supplements/${supplement.id}/suspend`, { reason: 'Event cancelled by the organiser' }).expect(201)
      const afterSuspend = sellAmount((await search().expect(201)).body)
      expect(afterSuspend).toBe(baseline)
    })

    it('activation is refused once the room event is no longer APPROVED', async () => {
      const approved = await approvedEvent()
      const supplement = (await api(maker).post('/admin/event-supplements', fixedSupplement(approved.id, { ratePlanId })).expect(201)).body.data
      const submitted = (await api(maker).post(`/admin/event-supplements/${supplement.id}/submit`, { reason: 'x' }).expect(201)).body.data
      await api(checker).post(`/admin/event-supplement-approvals/${submitted.approval.id}/approve`, { reason: 'ok' }).expect(201)
      await api(maker).post(`/admin/room-events/${approved.id}/cancel`, { reason: 'Event postponed' }).expect(201)
      await api(maker).post(`/admin/event-supplements/${supplement.id}/activate`, { reason: 'x' }).expect(409)
    })

    it('another tenant cannot reach a supplement or its approvals', async () => {
      const approved = await approvedEvent()
      const supplement = (await api(maker).post('/admin/event-supplements', fixedSupplement(approved.id, { ratePlanId })).expect(201)).body.data
      await api(outsider, otherTenantId).get(`/admin/event-supplements/${supplement.id}`).expect(404)
      const submitted = (await api(maker).post(`/admin/event-supplements/${supplement.id}/submit`, { reason: 'x' }).expect(201)).body.data
      await api(outsider, otherTenantId).post(`/admin/event-supplement-approvals/${submitted.approval.id}/approve`, { reason: 'x' }).expect(404)
    })
  })
})
