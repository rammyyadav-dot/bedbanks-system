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
import { API_RUNTIME_LOGIN_ROLE, provisionApiRuntimeRole } from '../src/database/api-runtime-role'
import { authorApprovedNightRequest } from '../src/inventory/pool-night-authoring'

const ownerUrl = process.env.DATABASE_URL
if (!ownerUrl) throw new Error('DATABASE_URL (the disposable owner connection) is required')
jest.setTimeout(240_000)

/** ADR 0036 Amendment 3: Admin requests to open pool nights, on the strict runtime role; the owner tool applies an approved one. */
describe('pool night requests (PostgreSQL, HTTP, strict runtime role)', () => {
  const owner = new PrismaClient({ datasourceUrl: ownerUrl })
  const suffix = `nr-${Date.now()}-${randomBytes(3).toString('hex')}`
  const password = 'pool-night-password'; const origin = 'http://localhost:3001'
  const base = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z').getTime()
  const day = (n: number) => new Date(base + n * 86_400_000).toISOString().slice(0, 10)
  let app: INestApplication; let previousUrl: string | undefined
  let tenantA = '', tenantB = '', hotelA = '', poolA = '', poolB = '', hotelB = ''
  let executor = ''
  const userIds: string[] = []; const cookies: Record<string, string> = {}
  let seq = 0; const key = () => `${suffix}-req-${++seq}-key`
  const path = (tail = '', hotel = hotelA, pool = poolA) => `/api/v1/admin/hotels/${hotel}/inventory/pools/${pool}/night-requests${tail}`
  const call = (method: 'get' | 'post', p: string, who: string, body?: object) => {
    const r = method === 'get' ? request(app.getHttpServer()).get(p) : request(app.getHttpServer()).post(p).set('Origin', origin).send(body ?? {})
    return who === 'anon' ? r : r.set('Cookie', cookies[who])
  }
  const body = (over: Record<string, unknown> = {}) => ({ requestId: key(), startDate: day(40), endDate: day(43), capacity: 7, reason: 'Hotel opened the next block', ...over })
  const nights = (pool = poolA) => owner.inventoryPoolDay.count({ where: { poolId: pool } })
  const audits = (action: string) => owner.auditEvent.count({ where: { tenantId: tenantA, action } })

  async function user(label: string, tenantId: string, keys: string[]) {
    const email = `${suffix}-${label}@example.test`
    const u = await owner.user.create({ data: { email, passwordHash: await hashPassword(password), status: 'ACTIVE' } }); userIds.push(u.id)
    await owner.membership.create({ data: { tenantId, userId: u.id, role: 'agent' } })
    if (keys.length) {
      const r = await owner.role.create({ data: { tenantId, name: `${suffix}-${label}` } })
      for (const k of keys) {
        const p = await owner.permission.upsert({ where: { key: k }, update: {}, create: { key: k, description: k } })
        await owner.rolePermission.create({ data: { roleId: r.id, permissionId: p.id } })
      }
      await owner.userRole.create({ data: { tenantId, userId: u.id, roleId: r.id } })
    }
    return u.id
  }
  async function fixture(tenantId: string, name: string, creator: string) {
    const supplier = await owner.supplier.create({ data: { tenantId, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${suffix} ${name}`, displayName: name, countryCode: 'AE', defaultCurrency: 'AED' } })
    const hotel = await owner.hotel.create({ data: { tenantId, name: `${suffix} ${name}`, externalRef: `${name}-${suffix.slice(-6)}`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', contentStatus: 'COMPLETE', starRating: 5 } })
    const pool = await owner.inventoryPool.create({ data: { tenantId, hotelId: hotel.id, supplierId: supplier.id, name: `${name} pool`, createdById: creator } })
    await owner.inventoryPoolDay.createMany({ data: [20, 21, 22, 23, 24].map((n) => ({ tenantId, poolId: pool.id, stayDate: new Date(day(n)), capacity: 5 })) })
    return { hotelId: hotel.id, poolId: pool.id }
  }

  beforeAll(async () => {
    tenantA = (await owner.tenant.create({ data: { name: `${suffix} A`, slug: `${suffix}-a` } })).id
    tenantB = (await owner.tenant.create({ data: { name: `${suffix} B`, slug: `${suffix}-b` } })).id
    const maker = await user('maker', tenantA, ['supply.availability.read', 'supply.pool_nights.request'])
    await user('checker', tenantA, ['supply.availability.read', 'supply.pool_nights.decide'])
    await user('viewer', tenantA, ['supply.availability.read'])
    await user('none', tenantA, [])
    executor = await user('operator', tenantA, [])
    const bm = await user('bmaker', tenantB, ['supply.availability.read', 'supply.pool_nights.request'])
    const a = await fixture(tenantA, 'alpha', maker); hotelA = a.hotelId; poolA = a.poolId
    const b = await fixture(tenantB, 'oscar', bm); hotelB = b.hotelId; poolB = b.poolId
    const pw = randomBytes(24).toString('hex'); await provisionApiRuntimeRole(owner, { password: pw })
    previousUrl = process.env.DATABASE_URL
    const u = new URL(ownerUrl); u.username = API_RUNTIME_LOGIN_ROLE; u.password = pw
    process.env.DATABASE_URL = u.toString(); process.env.ADMIN_ORIGIN = origin
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication(); app.use(cookieParser()); app.setGlobalPrefix('api/v1')
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
    app.useGlobalFilters(new HttpExceptionFilter()); app.useGlobalInterceptors(new ResponseInterceptor()); await app.init()
    for (const label of ['maker', 'checker', 'viewer', 'none', 'bmaker']) {
      const r = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', origin).send({ email: `${suffix}-${label}@example.test`, password }).expect(200)
      cookies[label] = (r.headers['set-cookie'][0] as string).split(';')[0]
    }
  })
  afterAll(async () => {
    await app?.close(); if (previousUrl) process.env.DATABASE_URL = previousUrl
    for (const t of [tenantA, tenantB].filter(Boolean)) {
      await owner.auditEvent.deleteMany({ where: { tenantId: t } }); await owner.approvalRequest.deleteMany({ where: { tenantId: t } })
      await owner.inventoryPoolDay.deleteMany({ where: { tenantId: t } }); await owner.inventoryPool.deleteMany({ where: { tenantId: t } })
      await owner.hotel.deleteMany({ where: { tenantId: t } }); await owner.supplier.deleteMany({ where: { tenantId: t } })
      await owner.userRole.deleteMany({ where: { tenantId: t } }); await owner.rolePermission.deleteMany({ where: { role: { tenantId: t } } }); await owner.role.deleteMany({ where: { tenantId: t } }); await owner.membership.deleteMany({ where: { tenantId: t } })
    }
    await owner.session.deleteMany({ where: { userId: { in: userIds } } }); await owner.user.deleteMany({ where: { id: { in: userIds } } })
    await owner.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } }); await owner.$disconnect()
  })

  it('NR-01 the API really runs as the strict role; a request is recorded, idempotent, and writes no pool night', async () => {
    const [who] = await owner.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM pg_stat_activity WHERE usename = '${API_RUNTIME_LOGIN_ROLE}' AND datname = current_database()`)
    expect(Number(who.n)).toBeGreaterThan(0)
    const before = await nights(); const b = body()
    const r = (await call('post', path(), 'maker', b).expect(200)).body.data
    expect(r.items[0]).toMatchObject({ status: 'PENDING', startDate: day(40), endDate: day(43), capacity: 7, missingNights: 4, canCancel: true, canDecide: false })
    const again = (await call('post', path(), 'maker', b).expect(200)).body.data
    expect(again.items).toHaveLength(1)                                                                  // same requestId: the same request, not a second
    expect(await nights()).toBe(before)
    expect(await audits('approval.requested')).toBe(1)
  })

  it('NR-02 permissions: viewing needs availability.read, requesting needs its own grant, deciding another; anonymous is 401; another tenant is 404', async () => {
    await call('get', path(), 'viewer').expect(200); await call('get', path(), 'none').expect(403); await call('get', path(), 'anon').expect(401)
    await call('post', path(), 'viewer', body()).expect(403); await call('post', path(), 'checker', body()).expect(403); await call('post', path(), 'anon', body()).expect(401)
    const pending = (await call('get', path(), 'viewer').expect(200)).body.data.items[0]
    await call('post', path(`/${pending.id}/approve`, hotelA, poolA), 'maker', { reason: 'ok' }).expect(403)   // the maker holds no decide grant
    await call('post', path(`/${pending.id}/approve`), 'viewer', { reason: 'ok' }).expect(403)
    await call('get', path('', hotelA, poolA), 'bmaker').expect(404); await call('post', path('', hotelA, poolA), 'bmaker', body()).expect(404)
    await call('get', path('', hotelB, poolA), 'maker').expect(404)                                      // a pool of another hotel in the URL
    expect((await call('get', path('', hotelB, poolB), 'bmaker').expect(200)).body.data.items).toEqual([]) // tenant B sees nothing of tenant A
  })

  it('NR-03 validation: bad capacity, past or reversed range, short key, a range with nothing to open, an archived pool', async () => {
    const bad = async (over: Record<string, unknown>, status: number, code?: string) => { const r = await call('post', path(), 'maker', body(over)); expect({ over, status: r.status }).toEqual({ over, status }); if (code) expect(r.body.error.code).toBe(code) }
    await bad({ capacity: -1 }, 400); await bad({ capacity: 2.5 }, 400); await bad({ capacity: 10_000 }, 400); await bad({ reason: 'x' }, 400); await bad({ requestId: 'short' }, 400)
    await bad({ startDate: day(45), endDate: day(44) }, 400); await bad({ startDate: 'nope' }, 400)
    await bad({ startDate: day(20), endDate: day(24) }, 409, 'POOL_NIGHTS_NOTHING_TO_OPEN')          // every night already has a row
    await bad({ startDate: day(-5), endDate: day(-2) }, 409, 'POOL_NIGHTS_NOTHING_TO_OPEN')           // all in the past
    await owner.inventoryPool.update({ where: { id: poolA }, data: { status: 'ARCHIVED', archivedAt: new Date() } })
    try { await bad({}, 409, 'POOL_ARCHIVED') } finally { await owner.inventoryPool.update({ where: { id: poolA }, data: { status: 'ACTIVE', archivedAt: null } }) }
    expect(await owner.approvalRequest.count({ where: { tenantId: tenantA } })).toBe(1)
  })

  it('NR-04 maker-checker: the maker cannot decide, only the maker can cancel, a decision is final, reject and cancel leave nothing to apply', async () => {
    const mk = async (over = {}) => (await call('post', path(), 'maker', body(over)).expect(200)).body.data.items.find((i: { reason: string; capacity: number }) => i.capacity === ((over as { capacity?: number }).capacity ?? 7) && i.reason !== undefined) as { id: string }
    const r1 = (await call('get', path(), 'viewer').expect(200)).body.data.items[0] as { id: string; canDecide: boolean }
    expect(r1.canDecide).toBe(true)                                                                       // for the checker's view of it
    const asChecker = (await call('get', path(), 'checker').expect(200)).body.data.items[0]
    expect(asChecker.canDecide).toBe(true)
    const approved = (await call('post', path(`/${r1.id}/approve`), 'checker', { reason: 'Confirmed with the hotel' }).expect(200)).body.data.items.find((i: { id: string }) => i.id === r1.id)
    expect(approved).toMatchObject({ status: 'APPROVED', decidedById: expect.any(String) })
    await call('post', path(`/${r1.id}/reject`), 'checker', { reason: 'changed my mind' }).expect(409)    // a decision is final
    await call('post', path(`/${r1.id}/cancel`), 'maker').expect(409)
    const second = await mk({ capacity: 9, startDate: day(50), endDate: day(51) })
    await call('post', path(`/${second.id}/reject`), 'checker', { reason: 'Not agreed' }).expect(200)
    const third = await mk({ capacity: 11, startDate: day(60), endDate: day(61) })
    await call('post', path(`/${third.id}/cancel`), 'checker').expect(403)                                // only the maker may withdraw
    await call('post', path(`/${third.id}/cancel`), 'maker').expect(200)
    const all = (await call('get', path(), 'viewer').expect(200)).body.data.items as Array<{ status: string }>
    expect(all.map((i) => i.status).sort()).toEqual(['APPROVED', 'CANCELLED', 'REJECTED'])
    await call('post', path(`/unknown-id-123/approve`), 'checker', { reason: 'x' }).expect(404)
  })

  it('NR-05 the API never wrote a night; the owner tool previews, then applies the approved request once, atomically', async () => {
    expect(await nights()).toBe(5)
    const approved = await owner.approvalRequest.findFirstOrThrow({ where: { tenantId: tenantA, status: 'APPROVED' } })
    const pending = await owner.approvalRequest.findFirstOrThrow({ where: { tenantId: tenantA, status: 'REJECTED' } })
    await expect(authorApprovedNightRequest(owner, { tenantId: tenantA, approvalId: pending.id, actor: 'ops test', executorUserId: executor }, { apply: true })).rejects.toThrow(/rejected, not approved/)
    await expect(authorApprovedNightRequest(owner, { tenantId: tenantB, approvalId: approved.id, actor: 'ops test', executorUserId: executor }, { apply: true })).rejects.toThrow(/not found in that tenant/)
    await expect(authorApprovedNightRequest(owner, { tenantId: tenantA, approvalId: approved.id, actor: 'ops test', executorUserId: 'nobody-here-1' }, { apply: true })).rejects.toThrow(/--executor/)
    expect(await nights()).toBe(5)
    const preview = await authorApprovedNightRequest(owner, { tenantId: tenantA, approvalId: approved.id, actor: 'ops test', executorUserId: executor }, { apply: false })
    expect(preview).toMatchObject({ applied: false, created: 0 }); expect(preview.plan.create).toEqual([day(40), day(41), day(42), day(43)]); expect(await nights()).toBe(5)
    await expect(authorApprovedNightRequest(owner, { tenantId: tenantA, approvalId: approved.id, actor: 'ops test', executorUserId: executor }, { apply: true, expectedFingerprint: 'f'.repeat(64) })).rejects.toThrow(/changed since the preview/)
    expect((await owner.approvalRequest.findUniqueOrThrow({ where: { id: approved.id } })).status).toBe('APPROVED') // a refused apply leaves the approval usable
    const done = await authorApprovedNightRequest(owner, { tenantId: tenantA, approvalId: approved.id, actor: 'ops test', executorUserId: executor }, { apply: true, expectedFingerprint: preview.plan.fingerprint })
    expect(done).toMatchObject({ applied: true, created: 4 })
    const rows = await owner.inventoryPoolDay.findMany({ where: { poolId: poolA, stayDate: { gte: new Date(day(40)) } }, orderBy: { stayDate: 'asc' } })
    expect(rows.map((r) => [r.stayDate.toISOString().slice(0, 10), r.capacity, r.sold, r.held])).toEqual([[day(40), 7, 0, 0], [day(41), 7, 0, 0], [day(42), 7, 0, 0], [day(43), 7, 0, 0]])
    const after = await owner.approvalRequest.findUniqueOrThrow({ where: { id: approved.id } })
    expect(after.status).toBe('EXECUTED'); expect(after.executedAt).not.toBeNull(); expect(after.executedById).toBe(executor)
    expect(await owner.auditEvent.findFirstOrThrow({ where: { tenantId: tenantA, action: 'inventory.pool.nights_created' } })).toMatchObject({ payload: expect.objectContaining({ approvalId: approved.id, created: 4, via: 'ops:pool-nights --approval' }) })
    await expect(authorApprovedNightRequest(owner, { tenantId: tenantA, approvalId: approved.id, actor: 'ops test', executorUserId: executor }, { apply: true })).rejects.toThrow(/already applied/) // single use
    expect(await nights()).toBe(9)
  })

  it('NR-06 the loop closes on the strict API: the executed request shows as executed, and the capacity editor can now edit the new nights', async () => {
    const list = (await call('get', path(), 'viewer').expect(200)).body.data.items as Array<{ status: string; executedAt: string | null }>
    expect(list.find((i) => i.status === 'EXECUTED')?.executedAt).not.toBeNull()
    await call('post', path(`/${(await owner.approvalRequest.findFirstOrThrow({ where: { tenantId: tenantA, status: 'EXECUTED' } })).id}/cancel`), 'maker').expect(409)
    const editor = { startDate: day(40), endDate: day(43), capacity: 8 }
    const owner2 = await owner.user.findFirstOrThrow({ where: { email: `${suffix}-maker@example.test` } })
    void owner2
    // the editor needs its own permissions: grant them to the maker's role for this check only
    const role = await owner.role.findFirstOrThrow({ where: { tenantId: tenantA, name: `${suffix}-maker` } })
    for (const k of ['supply.pool_capacity.preview']) { const p = await owner.permission.upsert({ where: { key: k }, update: {}, create: { key: k, description: k } }); await owner.rolePermission.create({ data: { roleId: role.id, permissionId: p.id } }) }
    const prev = await request(app.getHttpServer()).post(`/api/v1/admin/hotels/${hotelA}/inventory/pools/${poolA}/capacity/preview`).set('Origin', origin).set('Cookie', cookies.maker).send(editor)
    expect(prev.status).toBe(200); expect(prev.body.data).toMatchObject({ counts: { willChange: 4, invalid: 0 }, canApply: true })
  })
})
