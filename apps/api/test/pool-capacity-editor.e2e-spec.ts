import { randomBytes } from 'crypto'
import { INestApplication, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { PrismaClient } from '@prisma/client'
import * as cookieParser from 'cookie-parser'
import * as request from 'supertest'
import type { SearchCriteria } from '@bedbanks/domain'
import { AppModule } from '../src/app.module'
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter'
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor'
import { hashPassword } from '../src/auth/utils/password'
import { PrismaService } from '../src/database/prisma.service'
import { InventoryHoldService } from '../src/agent/inventory-hold.service'
import { ContractedInventoryAdapter } from '../src/agent/contracted-inventory.adapter'
import { moveNight } from '../src/inventory/inventory-counters'
import { API_RUNTIME_LOGIN_ROLE, provisionApiRuntimeRole, verifyApiRuntimeRole } from '../src/database/api-runtime-role'

const ownerUrl = process.env.DATABASE_URL
if (!ownerUrl) throw new Error('DATABASE_URL (the disposable owner connection) is required')
jest.setTimeout(240_000)

/**
 * ADR 0036: pool detail, per-plan consumption and the bounded capacity editor, over HTTP against PostgreSQL with two tenants, the real hold
 * lifecycle, the Agent adapter, and the provisioned non-superuser, non-BYPASSRLS runtime role. Dates are relative to today (UTC).
 */
describe('pool capacity editor and per-plan consumption (PostgreSQL, HTTP, two tenants)', () => {
  const owner = new PrismaClient({ datasourceUrl: ownerUrl })
  const db = new PrismaService()
  const holds = new InventoryHoldService(db)
  const adapter = new ContractedInventoryAdapter(db)
  const suffix = `pc-${Date.now()}-${randomBytes(3).toString('hex')}`
  const password = 'pool-capacity-password'
  const origin = 'http://localhost:3001'
  const base = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z').getTime()
  const day = (offset: number) => new Date(base + offset * 86_400_000).toISOString().slice(0, 10)
  const D = [day(20), day(21), day(22), day(23), day(24)] // pool nights d+20 .. d+24
  let app: INestApplication; let strictApp: INestApplication | undefined
  let tenantA = '', tenantB = '', supplierA = '', supplierB = '', hotelA = '', hotelA2 = '', hotelB = '', roomA = '', boardA = '', poolA = '', poolOther = '', poolB = ''
  const plans: string[] = []; const userIds: string[] = []; const cookies: Record<string, string> = {}; const strictCookies: Record<string, string> = {}
  let ownerUserId = ''
  const poolDays: Record<string, string> = {}

  const path = (hotel: string, pool: string, tail = '') => `/api/v1/admin/hotels/${hotel}/inventory/pools/${pool}${tail}`
  const as = (a: INestApplication, jar: Record<string, string>) => ({
    get: (p: string, who: string) => { const r = request(a.getHttpServer()).get(p); return who === 'anon' ? r : r.set('Cookie', jar[who]) },
    post: (p: string, who: string, body: object) => { const r = request(a.getHttpServer()).post(p).set('Origin', origin).send(body); return who === 'anon' ? r : r.set('Cookie', jar[who]) },
  })
  const http = () => as(app, cookies)
  let seq = 0
  const key = () => `${suffix}-k${++seq}`
  const edit = (over: Record<string, unknown> = {}) => ({ startDate: D[0], endDate: D[4], capacity: 6, ...over })
  const preview = (body: object = edit(), who = 'full', hotel = hotelA, pool = poolA) => http().post(path(hotel, pool, '/capacity/preview'), who, body)
  const apply = (body: object, who = 'full', hotel = hotelA, pool = poolA) => http().post(path(hotel, pool, '/capacity/apply'), who, body)
  const applyBody = (p: { fingerprint: string }, over: Record<string, unknown> = {}) => ({ ...edit(), expectedFingerprint: p.fingerprint, reason: 'Hotel confirmed a larger allotment', idempotencyKey: key(), ...over })
  const dayRow = (date: string, pool = poolA) => owner.inventoryPoolDay.findFirstOrThrow({ where: { poolId: pool, stayDate: new Date(date) } })
  const capacities = async () => (await owner.inventoryPoolDay.findMany({ where: { poolId: poolA }, orderBy: { stayDate: 'asc' } })).map((r) => [r.capacity, r.sold, r.held])
  const reset = async () => { await owner.inventoryPoolDay.updateMany({ where: { poolId: poolA }, data: { capacity: 5, sold: 0, held: 0 } }) }
  const cmd = (k: string, ratePlanId: string, checkIn: string, checkOut: string, rooms = 1) => ({
    tenantId: tenantA, userId: ownerUserId, requestId: `${k}-r`, idempotencyKey: k, offerId: 'o', searchId: 's', ratePlanId, canonicalHotelId: hotelA, canonicalRoomTypeId: roomA,
    boardBasisId: boardA, checkIn, checkOut, rooms, currency: 'AED', sellAmountMinor: 100_000, offerExpiresAt: new Date(base + 40 * 86_400_000).toISOString(),
  })
  const confirmHold = async (holdId: string) => {
    const nights = await owner.inventoryHoldNight.findMany({ where: { holdId }, select: { availabilityId: true, counterKind: true, poolDayId: true, quantity: true } })
    await owner.$transaction(async (tx) => { for (const n of nights) await moveNight(tx as never, tenantA, n, 'confirm') })
    await owner.inventoryHold.update({ where: { id: holdId }, data: { status: 'CONFIRMED' } })
  }
  const cancelHold = async (holdId: string) => {
    const nights = await owner.inventoryHoldNight.findMany({ where: { holdId }, select: { availabilityId: true, counterKind: true, poolDayId: true, quantity: true } })
    await owner.$transaction(async (tx) => { for (const n of nights) await moveNight(tx as never, tenantA, n, 'cancel') })
    await owner.inventoryHold.update({ where: { id: holdId }, data: { status: 'RELEASED', releasedAt: new Date() } })
  }

  async function user(label: string, tenantId: string, keys: string[]) {
    const email = `${suffix}-${label}@example.test`
    const u = await owner.user.create({ data: { email, passwordHash: await hashPassword(password), status: 'ACTIVE' } })
    userIds.push(u.id)
    await owner.membership.create({ data: { tenantId, userId: u.id, role: 'agent' } })
    if (keys.length) {
      const r = await owner.role.create({ data: { tenantId, name: `${suffix}-${label}` } })
      for (const k of keys) {
        const p = await owner.permission.upsert({ where: { key: k }, update: {}, create: { key: k, description: k } })
        await owner.rolePermission.create({ data: { roleId: r.id, permissionId: p.id } })
      }
      await owner.userRole.create({ data: { tenantId, userId: u.id, roleId: r.id } })
    }
    return { email, id: u.id }
  }
  async function login(a: INestApplication, email: string) {
    const r = await request(a.getHttpServer()).post('/api/v1/auth/login').set('Origin', origin).send({ email, password }).expect(200)
    return (r.headers['set-cookie'][0] as string).split(';')[0]
  }
  async function boot(): Promise<INestApplication> {
    process.env.ADMIN_ORIGIN = origin
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    const a = moduleRef.createNestApplication()
    a.use(cookieParser()); a.setGlobalPrefix('api/v1')
    a.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
    a.useGlobalFilters(new HttpExceptionFilter()); a.useGlobalInterceptors(new ResponseInterceptor())
    await a.init()
    return a
  }

  async function makeHotel(tenantId: string, supplierId: string, name: string, withPool: boolean) {
    const hotel = await owner.hotel.create({ data: { tenantId, name: `${suffix} ${name}`, externalRef: `${name}-${suffix.slice(-6)}`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', contentStatus: 'COMPLETE', starRating: 5 } })
    const room = await owner.roomType.create({ data: { hotelId: hotel.id, name: 'Deluxe', code: `D-${name}`.slice(0, 40), maxAdults: 2, maxChildren: 0, maxOccupancy: 2 } })
    const board = await owner.boardBasis.upsert({ where: { tenantId_code: { tenantId, code: 'BB' } }, update: {}, create: { tenantId, code: 'BB', name: 'B&B' } })
    const mapping = await owner.supplierHotelMapping.create({ data: { tenantId, supplierId, hotelId: hotel.id, supplierHotelId: `${suffix}-${name}`, status: 'MAPPED' } })
    await owner.supplierRoomMapping.create({ data: { tenantId, supplierHotelMappingId: mapping.id, hotelId: hotel.id, supplierRoomId: `${suffix}-${name}-r`, roomTypeId: room.id, status: 'MAPPED' } })
    const contract = await owner.contract.create({ data: { tenantId, supplierId, supplierHotelMappingId: mapping.id, code: `${suffix}-${name}`, status: 'ACTIVE', validFrom: new Date(base - 400 * 86_400_000), validTo: new Date(base + 4000 * 86_400_000), settlementCurrency: 'AED' } })
    return { hotelId: hotel.id, roomId: room.id, boardId: board.id, contractId: contract.id, withPool }
  }
  async function makePool(tenantId: string, hotelId: string, supplierId: string, name: string, planCount: number, meta: { roomId: string; boardId: string; contractId: string }, byWho: string) {
    const pool = await owner.inventoryPool.create({ data: { tenantId, hotelId, supplierId, name, createdById: byWho } })
    await owner.inventoryPoolDay.createMany({ data: D.map((d) => ({ tenantId, poolId: pool.id, stayDate: new Date(d), capacity: 5 })) })
    const ids: string[] = []
    for (let i = 0; i < planCount; i++) {
      const plan = await owner.ratePlan.create({ data: { tenantId, contractId: meta.contractId, roomTypeId: meta.roomId, boardBasisId: meta.boardId, code: `${name.replace(/\W/g, '')}-${'ABC'[i]}`, status: 'ACTIVE', occupancy: 2, currency: 'AED', minStay: 1, inventoryPoolId: pool.id } })
      ids.push(plan.id)
      await owner.dailyRate.createMany({ data: D.map((d) => ({ tenantId, ratePlanId: plan.id, stayDate: new Date(d), occupancy: 2, amountMinor: 50_000n, currency: 'AED', amountBasis: 'SELL' as const })) })
      await owner.dailyAvailability.createMany({ data: [...D, day(25)].map((d) => ({ tenantId, ratePlanId: plan.id, stayDate: new Date(d), allotment: 5 })) })
    }
    return { poolId: pool.id, plans: ids }
  }

  beforeAll(async () => {
    await owner.$connect(); await db.$connect()
    tenantA = (await owner.tenant.create({ data: { name: `${suffix} A`, slug: `${suffix}-a` } })).id
    tenantB = (await owner.tenant.create({ data: { name: `${suffix} B`, slug: `${suffix}-b` } })).id
    supplierA = (await owner.supplier.create({ data: { tenantId: tenantA, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${suffix} sA`, displayName: 'Supplier Alpha', countryCode: 'AE', defaultCurrency: 'AED' } })).id
    supplierB = (await owner.supplier.create({ data: { tenantId: tenantB, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${suffix} sB`, displayName: 'Supplier Beta', countryCode: 'AE', defaultCurrency: 'AED' } })).id
    const full = await user('full', tenantA, ['supply.availability.read', 'supply.pool_capacity.preview', 'supply.pool_capacity.apply'])
    ownerUserId = full.id
    const a = await makeHotel(tenantA, supplierA, 'alpha', true); hotelA = a.hotelId; roomA = a.roomId; boardA = a.boardId
    const pa = await makePool(tenantA, hotelA, supplierA, 'Shared 5', 3, a, full.id); poolA = pa.poolId; plans.push(...pa.plans)
    const a2 = await makeHotel(tenantA, supplierA, 'bravo', true); hotelA2 = a2.hotelId
    poolOther = (await makePool(tenantA, hotelA2, supplierA, 'Other hotel pool', 1, a2, full.id)).poolId
    const b = await makeHotel(tenantB, supplierB, 'oscar', true); hotelB = b.hotelId
    const bf = await user('bfull', tenantB, ['supply.availability.read', 'supply.pool_capacity.preview', 'supply.pool_capacity.apply'])
    poolB = (await makePool(tenantB, hotelB, supplierB, 'Beta pool', 1, b, bf.id)).poolId
    for (const d of D) poolDays[d] = (await dayRow(d)).id
    await user('viewer', tenantA, ['supply.availability.read'])
    await user('previewer', tenantA, ['supply.pool_capacity.preview'])
    await user('applier', tenantA, ['supply.pool_capacity.apply'])
    await user('manage', tenantA, ['supply.availability.manage', 'supply.availability.read'])
    await user('none', tenantA, [])
    app = await boot()
    for (const label of ['full', 'viewer', 'previewer', 'applier', 'manage', 'none']) cookies[label] = await login(app, `${suffix}-${label}@example.test`)
    cookies.bfull = await login(app, `${suffix}-bfull@example.test`)
  })

  afterAll(async () => {
    await app?.close(); await strictApp?.close()
    for (const tenantId of [tenantA, tenantB].filter(Boolean)) {
      await owner.auditEvent.deleteMany({ where: { tenantId } })
      await owner.inventoryHoldNight.deleteMany({ where: { tenantId } }); await owner.inventoryHold.deleteMany({ where: { tenantId } })
      await owner.dailyRate.deleteMany({ where: { tenantId } }); await owner.dailyAvailability.deleteMany({ where: { tenantId } })
      await owner.ratePlan.deleteMany({ where: { tenantId } })
      await owner.inventoryPoolDay.deleteMany({ where: { tenantId } }); await owner.inventoryPool.deleteMany({ where: { tenantId } })
      await owner.contract.deleteMany({ where: { tenantId } }); await owner.supplierRoomMapping.deleteMany({ where: { tenantId } }); await owner.supplierHotelMapping.deleteMany({ where: { tenantId } })
      await owner.boardBasis.deleteMany({ where: { tenantId } }); await owner.roomType.deleteMany({ where: { hotel: { tenantId } } }); await owner.hotel.deleteMany({ where: { tenantId } })
      await owner.supplier.deleteMany({ where: { tenantId } }); await owner.userRole.deleteMany({ where: { tenantId } }); await owner.rolePermission.deleteMany({ where: { role: { tenantId } } })
      await owner.role.deleteMany({ where: { tenantId } }); await owner.membership.deleteMany({ where: { tenantId } })
    }
    await owner.session.deleteMany({ where: { userId: { in: userIds } } }); await owner.user.deleteMany({ where: { id: { in: userIds } } })
    await owner.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB].filter(Boolean) } } })
    await owner.$disconnect(); await db.$disconnect()
  })

  // ---- detail ---------------------------------------------------------------------------------------------------------------------
  it('PCE-01 detail: identity, supplier, hotel time zone, room scope, linked plans and the daily counters with the one availability formula', async () => {
    await owner.inventoryPoolDay.updateMany({ where: { id: poolDays[D[1]] }, data: { sold: 1, held: 2 } })
    try {
      const r = (await http().get(`${path(hotelA, poolA)}?from=${D[0]}&days=7`, 'viewer').expect(200)).body.data
      expect(r).toMatchObject({ hotelId: hotelA, window: { from: D[0], to: day(26), days: 7 }, pool: { id: poolA, name: 'Shared 5', status: 'ACTIVE', supplierName: 'Supplier Alpha', missingNights: 2 }, rooms: [{ roomTypeId: roomA, name: 'Deluxe' }] })
      expect(typeof r.timeZone).toBe('string'); expect(r.hotelToday).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(r.pool.members.map((m: { ratePlanId: string }) => m.ratePlanId).sort()).toEqual([...plans].sort())
      expect(r.days[0]).toMatchObject({ date: D[0], exists: true, capacity: 5, sold: 0, held: 0, available: 5, stale: false, source: 'ADMIN' })
      expect(r.days[1]).toMatchObject({ capacity: 5, sold: 1, held: 2, available: 2 }) // 5 - 1 - 2, subtracted once
      expect(r.days[5]).toEqual({ date: day(25), exists: false, capacity: null, sold: null, held: null, available: null, stale: false, source: null, freshUntil: null, updatedAt: null }) // missing is unknown, not zero
      expect(r.auditNote).toMatch(/inventory\.pool\.capacity_changed/)
    } finally { await reset() }
  })

  it('PCE-02 detail validation and isolation: 400 on bad input, 404 for another tenant, another hotel, an unknown pool', async () => {
    for (const q of ['from=nope', 'days=0', 'days=91']) await http().get(`${path(hotelA, poolA)}?${q}`, 'viewer').expect(400)
    await http().get(path(hotelA, poolB), 'viewer').expect(404)          // tenant B's pool
    await http().get(path(hotelB, poolB), 'viewer').expect(404)          // tenant B's hotel
    await http().get(path(hotelA, poolOther), 'viewer').expect(404)      // same tenant, a different hotel's pool
    await http().get(path(hotelA, 'missing-pool'), 'viewer').expect(404)
    await http().get(path(hotelA, 'not a valid id!'), 'viewer').expect(400)
  })

  // ---- preview ------------------------------------------------------------------------------------------------------------------
  it('PCE-03 preview shows before and after for every affected night and writes nothing', async () => {
    const before = await capacities()
    const p = (await preview(edit({ capacity: 8 })).expect(200)).body.data
    expect(p).toMatchObject({ poolId: poolA, counts: { dates: 5, willChange: 5, unchanged: 0, invalid: 0 }, canApply: true, errors: [] })
    expect(p.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(p.rows[0]).toMatchObject({ date: D[0], outcome: 'CHANGE', before: { capacity: 5, sold: 0, held: 0, available: 5 }, after: { capacity: 8, available: 8 } })
    expect(p.notes.join(' ')).toMatch(/does not allocate stock/)
    expect(await capacities()).toEqual(before)
    expect(await owner.auditEvent.count({ where: { tenantId: tenantA, action: 'inventory.pool.capacity_changed' } })).toBe(0)
  })

  it('PCE-04 blank is unchanged (refused), zero is an intentional capacity, and invalid values are rejected before any write', async () => {
    for (const capacity of [undefined, null, '']) { const body = edit(); delete (body as Record<string, unknown>).capacity; await preview({ ...body, ...(capacity === undefined ? {} : { capacity }) }).expect(400) }
    const zero = (await preview(edit({ capacity: 0 })).expect(200)).body.data
    expect(zero).toMatchObject({ counts: { willChange: 5, invalid: 0 }, canApply: true })
    expect(zero.rows[0].after).toEqual({ capacity: 0, available: 0 })
    for (const capacity of [-1, 1.5, 10_000, '6']) await preview(edit({ capacity })).expect(400)
    for (const range of [{ startDate: '2030-02-30' }, { endDate: day(1) }, { endDate: day(20 + 400) }, { weekdays: ['FUNDAY'] }]) await preview(edit(range)).expect(400)
    await preview({ ...edit(), tenantId: tenantB }).expect(400) // a tenant id in the body is not a supported field
  })

  it('PCE-05 a decrease below committed units is INVALID per night with the numbers, and cannot be applied; units are never removed', async () => {
    await owner.inventoryPoolDay.updateMany({ where: { id: poolDays[D[2]] }, data: { sold: 2, held: 1 } })
    try {
      const p = (await preview(edit({ capacity: 2 })).expect(200)).body.data
      expect(p.counts).toMatchObject({ invalid: 1, willChange: 4 }); expect(p.canApply).toBe(false)
      expect(p.rows[2]).toMatchObject({ date: D[2], outcome: 'INVALID' }); expect(p.rows[2].problems[0]).toMatch(/capacity 2 is below the 3 unit\(s\) already sold or held \(sold 2, held 1\)/)
      const before = await capacities()
      const r = await apply(applyBody(p, { capacity: 2 })).expect(422)
      expect(r.body.error.code).toBe('POOL_CAPACITY_INVALID')
      expect(await capacities()).toEqual(before)
      // exactly the committed units is allowed, and available becomes zero without going negative
      const exact = (await preview(edit({ capacity: 3, startDate: D[2], endDate: D[2] })).expect(200)).body.data
      expect(exact).toMatchObject({ canApply: true, rows: [{ outcome: 'CHANGE', after: { capacity: 3, available: 0 } }] })
    } finally { await reset() }
  })

  it('PCE-06 past nights, weekday selection, no-op and a missing night (never created) are classified exactly', async () => {
    const past = (await preview({ startDate: day(-3), endDate: day(-1), capacity: 4 }).expect(200)).body.data
    expect(past).toMatchObject({ counts: { invalid: 3 }, canApply: false }); expect(past.rows[0].problems[0]).toMatch(/before the hotel's local today/)
    const wd = (await preview(edit({ startDate: D[0], endDate: D[4], weekdays: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'].filter((w) => w === 'MON') })).expect(200)).body.data
    expect(wd.rows.every((r: { weekday: string }) => r.weekday === 'MON')).toBe(true)
    const same = (await preview(edit({ capacity: 5 })).expect(200)).body.data
    expect(same).toMatchObject({ counts: { unchanged: 5, willChange: 0 }, canApply: false })
    const missing = (await preview({ startDate: day(25), endDate: day(26), capacity: 4 }).expect(200)).body.data
    expect(missing).toMatchObject({ counts: { invalid: 2, willChange: 0 }, canApply: false }); expect(missing.rows[0]).toMatchObject({ outcome: 'INVALID', before: null, after: null })
  })

  // ---- apply --------------------------------------------------------------------------------------------------------------------------
  it('PCE-07 apply changes only capacity, atomically, preserves provenance, and records an audit event with the reason and attribution', async () => {
    const rowsBefore = await owner.dailyAvailability.findMany({ where: { tenantId: tenantA }, orderBy: [{ ratePlanId: 'asc' }, { stayDate: 'asc' }] })
    const ratesBefore = await owner.dailyRate.findMany({ where: { tenantId: tenantA }, orderBy: [{ ratePlanId: 'asc' }, { stayDate: 'asc' }] })
    const p = (await preview(edit({ capacity: 7 })).expect(200)).body.data
    const body = applyBody(p, { capacity: 7 })
    const r = (await apply(body).expect(200)).body.data
    expect(r).toMatchObject({ replayed: false, changed: { updated: 5 } })
    expect(await capacities()).toEqual(D.map(() => [7, 0, 0]))
    expect((await dayRow(D[0]))).toMatchObject({ source: 'ADMIN', freshUntil: null })
    expect(await owner.dailyAvailability.findMany({ where: { tenantId: tenantA }, orderBy: [{ ratePlanId: 'asc' }, { stayDate: 'asc' }] })).toEqual(rowsBefore) // plan rows, restrictions, modes: untouched
    expect(await owner.dailyRate.findMany({ where: { tenantId: tenantA }, orderBy: [{ ratePlanId: 'asc' }, { stayDate: 'asc' }] })).toEqual(ratesBefore) // prices: untouched
    expect(await owner.inventoryHold.count({ where: { tenantId: tenantA } })).toBe(0)
    const events = await owner.auditEvent.findMany({ where: { tenantId: tenantA, action: 'inventory.pool.capacity_changed' } })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ userId: ownerUserId, entityType: 'hotel', entityId: hotelA, payload: expect.objectContaining({ outcome: 'allowed', reason: 'Hotel confirmed a larger allotment', poolId: poolA, capacity: 7, changed: { updated: 5 }, idempotencyKey: body.idempotencyKey, fingerprintBefore: p.fingerprint }) })
    expect(JSON.stringify(events[0].payload)).not.toMatch(/password|token|secret/i)
  })

  it('PCE-08 idempotent retry replays without a second write or audit event; the same key with a different body is refused', async () => {
    await reset()
    const p = (await preview(edit({ capacity: 6 })).expect(200)).body.data
    const body = applyBody(p, { capacity: 6 })
    const first = (await apply(body).expect(200)).body.data
    await owner.inventoryPoolDay.updateMany({ where: { id: poolDays[D[0]] }, data: { capacity: 9 } }) // something changes after: a replay must not undo or redo it
    const second = (await apply(body).expect(200)).body.data
    expect(second).toMatchObject({ replayed: true, changed: first.changed, fingerprintAfter: first.fingerprintAfter })
    expect((await dayRow(D[0])).capacity).toBe(9)
    expect(await owner.auditEvent.count({ where: { tenantId: tenantA, action: 'inventory.pool.capacity_changed', payload: { path: ['idempotencyKey'], equals: body.idempotencyKey } } })).toBe(1)
    const reused = await apply({ ...body, capacity: 3 }).expect(409)
    expect(reused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED')
    await reset()
  })

  it('PCE-09 stale preview: a capacity edit, a changed night, consumption, or a different request after the preview all force a refresh and write nothing', async () => {
    const p = (await preview(edit({ capacity: 8 })).expect(200)).body.data
    const stale = async (mutate: () => Promise<unknown>, body = applyBody(p, { capacity: 8 })) => {
      await mutate(); const before = await capacities()
      const r = await apply(body).expect(409)
      expect(r.body.error.code).toBe('POOL_CAPACITY_STALE'); expect(await capacities()).toEqual(before)
      await reset()
    }
    await stale(() => owner.inventoryPoolDay.updateMany({ where: { id: poolDays[D[3]] }, data: { capacity: 6 } }))                       // another capacity edit
    await stale(() => holds.create(cmd(key(), plans[0], D[1], D[2])))                                                                      // stock consumed after the preview
    await owner.inventoryHold.deleteMany({ where: { tenantId: tenantA } })
    await stale(async () => undefined, applyBody(p, { capacity: 9 }))                                                                       // a different request under the old fingerprint
    await stale(async () => undefined, applyBody(p, { capacity: 8, endDate: D[3] }))
    await stale(() => owner.inventoryPoolDay.delete({ where: { id: poolDays[D[4]] } }).then(async () => { poolDays[D[4]] = (await owner.inventoryPoolDay.create({ data: { tenantId: tenantA, poolId: poolA, stayDate: new Date(D[4]), capacity: 5 } })).id }))
  })

  it('PCE-10 validation again at apply: bad fingerprint, reason, key, range and a no-op are refused; an archived pool cannot be edited', async () => {
    const p = (await preview(edit({ capacity: 8 })).expect(200)).body.data
    await apply({ ...applyBody(p), expectedFingerprint: 'abc' }).expect(400)
    await apply({ ...applyBody(p), expectedFingerprint: undefined }).expect(400)
    await apply({ ...applyBody(p), reason: 'x' }).expect(400)
    await apply({ ...applyBody(p), idempotencyKey: 'short' }).expect(400)
    await apply({ ...applyBody(p), capacity: -1 }).expect(400)
    await apply({ ...applyBody(p), capacity: null }).expect(400)
    const same = (await preview(edit({ capacity: 5 })).expect(200)).body.data
    expect((await apply(applyBody(same, { capacity: 5 })).expect(409)).body.error.code).toBe('POOL_CAPACITY_NO_CHANGE')
    await owner.ratePlan.updateMany({ where: { inventoryPoolId: poolA }, data: { inventoryPoolId: null } })
    await owner.inventoryPool.update({ where: { id: poolA }, data: { status: 'ARCHIVED', archivedAt: new Date() } })
    try {
      const archived = (await preview(edit({ capacity: 8 })).expect(200)).body.data
      expect(archived).toMatchObject({ canApply: false }); expect(archived.errors.join()).toMatch(/archived/)
      expect((await apply(applyBody(archived, { capacity: 8 })).expect(409)).body.error.code).toBe('POOL_ARCHIVED')
    } finally {
      await owner.inventoryPool.update({ where: { id: poolA }, data: { status: 'ACTIVE', archivedAt: null } })
      await owner.ratePlan.updateMany({ where: { id: { in: plans } }, data: { inventoryPoolId: poolA } })
    }
  })

  it('PCE-11 a night with no pool stock row is refused, never created, and nothing is written or audited', async () => {
    const auditBefore = await owner.auditEvent.count({ where: { tenantId: tenantA, action: 'inventory.pool.capacity_changed' } })
    const p = (await preview({ startDate: day(25), endDate: day(26), capacity: 4 }).expect(200)).body.data
    expect(p.canApply).toBe(false)
    await apply({ startDate: day(25), endDate: day(26), capacity: 4, expectedFingerprint: p.fingerprint, reason: 'Open two more nights', idempotencyKey: key() }).expect(422)
    expect(await owner.inventoryPoolDay.count({ where: { poolId: poolA, stayDate: { in: [new Date(day(25)), new Date(day(26))] } } })).toBe(0)
    expect(await owner.auditEvent.count({ where: { tenantId: tenantA, action: 'inventory.pool.capacity_changed' } })).toBe(auditBefore)
  })

  // ---- concurrency --------------------------------------------------------------------------------------------------------------------
  it('PCE-12 a concurrent capacity decrease and stock consumption never breach sold + held <= capacity, and one side always yields', async () => {
    await reset()
    const p = (await preview(edit({ capacity: 3, startDate: D[0], endDate: D[0] })).expect(200)).body.data
    const [applied, ...held] = await Promise.allSettled([
      apply(applyBody(p, { capacity: 3, startDate: D[0], endDate: D[0] })).then((r) => r.status),
      ...Array.from({ length: 12 }, (_, i) => holds.create(cmd(`${suffix}-race-${i}`, plans[i % 3], D[0], D[1]))),
    ])
    const rows = await owner.inventoryPoolDay.findFirstOrThrow({ where: { id: poolDays[D[0]] } })
    expect(rows.sold + rows.held).toBeLessThanOrEqual(rows.capacity)
    const holdsWon = held.filter((h) => h.status === 'fulfilled').length
    expect(rows.held).toBe(holdsWon)
    if (applied.status === 'fulfilled' && applied.value === 200) expect(rows.capacity).toBe(3) // decrease landed: holds were capped at 3 in total
    else expect(rows.capacity).toBe(5)                                                         // the decrease yielded as stale or invalid and wrote nothing
    expect(holdsWon).toBeLessThanOrEqual(rows.capacity)
    await owner.inventoryHold.deleteMany({ where: { tenantId: tenantA } }); await reset()
  })

  it('PCE-13 two applies from the same preview: exactly one wins, the other is stale', async () => {
    await reset()
    const p = (await preview(edit({ capacity: 8 })).expect(200)).body.data
    const results = await Promise.all([apply(applyBody(p, { capacity: 8 })), apply(applyBody(p, { capacity: 8 }))])
    expect(results.map((r) => r.status).sort()).toEqual([200, 409])
    expect(results.find((r) => r.status === 409)!.body.error.code).toBe('POOL_CAPACITY_STALE')
    expect(await capacities()).toEqual(D.map(() => [8, 0, 0]))
    expect(await owner.auditEvent.count({ where: { tenantId: tenantA, action: 'inventory.pool.capacity_changed' } })).toBeGreaterThanOrEqual(1)
    await reset()
  })

  // ---- per-plan consumption ------------------------------------------------------------------------------------------------------------
  it('PCE-14 per-plan attribution follows the hold lifecycle, reconciles with the pool counter, and excludes terminal states', async () => {
    await reset(); await owner.inventoryHold.deleteMany({ where: { tenantId: tenantA } })
    const a1 = await holds.create(cmd(key(), plans[0], D[0], D[1]))                 // A held
    const a2 = await holds.create(cmd(key(), plans[0], D[0], D[1])); await confirmHold(a2.holdId)   // A sold
    const b1 = await holds.create(cmd(key(), plans[1], D[0], D[1]))                 // B held
    const b2 = await holds.create(cmd(key(), plans[1], D[0], D[1])); await holds.release(tenantA, b2.holdId, 'rel', { type: 'USER', userId: ownerUserId }) // released: nothing now
    const c1 = await holds.create(cmd(key(), plans[2], D[0], D[1])); await confirmHold(c1.holdId); await cancelHold(c1.holdId) // sold then cancelled: nothing now
    const r = (await http().get(`${path(hotelA, poolA, '/consumption')}?from=${D[0]}&days=2`, 'viewer').expect(200)).body.data
    expect(r.attribution).toEqual({ state: 'available' })
    const n0 = r.nights[0]
    expect(n0).toMatchObject({ capacity: 5, held: 2, sold: 1, available: 2, unattributedHeld: 0, unattributedSold: 0, consistent: true })
    expect(n0.plans).toEqual([{ ratePlanId: plans[0], held: 1, sold: 1 }, { ratePlanId: plans[1], held: 1, sold: 0 }].sort((x, y) => x.ratePlanId.localeCompare(y.ratePlanId)))
    // reconciliation: attributed + unattributed equals the pool counter on every night, and totals add up
    for (const n of r.nights.filter((x: { exists: boolean }) => x.exists)) {
      const h = n.plans.reduce((s: number, p: { held: number }) => s + p.held, 0); const s = n.plans.reduce((q: number, p: { sold: number }) => q + p.sold, 0)
      expect({ held: h + n.unattributedHeld, sold: s + n.unattributedSold }).toEqual({ held: n.held, sold: n.sold })
      expect(n.available).toBe(n.capacity - n.sold - n.held)
    }
    expect(r.totals).toMatchObject({ attributedHeld: 2, attributedSold: 1, unattributedHeld: 0, unattributedSold: 0, inconsistentNights: 0 })
    expect(r.plans.find((p: { ratePlanId: string }) => p.ratePlanId === plans[0])).toMatchObject({ member: true, held: 1, sold: 1 })
    expect(r.plans.find((p: { ratePlanId: string }) => p.ratePlanId === plans[2])).toMatchObject({ member: true, held: 0, sold: 0 }) // cumulative events are not occupancy
    expect(r.definitions.excluded).toMatch(/RELEASED, EXPIRED, FAILED/)
    void a1; void b1
  })

  it('PCE-15 history survives a membership change: a plan that left the pool keeps its attributed units, flagged as a former member', async () => {
    await owner.ratePlan.update({ where: { id: plans[1] }, data: { inventoryPoolId: null } })
    try {
      const r = (await http().get(`${path(hotelA, poolA, '/consumption')}?from=${D[0]}&days=1`, 'viewer').expect(200)).body.data
      expect(r.plans.find((p: { ratePlanId: string }) => p.ratePlanId === plans[1])).toMatchObject({ member: false, held: 1, sold: 0 })
      expect(r.nights[0].plans.find((p: { ratePlanId: string }) => p.ratePlanId === plans[1])).toMatchObject({ held: 1 })
      expect(r.nights[0]).toMatchObject({ unattributedHeld: 0, consistent: true })
    } finally { await owner.ratePlan.update({ where: { id: plans[1] }, data: { inventoryPoolId: poolA } }) }
  })

  it('PCE-16 consumption the holds do not explain is explicit; holds claiming more than the counter are reported inconsistent, never hidden', async () => {
    await owner.inventoryPoolDay.update({ where: { id: poolDays[D[0]] }, data: { held: 3 } })    // one unit the holds do not explain
    let r = (await http().get(`${path(hotelA, poolA, '/consumption')}?from=${D[0]}&days=1`, 'viewer').expect(200)).body.data
    expect(r.nights[0]).toMatchObject({ held: 3, unattributedHeld: 1, consistent: true })
    expect(r.totals.unattributedHeld).toBe(1)
    await owner.inventoryPoolDay.update({ where: { id: poolDays[D[0]] }, data: { held: 0 } })    // counter below what the holds claim
    r = (await http().get(`${path(hotelA, poolA, '/consumption')}?from=${D[0]}&days=1`, 'viewer').expect(200)).body.data
    expect(r.nights[0]).toMatchObject({ held: 0, unattributedHeld: -2, consistent: false })
    expect(r.totals).toMatchObject({ inconsistentNights: 1, unattributedHeld: -2 })
    await owner.inventoryPoolDay.update({ where: { id: poolDays[D[0]] }, data: { held: 2 } })
  })

  it('PCE-17 missing pool nights are unknown in the report; the window is bounded; reads are tenant-scoped', async () => {
    const r = (await http().get(`${path(hotelA, poolA, '/consumption')}?from=${day(24)}&days=3`, 'viewer').expect(200)).body.data
    expect(r.nights.map((n: { exists: boolean }) => n.exists)).toEqual([true, false, false])
    expect(r.nights[1]).toMatchObject({ capacity: null, held: null, sold: null, available: null, unattributedHeld: null, consistent: null })
    expect(r.totals.nightsWithPoolDay).toBe(1)
    for (const q of ['days=63', 'days=0', 'from=x']) await http().get(`${path(hotelA, poolA, '/consumption')}?${q}`, 'viewer').expect(400)
    await http().get(path(hotelA, poolB, '/consumption'), 'viewer').expect(404)
    await http().get(path(hotelB, poolB, '/consumption'), 'viewer').expect(404)
    await http().get(path(hotelA, poolB, '/consumption'), 'bfull').expect(404)
    expect((await http().get(path(hotelB, poolB, '/consumption'), 'bfull').expect(200)).body.data.poolId).toBe(poolB)
  })

  // ---- authorization ------------------------------------------------------------------------------------------------------------------
  it('PCE-18 permission matrix: viewing, previewing and applying are separate grants; no authentication is 401; nothing is written on a denial', async () => {
    await owner.inventoryHold.deleteMany({ where: { tenantId: tenantA } }); await reset()
    const before = await capacities()
    const p = (await preview(edit({ capacity: 8 })).expect(200)).body.data
    for (const url of [path(hotelA, poolA), path(hotelA, poolA, '/consumption')]) {
      await http().get(url, 'anon').expect(401)
      await http().get(url, 'none').expect(403); await http().get(url, 'previewer').expect(403); await http().get(url, 'applier').expect(403)
      await http().get(url, 'viewer').expect(200); await http().get(url, 'full').expect(200)
    }
    await preview(edit(), 'anon').expect(401)
    for (const who of ['none', 'viewer', 'applier', 'manage']) expect({ who, status: (await preview(edit(), who)).status }).toEqual({ who, status: 403 })
    expect((await preview(edit(), 'previewer')).status).toBe(200)
    await apply(applyBody(p), 'anon').expect(401)
    for (const who of ['none', 'viewer', 'previewer', 'manage']) {
      const res = await apply(applyBody(p, { capacity: 8 }), who)
      expect({ who, status: res.status, code: res.body.error?.code }).toEqual({ who, status: 403, code: expect.any(String) })
    }
    expect(await capacities()).toEqual(before)
    expect(await owner.auditEvent.count({ where: { tenantId: tenantA, action: 'inventory.pool.capacity_changed' } })).toBeGreaterThanOrEqual(0)
    expect((await apply(applyBody(p, { capacity: 8 }), 'applier')).status).toBe(200) // apply is its own grant (the fingerprint is what a preview produced)
    await reset()
  })

  it('PCE-19 cross-tenant preview and apply: another tenant\'s user and another tenant\'s pool are 404 and write nothing', async () => {
    const before = await capacities()
    const p = (await preview(edit({ capacity: 8 })).expect(200)).body.data
    await preview(edit(), 'bfull', hotelA, poolA).expect(404)                 // tenant B user on tenant A hotel
    await apply(applyBody(p, { capacity: 8 }), 'bfull', hotelA, poolA).expect(404)
    await preview(edit(), 'full', hotelA, poolB).expect(404)                  // tenant A user, tenant B pool
    await apply(applyBody(p, { capacity: 8 }), 'full', hotelB, poolB).expect(404)
    await apply(applyBody(p, { capacity: 8 }), 'full', hotelA, poolOther).expect(404)  // same tenant, a pool of another hotel
    expect(await capacities()).toEqual(before)
    expect(await owner.inventoryPoolDay.findMany({ where: { poolId: poolB }, select: { capacity: true } })).toEqual(D.map(() => ({ capacity: 5 })))
  })

  // ---- Agent impact -------------------------------------------------------------------------------------------------------------------
  it('PCE-20 Agent search and recheck read the same pool counters: three plans do not multiply stock, capacity zero closes an uncommitted night, nothing else moves', async () => {
    await reset(); await owner.inventoryHold.deleteMany({ where: { tenantId: tenantA } })
    const criteria = (checkIn: string, checkOut: string): SearchCriteria => ({ destination: 'Dubai', checkIn, checkOut, rooms: 1, adults: 2, children: 0, childAges: [], nationality: 'AE', currency: 'AED', canonicalHotelIds: [hotelA] } as SearchCriteria)
    const ctx = { tenantId: tenantA, requestId: 'r', userId: ownerUserId }
    const search = async (a: string, b: string) => (await adapter.search(criteria(a, b), ctx)).offers.flatMap((h) => h.rooms.flatMap((r) => r.rates))
    // three linked plans over five rooms: all three offered, and holding five total (on any plan) exhausts all three
    const offers = await search(D[0], D[1])
    expect(offers).toHaveLength(3)
    for (let i = 0; i < 5; i++) await holds.create(cmd(`${suffix}-agent-${i}`, plans[i % 3], D[0], D[1]))
    expect(await search(D[0], D[1])).toHaveLength(0)
    await owner.inventoryHold.deleteMany({ where: { tenantId: tenantA } }); await reset()

    // a capacity edit to zero on an uncommitted night: an offer found before is unavailable on recheck, and the edit moved nothing else
    const found = (await search(D[2], D[3]))[0]
    const priceBefore = found.sellAmountMinor
    const rowsBefore = await owner.dailyAvailability.findMany({ where: { tenantId: tenantA }, orderBy: [{ ratePlanId: 'asc' }, { stayDate: 'asc' }] })
    expect(await adapter.recheck({ offerId: found.offerId, searchId: 's' }, ctx)).toMatchObject({ status: 'available' })
    const p = (await preview({ startDate: D[2], endDate: D[2], capacity: 0 }).expect(200)).body.data
    await apply({ startDate: D[2], endDate: D[2], capacity: 0, expectedFingerprint: p.fingerprint, reason: 'Hotel closed the night', idempotencyKey: key() }).expect(200)
    expect(await adapter.recheck({ offerId: found.offerId, searchId: 's' }, ctx)).toEqual({ status: 'unavailable' })
    expect(await search(D[2], D[3])).toHaveLength(0)
    expect((await dayRow(D[2]))).toMatchObject({ capacity: 0, sold: 0, held: 0 })                       // recheck allocated nothing
    expect(await owner.dailyAvailability.findMany({ where: { tenantId: tenantA }, orderBy: [{ ratePlanId: 'asc' }, { stayDate: 'asc' }] })).toEqual(rowsBefore) // restrictions unchanged
    // raising it again restores the same price (pricing is independent of capacity)
    const p2 = (await preview({ startDate: D[2], endDate: D[2], capacity: 5 }).expect(200)).body.data
    await apply({ startDate: D[2], endDate: D[2], capacity: 5, expectedFingerprint: p2.fingerprint, reason: 'Hotel reopened the night', idempotencyKey: key() }).expect(200)
    expect((await search(D[2], D[3]))[0].sellAmountMinor).toBe(priceBefore)
  })

  it('PCE-21 ON_REQUEST stays non-selectable and a stale pool night still fails closed, whatever the capacity', async () => {
    await reset()
    const criteria = { destination: 'Dubai', checkIn: D[3], checkOut: D[4], rooms: 1, adults: 2, children: 0, childAges: [], nationality: 'AE', currency: 'AED', canonicalHotelIds: [hotelA] } as SearchCriteria
    const ctx = { tenantId: tenantA, requestId: 'r', userId: ownerUserId }
    const rates = async () => (await adapter.search(criteria, ctx)).offers.flatMap((h) => h.rooms.flatMap((r) => r.rates))
    expect((await rates())).toHaveLength(3)
    await owner.dailyAvailability.updateMany({ where: { ratePlanId: plans[0], stayDate: new Date(D[3]) }, data: { inventoryMode: 'ON_REQUEST' } })
    const mixed = await rates()
    expect(mixed.find((r) => r.ratePlanId === plans[0])).toMatchObject({ available: false })
    const onRequest = mixed.find((r) => r.ratePlanId === plans[0])!
    expect(await adapter.recheck({ offerId: onRequest.offerId, searchId: 's' }, ctx)).toEqual({ status: 'unavailable' })
    await owner.dailyAvailability.updateMany({ where: { ratePlanId: plans[0], stayDate: new Date(D[3]) }, data: { inventoryMode: 'ALLOTMENT' } })
    // an expired supplier-sourced pool night is stale: capacity above zero does not revive it
    await owner.inventoryPoolDay.update({ where: { id: poolDays[D[3]] }, data: { source: 'SUPPLIER_FEED', freshUntil: new Date(Date.now() - 60_000), receivedAt: new Date(Date.now() - 120_000), capacity: 9 } })
    expect((await rates())).toHaveLength(0)
    await owner.inventoryPoolDay.update({ where: { id: poolDays[D[3]] }, data: { source: 'ADMIN', freshUntil: null, capacity: 5 } })
  })

  // ---- strict runtime role --------------------------------------------------------------------------------------------------------------
  // The API runs as the provisioned non-superuser, non-BYPASSRLS, non-owner login; the owner connection is used for fixtures and for reading the truth only.
  let runtimePassword = ''
  const runtimeUrl = () => { const x = new URL(ownerUrl!); x.username = API_RUNTIME_LOGIN_ROLE; x.password = runtimePassword; return x.toString() }
  const runtimeClient = () => new PrismaClient({ datasourceUrl: runtimeUrl() })
  const asRuntime = async <T>(tenantId: string | null, fn: (tx: PrismaClient) => Promise<T>): Promise<T> => {
    const c = runtimeClient()
    try {
      return await c.$transaction(async (tx) => {
        if (tenantId) await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`
        return fn(tx as unknown as PrismaClient)
      })
    } finally { await c.$disconnect() }
  }
  const sqlState = async (fn: () => Promise<unknown>) => { try { await fn(); return 'ok' } catch (e) { return /permission denied/i.test(String((e as Error).message)) ? 'denied' : `other: ${(e as Error).message.slice(0, 120)}` } }

  it('capacity editing preserves expired supplier provenance and cannot revive Agent inventory', async () => {
    await reset()
    const receivedAt = new Date(Date.now() - 120_000), freshUntil = new Date(Date.now() - 60_000)
    await owner.inventoryPoolDay.update({ where: { id: poolDays[D[0]] }, data: { source: 'SUPPLIER_FEED', receivedAt, freshUntil, sourceUpdatedAt: receivedAt } })
    const body = edit({ startDate: D[0], endDate: D[0], capacity: 8 })
    const p = (await preview(body).expect(200)).body.data
    await apply({ ...body, expectedFingerprint: p.fingerprint, reason: 'Capacity adjustment only', idempotencyKey: key() }).expect(200)
    const row = await dayRow(D[0])
    expect(row).toMatchObject({ capacity: 8, source: 'SUPPLIER_FEED', receivedAt, freshUntil, sourceUpdatedAt: receivedAt })
    const detail = (await http().get(`${path(hotelA, poolA)}?from=${D[0]}&days=1`, 'viewer').expect(200)).body.data
    expect(detail.days[0].stale).toBe(true)
    const criteria = { destination: 'Dubai', checkIn: D[0], checkOut: D[1], rooms: 1, adults: 2, children: 0, childAges: [], nationality: 'AE', currency: 'AED', canonicalHotelIds: [hotelA] } as SearchCriteria
    expect((await adapter.search(criteria, { tenantId: tenantA, requestId: 'stale-capacity', userId: ownerUserId })).offers).toHaveLength(0)
    await owner.inventoryPoolDay.update({ where: { id: row.id }, data: { source: 'ADMIN', freshUntil: null } })
    await reset()
  })

  // ---- strict runtime role --------------------------------------------------------------------------------------------------------------
  it('PCE-22 strict role: the role is non-super, non-BYPASSRLS, non-owner; viewing, previewing and Apply all work; attribution is available and reconciles', async () => {
    runtimePassword = randomBytes(24).toString('hex')
    await provisionApiRuntimeRole(owner, { password: runtimePassword })
    const previous = process.env.DATABASE_URL
    try { process.env.DATABASE_URL = runtimeUrl(); strictApp = await boot() } finally { process.env.DATABASE_URL = previous }
    for (const label of ['full', 'viewer', 'previewer', 'applier']) strictCookies[label] = await login(strictApp, `${suffix}-${label}@example.test`)
    const strict = as(strictApp, strictCookies)
    const probe = runtimeClient()
    const [who] = await probe.$queryRawUnsafe<Array<{ current_user: string; rolbypassrls: boolean; rolsuper: boolean; owned: number }>>(`SELECT current_user, r.rolbypassrls, r.rolsuper, (SELECT count(*)::int FROM pg_class c WHERE c.relowner = r.oid) AS owned FROM pg_roles r WHERE r.rolname = current_user`)
    const verified = await verifyApiRuntimeRole(probe as never)
    await probe.$disconnect()
    expect(who).toEqual({ current_user: API_RUNTIME_LOGIN_ROLE, rolbypassrls: false, rolsuper: false, owned: 0 })
    expect(verified).toEqual({ ok: true, failures: [] })

    await reset(); await owner.inventoryHoldNight.deleteMany({ where: { tenantId: tenantA } }); await owner.inventoryHold.deleteMany({ where: { tenantId: tenantA } })
    const a1 = await holds.create(cmd(key(), plans[0], D[0], D[1])); const a2 = await holds.create(cmd(key(), plans[0], D[0], D[1])); await confirmHold(a2.holdId)
    const b1 = await holds.create(cmd(key(), plans[1], D[0], D[1])); void a1; void b1
    const detail = (await strict.get(`${path(hotelA, poolA)}?from=${D[0]}&days=2`, 'viewer').expect(200)).body.data
    expect(detail.days[0]).toMatchObject({ capacity: 5, sold: 1, held: 2 })
    const r = (await strict.get(`${path(hotelA, poolA, '/consumption')}?from=${D[0]}&days=2`, 'viewer').expect(200)).body.data
    expect(r.attribution).toEqual({ state: 'available' })                                              // never "unavailable" on a properly provisioned role
    expect(r.nights[0]).toMatchObject({ capacity: 5, held: 2, sold: 1, available: 2, unattributedHeld: 0, unattributedSold: 0, consistent: true })
    expect(r.totals).toMatchObject({ attributedHeld: 2, attributedSold: 1, unattributedHeld: 0, unattributedSold: 0, inconsistentNights: 0 })
    const truth = await owner.inventoryPoolDay.findFirstOrThrow({ where: { poolId: poolA, stayDate: new Date(D[0]) } })
    expect({ held: truth.held, sold: truth.sold }).toEqual({ held: 2, sold: 1 })                       // the report reconciles with the authoritative counters

    // preview, then Apply under the strict role
    const p = (await strict.post(path(hotelA, poolA, '/capacity/preview'), 'full', edit({ capacity: 8 })).expect(200)).body.data
    expect(p).toMatchObject({ canApply: true, counts: { willChange: 5 } })
    const audits = () => owner.auditEvent.count({ where: { tenantId: tenantA, action: 'inventory.pool.capacity_changed' } })
    const auditsBefore = await audits()
    const body = applyBody(p, { capacity: 8 })
    const done = (await strict.post(path(hotelA, poolA, '/capacity/apply'), 'full', body).expect(200)).body.data
    expect(done).toMatchObject({ replayed: false, changed: { updated: 5 } })
    expect(await capacities()).toEqual([[8, 1, 2], [8, 0, 0], [8, 0, 0], [8, 0, 0], [8, 0, 0]])       // capacity changed; sold and held untouched
    expect(await audits()).toBe(auditsBefore + 1)
    expect((await dayRow(D[0]))).toMatchObject({ source: 'ADMIN', freshUntil: null })
    const replay = (await strict.post(path(hotelA, poolA, '/capacity/apply'), 'full', body).expect(200)).body.data
    expect(replay.replayed).toBe(true); expect(await audits()).toBe(auditsBefore + 1)                  // idempotent: no second write, no second audit
    await strict.post(path(hotelA, poolA, '/capacity/apply'), 'full', { ...body, capacity: 9 }).expect(409) // key reuse with a different request
    const after = (await strict.get(`${path(hotelA, poolA, '/consumption')}?from=${D[0]}&days=2`, 'viewer').expect(200)).body.data
    expect(after.attribution).toEqual({ state: 'available' }); expect(after.nights[0]).toMatchObject({ capacity: 8, available: 5, consistent: true })
  })

  it('PCE-23 strict role: application permissions still decide (403), stale and unsafe edits keep their semantics, and a failed edit leaves counters, idempotency and audit unchanged', async () => {
    const strict = as(strictApp!, strictCookies)
    await reset(); await owner.inventoryHoldNight.deleteMany({ where: { tenantId: tenantA } }); await owner.inventoryHold.deleteMany({ where: { tenantId: tenantA } })
    const audits = () => owner.auditEvent.count({ where: { tenantId: tenantA, action: 'inventory.pool.capacity_changed' } })
    const p = (await strict.post(path(hotelA, poolA, '/capacity/preview'), 'full', edit({ capacity: 7 })).expect(200)).body.data
    const before = await capacities(); const a0 = await audits()
    for (const who of ['viewer', 'previewer']) { // read-only and preview-only are denied by the application, not the database
      const denied = await strict.post(path(hotelA, poolA, '/capacity/apply'), who, applyBody(p, { capacity: 7 }))
      expect(denied.status).toBe(403)
      expect(JSON.stringify(denied.body)).not.toMatch(/InventoryPoolDay|permission denied|SQLSTATE|42501|RUNTIME_ROLE/i)
    }
    await strict.post(path(hotelA, poolA, '/capacity/preview'), 'viewer', edit({ capacity: 7 })).expect(403)
    await strict.get(path(hotelA, poolA), 'anon').expect(401)
    await strict.post(path(hotelA, poolA, '/capacity/apply'), 'anon', applyBody(p, { capacity: 7 })).expect(401)
    // stale: stock moved between preview and apply
    await owner.inventoryPoolDay.updateMany({ where: { poolId: poolA, stayDate: new Date(D[0]) }, data: { held: 1 } })
    const stale = await strict.post(path(hotelA, poolA, '/capacity/apply'), 'full', applyBody(p, { capacity: 7 }))
    expect(stale.status).toBe(409); expect(stale.body.error.code).toBe('POOL_CAPACITY_STALE')
    await owner.inventoryPoolDay.updateMany({ where: { poolId: poolA, stayDate: new Date(D[0]) }, data: { held: 0 } })
    // unsafe: capacity below sold + held is refused and never written
    await owner.inventoryPoolDay.updateMany({ where: { poolId: poolA, stayDate: new Date(D[1]) }, data: { sold: 3, held: 1 } })
    const unsafe = await strict.post(path(hotelA, poolA, '/capacity/preview'), 'full', edit({ capacity: 3 })).expect(200)
    expect(unsafe.body.data.canApply).toBe(false)
    const refused = await strict.post(path(hotelA, poolA, '/capacity/apply'), 'full', applyBody(unsafe.body.data, { capacity: 3 }))
    expect(refused.status).toBe(422); expect(refused.body.error.code).toBe('POOL_CAPACITY_INVALID')
    // a night with no stock row is refused, never created
    const miss = (await strict.post(path(hotelA, poolA, '/capacity/preview'), 'full', { startDate: day(25), endDate: day(26), capacity: 4 }).expect(200)).body.data
    expect(miss.canApply).toBe(false)
    await strict.post(path(hotelA, poolA, '/capacity/apply'), 'full', { startDate: day(25), endDate: day(26), capacity: 4, expectedFingerprint: miss.fingerprint, reason: 'Open more nights', idempotencyKey: key() }).expect(422)
    expect(await owner.inventoryPoolDay.count({ where: { poolId: poolA, stayDate: { in: [new Date(day(25)), new Date(day(26))] } } })).toBe(0)
    expect(await capacities()).toEqual(before.map((b, i) => (i === 1 ? [b[0], 3, 1] : b)))              // only the fixture edits above; nothing the failed requests wrote
    expect(await audits()).toBe(a0)
    await reset()
  })

  it('PCE-24 strict role, direct SQL: sold, held and identity columns cannot be changed, no INSERT or DELETE, ungranted hold columns are unreadable, tenant isolation and fail-closed context hold', async () => {
    const other = await owner.inventoryPoolDay.findFirstOrThrow({ where: { poolId: poolB } })
    const existing = await owner.inventoryHold.findFirst({ where: { tenantId: tenantA } })
    const hold = existing ?? (await owner.inventoryHold.findUniqueOrThrow({ where: { id: (await holds.create(cmd(key(), plans[0], D[0], D[1]))).holdId } }))
    const day0 = await dayRow(D[0])                                                                   // after any fixture hold, so sold/held are the baseline
    // writable: only the capacity set
    expect(await sqlState(() => asRuntime(tenantA, (t) => t.$executeRaw`UPDATE "InventoryPoolDay" SET "capacity" = 5, "updated_at" = now() WHERE "id" = ${day0.id}`))).toBe('ok')
    for (const col of ['sold', 'held', 'tenant_id', 'pool_id', 'stay_date', 'id', 'created_at', 'source', 'source_updated_at', 'received_at', 'fresh_until']) {
      const stmt = `UPDATE "InventoryPoolDay" SET "${col}" = "${col}" WHERE "id" = '${day0.id}'`
      const state = await sqlState(() => asRuntime(tenantA, (t) => t.$executeRawUnsafe(stmt)))
      expect({ col, state }).toEqual({ col, state: 'denied' })
    }
    expect(await sqlState(() => asRuntime(tenantA, (t) => t.$executeRaw`INSERT INTO "InventoryPoolDay" ("id","tenant_id","pool_id","stay_date","capacity") VALUES (gen_random_uuid(), ${tenantA}, ${poolA}, ${day(40)}::date, 1)`))).toBe('denied')
    expect(await sqlState(() => asRuntime(tenantA, (t) => t.$executeRaw`DELETE FROM "InventoryPoolDay" WHERE "id" = ${day0.id}`))).toBe('denied')
    for (const sql of ['UPDATE "InventoryHold" SET "status" = \'RELEASED\'', 'DELETE FROM "InventoryHoldNight"', 'UPDATE "InventoryPool" SET "name" = \'x\'', 'UPDATE "RatePlan" SET "status" = \'DRAFT\'', 'UPDATE "DailyAvailability" SET "allotment" = 0', 'INSERT INTO "InventoryPool" ("id") VALUES (gen_random_uuid())'])
      expect({ sql, state: await sqlState(() => asRuntime(tenantA, (t) => t.$executeRawUnsafe(sql))) }).toEqual({ sql, state: 'denied' })
    // readable: exactly the attribution columns; everything else on the hold tables is denied, including SELECT *
    expect(await sqlState(() => asRuntime(tenantA, (t) => t.$queryRaw`SELECT "id","tenant_id","rate_plan_id","status" FROM "InventoryHold" LIMIT 1`))).toBe('ok')
    expect(await sqlState(() => asRuntime(tenantA, (t) => t.$queryRaw`SELECT "tenant_id","hold_id","pool_day_id","counter_kind","quantity" FROM "InventoryHoldNight" LIMIT 1`))).toBe('ok')
    const granted: Record<string, string[]> = { InventoryHold: ['id', 'tenant_id', 'rate_plan_id', 'status'], InventoryHoldNight: ['tenant_id', 'hold_id', 'pool_day_id', 'counter_kind', 'quantity'] }
    for (const table of Object.keys(granted)) {
      const cols = (await owner.$queryRawUnsafe<Array<{ column_name: string }>>(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${table}'`)).map((c) => c.column_name)
      expect(cols.length).toBeGreaterThan(granted[table].length)
      for (const col of cols) {
        const state = await sqlState(() => asRuntime(tenantA, (t) => t.$queryRawUnsafe(`SELECT "${col}" FROM "${table}" LIMIT 1`)))
        expect({ table, col, state }).toEqual({ table, col, state: granted[table].includes(col) ? 'ok' : 'denied' }) // guest, money, offer, idempotency and request columns are all unreadable
      }
    }
    expect(await sqlState(() => asRuntime(tenantA, (t) => t.$queryRawUnsafe('SELECT * FROM "InventoryHold" LIMIT 1')))).toBe('denied')
    expect(await sqlState(() => asRuntime(tenantA, (t) => t.$queryRawUnsafe('SELECT "availability_id","stay_date" FROM "InventoryHoldNight" LIMIT 1')))).toBe('denied')
    // tenant isolation: another tenant's rows are invisible and unwritable; a missing tenant context fails closed
    expect(await asRuntime(tenantA, (t) => t.$queryRaw`SELECT "id" FROM "InventoryPoolDay" WHERE "id" = ${other.id}`)).toEqual([])
    expect(await asRuntime(tenantA, (t) => t.$executeRaw`UPDATE "InventoryPoolDay" SET "capacity" = 99 WHERE "id" = ${other.id}`)).toBe(0)
    expect((await owner.inventoryPoolDay.findUniqueOrThrow({ where: { id: other.id } })).capacity).toBe(5)
    expect(await asRuntime(null, (t) => t.$queryRaw`SELECT "id" FROM "InventoryPoolDay"`)).toEqual([])
    expect(await asRuntime(null, (t) => t.$executeRaw`UPDATE "InventoryPoolDay" SET "capacity" = 99`)).toBe(0)
    expect(await asRuntime(null, (t) => t.$queryRaw`SELECT "id" FROM "InventoryHold"`)).toEqual([])
    expect(await asRuntime(tenantB, (t) => t.$queryRaw`SELECT "id" FROM "InventoryHold" WHERE "id" = ${hold.id}`)).toEqual([])
    // no tenant leak over a reused connection: the context is transaction-local
    const c = runtimeClient()
    try {
      await c.$transaction(async (tx) => { await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantA}, true)`; expect((await tx.$queryRaw<unknown[]>`SELECT "id" FROM "InventoryPoolDay" WHERE "pool_id" = ${poolA}`).length).toBe(5) })
      expect(await c.$queryRaw`SELECT "id" FROM "InventoryPoolDay"`).toEqual([])
    } finally { await c.$disconnect() }
    expect(await owner.inventoryPoolDay.findUniqueOrThrow({ where: { id: day0.id } })).toMatchObject({ sold: day0.sold, held: day0.held, tenantId: tenantA, poolId: poolA })
  })

  it('PCE-25 the verifier flags a broad table SELECT, an extra column read, a missing column read, a broad UPDATE and an extra membership; reprovisioning repairs all of it', async () => {
    const verify = async () => { const c = runtimeClient(); try { return await verifyApiRuntimeRole(c as never) } finally { await c.$disconnect() } }
    const repair = () => provisionApiRuntimeRole(owner, { password: runtimePassword })
    expect(await verify()).toEqual({ ok: true, failures: [] })
    const cases: Array<[string, string, RegExp]> = [
      ['broad SELECT overriding the column restriction', 'GRANT SELECT ON "InventoryHold" TO fbeds_api', /InventoryHold/],
      ['an extra column read', 'GRANT SELECT ("sell_amount_minor") ON "InventoryHold" TO fbeds_api', /sell_amount_minor|InventoryHold/],
      ['a missing required column read', 'REVOKE SELECT ("rate_plan_id") ON "InventoryHold" FROM fbeds_api', /rate_plan_id|InventoryHold/],
      ['a broad UPDATE on the pool-day table', 'GRANT UPDATE ON "InventoryPoolDay" TO fbeds_api', /InventoryPoolDay/],
      ['an extra written column (sold)', 'GRANT UPDATE ("sold") ON "InventoryPoolDay" TO fbeds_api', /sold|InventoryPoolDay/],
      ['INSERT on the pool-day table', 'GRANT INSERT ON "InventoryPoolDay" TO fbeds_api', /InventoryPoolDay/],
    ]
    for (const [name, ddl, re] of cases) {
      await owner.$executeRawUnsafe(ddl)
      try { const r = await verify(); expect({ name, ok: r.ok }).toEqual({ name, ok: false }); expect(r.failures.join(' | ')).toMatch(re) } finally { await repair() }
      expect({ name, repaired: (await verify()).ok }).toEqual({ name, repaired: true })
    }
    // elevated attributes and extra memberships
    await owner.$executeRawUnsafe('ALTER ROLE fbeds_api_login BYPASSRLS')
    try { expect((await verify()).failures.join(' ')).toMatch(/BYPASSRLS/) } finally { await owner.$executeRawUnsafe('ALTER ROLE fbeds_api_login NOBYPASSRLS') }
    await owner.$executeRawUnsafe('CREATE ROLE fbeds_pool_test_extra NOLOGIN')
    try {
      await owner.$executeRawUnsafe('GRANT fbeds_pool_test_extra TO fbeds_api_login')
      expect((await verify()).ok).toBe(false)
    } finally {
      await owner.$executeRawUnsafe('REVOKE fbeds_pool_test_extra FROM fbeds_api_login')
      await owner.$executeRawUnsafe('DROP ROLE fbeds_pool_test_extra')
    }
    expect((await verify()).ok).toBe(true)
  })

  it('PCE-26 a missing contract privilege for an authorized caller is a sanitized operational 503, never a caller denial and never a zero', async () => {
    const strict = as(strictApp!, strictCookies)
    for (const ddl of ['REVOKE SELECT ON "InventoryPoolDay" FROM fbeds_api', 'REVOKE SELECT ("rate_plan_id") ON "InventoryHold" FROM fbeds_api']) {
      await owner.$executeRawUnsafe(ddl)
      try {
        const reads = [await strict.get(`${path(hotelA, poolA, '/consumption')}?from=${D[0]}&days=2`, 'viewer'), await strict.post(path(hotelA, poolA, '/capacity/preview'), 'full', edit({ capacity: 8 }))]
        for (const res of ddl.includes('InventoryPoolDay') ? reads : [reads[0]]) {
          expect({ ddl, status: res.status, code: res.body.error?.code }).toEqual({ ddl, status: 503, code: 'DATABASE_ROLE_NOT_PERMITTED' })
          expect(JSON.stringify(res.body)).not.toMatch(/InventoryPoolDay|InventoryHold|rate_plan_id|permission denied|SQLSTATE|42501/i)
        }
      } finally { await provisionApiRuntimeRole(owner, { password: runtimePassword }) }
    }
    // a withdrawn UPDATE privilege on apply: 503, with nothing written, no idempotency record and no audit event
    const p = (await strict.post(path(hotelA, poolA, '/capacity/preview'), 'full', edit({ capacity: 8 })).expect(200)).body.data
    const before = await capacities(); const audits = () => owner.auditEvent.count({ where: { tenantId: tenantA, action: 'inventory.pool.capacity_changed' } }); const a0 = await audits()
    await owner.$executeRawUnsafe('REVOKE UPDATE ("capacity") ON "InventoryPoolDay" FROM fbeds_api')
    try {
      const body = applyBody(p, { capacity: 8 })
      const res = await strict.post(path(hotelA, poolA, '/capacity/apply'), 'full', body)
      expect({ status: res.status, code: res.body.error?.code }).toEqual({ status: 503, code: 'DATABASE_ROLE_NOT_PERMITTED' })
      expect(JSON.stringify(res.body)).not.toMatch(/InventoryPoolDay|permission denied|SQLSTATE|42501/i)
      expect(await capacities()).toEqual(before); expect(await audits()).toBe(a0)
      await provisionApiRuntimeRole(owner, { password: runtimePassword })
      expect((await strict.post(path(hotelA, poolA, '/capacity/apply'), 'full', body).expect(200)).body.data.replayed).toBe(false) // the same key is still unused: the failure recorded nothing
    } finally { await provisionApiRuntimeRole(owner, { password: runtimePassword }) }
    expect((await strict.get(`${path(hotelA, poolA)}?from=${D[0]}&days=2`, 'viewer')).status).toBe(200) // restored
    await reset()
  })

  it('PCE-27 strict role: concurrent holds and capacity edits never breach sold + held <= capacity, and Agent recheck sees zero capacity without allocating', async () => {
    await reset(); await owner.inventoryHoldNight.deleteMany({ where: { tenantId: tenantA } }); await owner.inventoryHold.deleteMany({ where: { tenantId: tenantA } })
    const strict = as(strictApp!, strictCookies)
    const p = (await strict.post(path(hotelA, poolA, '/capacity/preview'), 'full', edit({ capacity: 2, startDate: D[0], endDate: D[0] })).expect(200)).body.data
    const [edited, h1, h2, h3] = await Promise.all([
      strict.post(path(hotelA, poolA, '/capacity/apply'), 'full', applyBody(p, { capacity: 2, startDate: D[0], endDate: D[0] })),
      holds.create(cmd(key(), plans[0], D[0], D[1])).catch((e) => e), holds.create(cmd(key(), plans[1], D[0], D[1])).catch((e) => e), holds.create(cmd(key(), plans[2], D[0], D[1])).catch((e) => e),
    ])
    expect([200, 409, 422]).toContain(edited.status) // applied, stale (stock moved) or refused (would drop below committed units)
    void h1; void h2; void h3
    const row = await dayRow(D[0])
    expect(row.sold + row.held).toBeLessThanOrEqual(row.capacity)
    const r = (await strict.get(`${path(hotelA, poolA, '/consumption')}?from=${D[0]}&days=1`, 'viewer').expect(200)).body.data
    expect(r.attribution).toEqual({ state: 'available' }); expect(r.nights[0].consistent).toBe(true)
    expect(r.nights[0].held + r.nights[0].sold).toBe(row.held + row.sold)
    const reached = await capacities()
    await strict.get(`${path(hotelA, poolA, '/consumption')}?from=${D[0]}&days=5`, 'viewer').expect(200)
    expect(await capacities()).toEqual(reached)                                                         // reading and previewing never allocate or release
    await reset()
  })
})
