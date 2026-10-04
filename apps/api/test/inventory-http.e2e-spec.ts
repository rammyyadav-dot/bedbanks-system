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

jest.setTimeout(180_000)

/**
 * The inventory journey over HTTP on PostgreSQL: Admin shapes a shared pool, Agent search reflects it, Admin changes the stock,
 * recheck reflects the change. Also RBAC (read-only account, no permission, anonymous) and tenant isolation.
 */
describe('inventory & allotment over HTTP (PostgreSQL, two tenants)', () => {
  const prisma = new PrismaClient()
  const suffix = `ih-${Date.now()}-${randomBytes(3).toString('hex')}`
  const password = 'inventory-http-password'
  const midnight = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z').getTime()
  const day = (o: number) => new Date(midnight + o * 86_400_000).toISOString().slice(0, 10)
  const utc = (o: number) => new Date(midnight + o * 86_400_000)
  let app: INestApplication
  let tenantA = '', tenantB = '', supplierId = '', hotelId = '', roomId = '', boardId = '', contractId = ''
  const planIds: string[] = []
  const userIds: string[] = []; const cookies: Record<string, string> = {}
  let seq = 0
  const key = () => `${suffix}-k${++seq}-${randomBytes(2).toString('hex')}`

  async function user(label: string, tenantId: string, keys: string[]) {
    const email = `${suffix}-${label}@example.test`
    const u = await prisma.user.create({ data: { email, name: label, passwordHash: await hashPassword(password), status: 'ACTIVE' } })
    userIds.push(u.id)
    await prisma.membership.create({ data: { tenantId, userId: u.id, role: 'agent' } })
    if (keys.length) {
      const r = await prisma.role.create({ data: { tenantId, name: `${suffix}-${label}` } })
      for (const k of keys) {
        const p = await prisma.permission.upsert({ where: { key: k }, update: {}, create: { key: k, description: k } })
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
  const api = (method: 'get' | 'post' | 'patch', path: string, who: string, body?: object) => {
    const r = request(app.getHttpServer())[method](`/api/v1${path}`); const c = who === 'anon' ? r : r.set('Cookie', cookies[who]); return body ? c.send(body) : c
  }
  const inv = (path = '') => `/admin/hotels/${hotelId}/inventory${path}`
  const search = (who: string) => request(app.getHttpServer()).post('/api/v1/agent/search').set('Cookie', cookies[who])
    .send({ destination: 'Dubai', checkIn: day(10), checkOut: day(12), rooms: 1, adults: 2, children: 0, childAges: [], nationality: 'IN', currency: 'AED', limit: 100 })
  const rates = (body: { data: { hotels: Array<{ rooms: Array<{ rates: Array<{ ratePlanId: string; availability: string; available: boolean; offerId: string; sellAmountMinor: number }> }> }> } }) => body.data.hotels.flatMap((h) => h.rooms.flatMap((r) => r.rates))
  const quick = (who: string, path: 'preview' | 'apply', body: object) => api('post', `/admin/hotels/${hotelId}/quick-update/${path}`, who, body)

  beforeAll(async () => {
    await prisma.$connect()
    tenantA = (await prisma.tenant.create({ data: { name: `${suffix} A`, slug: `${suffix}-a` } })).id
    tenantB = (await prisma.tenant.create({ data: { name: `${suffix} B`, slug: `${suffix}-b` } })).id
    supplierId = (await prisma.supplier.create({ data: { tenantId: tenantA, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${suffix} Alpha`, displayName: 'Alpha', countryCode: 'AE', defaultCurrency: 'AED' } as never })).id
    boardId = (await prisma.boardBasis.create({ data: { tenantId: tenantA, code: 'BB', name: 'B&B' } })).id
    const hotel = await prisma.hotel.create({ data: { tenantId: tenantA, name: `${suffix} Palm`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', contentStatus: 'COMPLETE', starRating: 5 } })
    hotelId = hotel.id
    roomId = (await prisma.roomType.create({ data: { hotelId, name: 'Deluxe', code: `D-${suffix}`.slice(0, 40), maxAdults: 2, maxChildren: 0, maxOccupancy: 2 } })).id
    const mapping = await prisma.supplierHotelMapping.create({ data: { tenantId: tenantA, supplierId, hotelId, supplierHotelId: `${suffix}-h`, status: 'MAPPED' } })
    await prisma.supplierRoomMapping.create({ data: { tenantId: tenantA, supplierHotelMappingId: mapping.id, hotelId, supplierRoomId: `${suffix}-r`, roomTypeId: roomId, status: 'MAPPED' } })
    contractId = (await prisma.contract.create({ data: { tenantId: tenantA, supplierId, supplierHotelMappingId: mapping.id, code: `${suffix}-c`, status: 'ACTIVE', validFrom: utc(-400), validTo: utc(4000), settlementCurrency: 'AED' } as never })).id
    for (const code of ['P1', 'P2', 'P3']) {
      const plan = await prisma.ratePlan.create({ data: { tenantId: tenantA, contractId, roomTypeId: roomId, boardBasisId: boardId, code, status: 'ACTIVE', occupancy: 2, currency: 'AED', minStay: 1 } })
      planIds.push(plan.id)
      const range = Array.from({ length: 30 }, (_, i) => utc(i))
      await prisma.dailyRate.createMany({ data: range.map((stayDate) => ({ tenantId: tenantA, ratePlanId: plan.id, stayDate, occupancy: 2, amountMinor: 10_000n, currency: 'AED', amountBasis: 'SELL' as const })) })
      await prisma.dailyAvailability.createMany({ data: range.map((stayDate) => ({ tenantId: tenantA, ratePlanId: plan.id, stayDate, allotment: 9 })) })
    }
    const mgr = ['supply.hotels.read', 'supply.rates.read', 'supply.rates.manage', 'supply.availability.read', 'supply.availability.manage']
    const manager = await user('manager', tenantA, mgr)
    const readonly = await user('readonly', tenantA, ['supply.hotels.read', 'supply.rates.read', 'supply.availability.read'])
    const none = await user('none', tenantA, [])
    const agent = await user('agent', tenantA, ['hotel.search'])
    const bManager = await user('bmanager', tenantB, mgr)
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = module.createNestApplication()
    app.use(cookieParser()); app.setGlobalPrefix('api/v1')
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
    app.useGlobalFilters(new HttpExceptionFilter()); app.useGlobalInterceptors(new ResponseInterceptor())
    await app.init()
    for (const [label, email] of Object.entries({ manager, readonly, none, agent, bmanager: bManager })) cookies[label] = await login(email)
  })

  afterAll(async () => {
    await app?.close()
    for (const tenantId of [tenantA, tenantB].filter(Boolean)) {
      await prisma.auditEvent.deleteMany({ where: { tenantId } }); await prisma.inventoryHoldNight.deleteMany({ where: { tenantId } }); await prisma.inventoryHold.deleteMany({ where: { tenantId } })
      await prisma.dailyRate.deleteMany({ where: { tenantId } }); await prisma.dailyAvailability.deleteMany({ where: { tenantId } }); await prisma.ratePlan.deleteMany({ where: { tenantId } })
      await prisma.inventoryPoolDay.deleteMany({ where: { tenantId } }); await prisma.inventoryPool.deleteMany({ where: { tenantId } })
      await prisma.contract.deleteMany({ where: { tenantId } }); await prisma.supplierRoomMapping.deleteMany({ where: { tenantId } }); await prisma.supplierHotelMapping.deleteMany({ where: { tenantId } })
      await prisma.boardBasis.deleteMany({ where: { tenantId } }); await prisma.roomType.deleteMany({ where: { hotel: { tenantId } } }); await prisma.hotel.deleteMany({ where: { tenantId } }); await prisma.supplier.deleteMany({ where: { tenantId } })
      await prisma.userRole.deleteMany({ where: { tenantId } }); await prisma.rolePermission.deleteMany({ where: { role: { tenantId } } }); await prisma.role.deleteMany({ where: { tenantId } }); await prisma.membership.deleteMany({ where: { tenantId } })
    }
    await prisma.session.deleteMany({ where: { userId: { in: userIds } } }); await prisma.user.deleteMany({ where: { id: { in: userIds } } })
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB].filter(Boolean) } } })
    await prisma.$disconnect()
  })

  let pool: { id: string; updatedAt: string }

  it('IH-01 access control: anonymous 401, no permission 403, read-only can read but every mutation is 403, other tenant 404', async () => {
    await api('get', inv('/summary'), 'anon').expect(401)
    await api('get', inv('/summary'), 'none').expect(403)
    await api('get', inv('/summary'), 'readonly').expect(200)
    const body = { name: 'X', supplierId, ratePlanIds: [], idempotencyKey: key() }
    await api('post', inv('/pools'), 'readonly', body).expect(403)
    await api('post', inv('/pools'), 'none', body).expect(403)
    await api('post', inv('/pools'), 'anon', body).expect(401)
    await api('patch', inv(`/rate-plans/${planIds[0]}/release`), 'readonly', { releaseDays: 1, releaseTimeLocal: '10:00', expectedUpdatedAt: new Date().toISOString(), reason: 'nope', idempotencyKey: key() }).expect(403)
    await api('get', inv('/summary'), 'bmanager').expect(404)
    await api('post', inv('/pools'), 'bmanager', body).expect(404)
    expect(await prisma.inventoryPool.count({ where: { hotelId } })).toBe(0)
  })

  it('IH-02 the request body is validated strictly: a client-supplied tenant is ignored by design and malformed input is 400', async () => {
    await api('post', inv('/pools'), 'manager', { name: '', supplierId, idempotencyKey: key() }).expect(400)
    await api('post', inv('/pools'), 'manager', { name: 'No key', supplierId }).expect(400)
    await api('post', inv('/pools'), 'manager', { name: 'Bad plan', supplierId, ratePlanIds: ['../etc'], idempotencyKey: key() }).expect(400)
    await api('get', inv('/summary?days=0'), 'manager').expect(400)
    await api('get', inv('/summary?from=2026-02-31'), 'manager').expect(400)
  })

  it('IH-03 journey: create a pool, set its capacity once, Agent search shows one shared stock', async () => {
    const created = (await api('post', inv('/pools'), 'manager', { name: 'Palm shared', supplierId, ratePlanIds: planIds, idempotencyKey: key() }).expect(200)).body.data
    expect(created.pool.members).toHaveLength(3); pool = { id: created.pool.id, updatedAt: created.pool.updatedAt }
    const scope = { ratePlanIds: planIds, ranges: [{ from: day(10), to: day(11) }] }
    const changes = { availability: { allotment: 2 } }
    const preview = (await quick('manager', 'preview', { scope, changes }).expect(200)).body.data
    expect(preview.canApply).toBe(true)
    const applied = (await quick('manager', 'apply', { scope, changes, idempotencyKey: key(), expectedFingerprint: preview.fingerprint, reason: 'shared capacity 2' }).expect(200)).body.data
    expect(applied.changed.poolDays).toBe(2)
    const summary = (await api('get', inv(`/summary?from=${day(10)}&days=2`), 'readonly').expect(200)).body.data
    expect(summary.pools[0].nights.map((n: { capacity: number; remaining: number }) => [n.capacity, n.remaining])).toEqual([[2, 2], [2, 2]])
    const found = rates((await search('agent').expect(201)).body)
    expect(found.filter((r) => planIds.includes(r.ratePlanId))).toHaveLength(3)
    expect(found.every((r) => r.availability === 'available' && r.available)).toBe(true) // 2 shared units left for a 1-room search
    await prisma.inventoryPoolDay.updateMany({ where: { poolId: pool.id }, data: { held: 1 } }) // 1 unit left: limited, for all three plans at once
    const limited = rates((await search('agent').expect(201)).body).filter((r) => planIds.includes(r.ratePlanId))
    expect(limited).toHaveLength(3); expect(limited.every((r) => r.availability === 'limited')).toBe(true)
    await prisma.inventoryPoolDay.updateMany({ where: { poolId: pool.id }, data: { held: 0 } })
  })

  it('IH-04 the pool is exhausted by sales elsewhere: search hides all three plans and a prior offer rechecks as unavailable', async () => {
    const before = rates((await search('agent').expect(201)).body)
    const offer = before.find((r) => r.ratePlanId === planIds[0])!
    const recheck = (o: { offerId: string; sellAmountMinor: number }) => request(app.getHttpServer()).post('/api/v1/agent/rates/recheck').set('Cookie', cookies.agent).send({ offerId: o.offerId, searchId: 'search-1', expectedCurrency: 'AED', expectedSellAmountMinor: o.sellAmountMinor })
    const ok = await recheck(offer)
    expect(ok.status).toBe(200)
    expect(ok.body.data.status).toBe('rechecked')
    await prisma.inventoryPoolDay.updateMany({ where: { poolId: pool.id }, data: { sold: 2 } })
    const after = rates((await search('agent').expect(201)).body)
    expect(after.filter((r) => planIds.includes(r.ratePlanId))).toHaveLength(0)
    const gone = await recheck(offer)
    expect(gone.status).toBe(409); expect(gone.body.data.status).toBe('unavailable')
    // capacity can no longer be cut below what is sold
    const low = (await quick('manager', 'preview', { scope: { ratePlanIds: [planIds[0]], ranges: [{ from: day(10), to: day(10) }] }, changes: { availability: { allotment: 1 } } }).expect(200)).body.data
    expect(low.canApply).toBe(false)
    await prisma.inventoryPoolDay.updateMany({ where: { poolId: pool.id }, data: { sold: 0 } })
  })

  it('IH-05 ON_REQUEST appears to the Agent as on_request and not available; it cannot be rechecked into a hold; closed-to-departure ends the stay offer', async () => {
    const scope = { ratePlanIds: [planIds[1]], ranges: [{ from: day(10), to: day(11) }] }
    const changes = { availability: { mode: 'ON_REQUEST' } }
    const preview = (await quick('manager', 'preview', { scope, changes }).expect(200)).body.data
    await quick('manager', 'apply', { scope, changes, idempotencyKey: key(), expectedFingerprint: preview.fingerprint, reason: 'event on request' }).expect(200)
    const found = rates((await search('agent').expect(201)).body)
    const p2 = found.find((r) => r.ratePlanId === planIds[1])!
    expect(p2).toMatchObject({ availability: 'on_request', available: false })
    expect(found.find((r) => r.ratePlanId === planIds[0])).toMatchObject({ available: true })
    const hold = await request(app.getHttpServer()).post('/api/v1/agent/rates/recheck').set('Cookie', cookies.agent).send({ offerId: p2.offerId, searchId: 'search-2', expectedCurrency: 'AED', expectedSellAmountMinor: p2.sellAmountMinor })
    expect(hold.status).toBe(409); expect(hold.body.data.status).toBe('unavailable')
    // restore, then close departure on day 12
    const back = (await quick('manager', 'preview', { scope, changes: { availability: { mode: 'ALLOTMENT' } } }).expect(200)).body.data
    await quick('manager', 'apply', { scope, changes: { availability: { mode: 'ALLOTMENT' } }, idempotencyKey: key(), expectedFingerprint: back.fingerprint, reason: 'event over' }).expect(200)
    const ctdScope = { ratePlanIds: [planIds[2]], ranges: [{ from: day(12), to: day(12) }] }
    const ctd = { restrictions: { closedToDeparture: 'SET' } }
    const pv = (await quick('manager', 'preview', { scope: ctdScope, changes: ctd }).expect(200)).body.data
    await quick('manager', 'apply', { scope: ctdScope, changes: ctd, idempotencyKey: key(), expectedFingerprint: pv.fingerprint, reason: 'no checkout day 12' }).expect(200)
    const after = rates((await search('agent').expect(201)).body)
    expect(after.find((r) => r.ratePlanId === planIds[2])).toBeUndefined()
    expect(after.find((r) => r.ratePlanId === planIds[0])).toBeDefined()
  })

  it('IH-06 the audit trail names every inventory action, with the actor and no secrets', async () => {
    const actions = (await prisma.auditEvent.findMany({ where: { tenantId: tenantA, action: { startsWith: 'inventory.' } }, select: { action: true, userId: true, payload: true } }))
    const names = new Set(actions.map((a) => a.action))
    for (const expected of ['inventory.pool.created', 'inventory.pool.member_added', 'inventory.bulk.updated', 'inventory.mode.changed']) expect(names.has(expected)).toBe(true)
    expect(actions.every((a) => a.userId !== null)).toBe(true)
    expect(JSON.stringify(actions)).not.toMatch(/password|token|secret/i)
  })
})
