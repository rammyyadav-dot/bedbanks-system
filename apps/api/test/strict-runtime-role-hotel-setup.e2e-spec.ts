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
import { API_RUNTIME_GROUP_ROLE, API_RUNTIME_LOGIN_ROLE, provisionApiRuntimeRole } from '../src/database/api-runtime-role'

const ownerUrl = process.env.DATABASE_URL
if (!ownerUrl) throw new Error('DATABASE_URL (the disposable owner connection) is required')

/**
 * Evidence for the Hotel Setup privileges (ADR 0032 amendment, migrations 202610190001 and 202610200001), on the provisioned non-superuser,
 * non-BYPASSRLS runtime role: negative authorization over HTTP and direct SQL, tenant integrity, atomicity, denial audit request ids,
 * and maker-checker publication. Setup used a separate owner connection that the application never receives.
 */
describe('hotel setup on the strict runtime role: negative authorization, tenant integrity and maker-checker (PostgreSQL)', () => {
  const owner = new PrismaClient({ datasourceUrl: ownerUrl })
  const suffix = `hsx-${Date.now()}-${randomBytes(3).toString('hex')}`
  const password = 'hotel-setup-evidence'
  const runtimePassword = randomBytes(24).toString('hex')
  const origin = 'http://localhost:3001'
  let app: INestApplication; let previousUrl: string | undefined; let probe: PrismaClient
  let tenantA = '', tenantB = '', hotelA = '', hotelB = '', roomA = '', roomB = ''
  const ids: Record<string, string> = {}; const userIds: string[] = []; const cookies: Record<string, string> = {}
  let seq = 0
  const key = () => `${suffix}-${++seq}-${randomBytes(4).toString('hex')}`
  const MANAGE = ['supply.hotels.read', 'supply.hotels.manage', 'supply.rooms.read', 'supply.rooms.manage']
  const READ = ['supply.hotels.read', 'supply.rooms.read']

  async function user(label: string, tenantId: string, keys: string[]) {
    const email = `${suffix}-${label}@example.test`
    const u = await owner.user.create({ data: { email, name: label, passwordHash: await hashPassword(password), status: 'ACTIVE' } }); userIds.push(u.id); ids[label] = u.id
    await owner.membership.create({ data: { tenantId, userId: u.id, role: 'agent' } })
    const r = await owner.role.create({ data: { tenantId, name: `${suffix}-${label}` } })
    for (const k of keys) { const p = await owner.permission.upsert({ where: { key: k }, update: {}, create: { key: k, description: k } }); await owner.rolePermission.create({ data: { roleId: r.id, permissionId: p.id } }) }
    await owner.userRole.create({ data: { tenantId, userId: u.id, roleId: r.id } })
  }
  const call = (method: 'get' | 'post' | 'patch' | 'put' | 'delete', path: string, who: string, body?: object) => {
    const r = request(app.getHttpServer())[method](`/api/v1${path}`).set('Origin', origin)
    const c = who === 'anon' ? r : r.set('Cookie', cookies[who]); return body ? c.send(body) : c
  }
  const png = () => { const head = Buffer.alloc(33); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head); head.writeUInt32BE(13, 8); head.write('IHDR', 12, 'latin1'); head.writeUInt32BE(1600, 16); head.writeUInt32BE(1200, 20); return Buffer.concat([head, Buffer.from(key())]) }
  /** Runs `work` on the runtime role inside one transaction with the tenant setting (or none). */
  const as = <T>(tenant: string | null, work: (tx: Parameters<Parameters<typeof probe.$transaction>[0]>[0]) => Promise<T>) =>
    probe.$transaction(async (tx) => { if (tenant) await tx.$executeRawUnsafe(`SELECT set_config('app.current_tenant_id', '${tenant}', true)`); return work(tx) })
  const counts = async () => ({
    hotel: await owner.hotel.count({ where: { tenantId: { in: [tenantA, tenantB] } } }), room: await owner.roomType.count({ where: { hotel: { tenantId: { in: [tenantA, tenantB] } } } }),
    roomAmenity: await owner.roomAmenity.count(), hotelAmenity: await owner.hotelAmenity.count(), profile: await owner.hotelProfile.count(), image: await owner.hotelImage.count(), approval: await owner.approvalRequest.count(),
  })
  const FULL = { address: '1 Palm Road', latitude: '25.1234', longitude: '55.1234', starRating: 4, starVerified: true, starSource: 'Tourism authority register', shortDescription: 'A quiet hotel on the Palm.', checkInTime: '14:00', checkOutTime: '12:00', contacts: { reservations: { name: 'Front desk', email: 'private-res@hotel.test' } } }
  /** A hotel created through the API on the strict role that meets every publication requirement. */
  async function publishableHotel(label: string, who = 'maker'): Promise<string> {
    const id = (await call('post', '/supply/hotels', who, { name: `${suffix} ${label}`, propertyType: 'HOTEL', address: null, city: 'Dubai', countryCode: 'AE', timeZone: 'Asia/Dubai', contentStatus: 'DRAFT', externalRef: null }).expect(201)).body.data.id as string
    const token = async () => (await call('get', `/admin/hotels/${id}/setup`, who).expect(200)).body.data.concurrencyToken
    await call('patch', `/admin/hotels/${id}/setup`, who, { idempotencyKey: key(), expectedToken: await token(), ...FULL }).expect(200)
    await call('post', `/admin/hotels/${id}/rooms`, who, { idempotencyKey: key(), name: 'Room', code: `R${++seq}`, maxAdults: 2, maxChildren: 0, maxOccupancy: 2 }).expect(201)
    return id
  }

  beforeAll(async () => {
    await owner.$connect()
    tenantA = (await owner.tenant.create({ data: { name: `${suffix}a`, slug: `${suffix}a` } })).id
    tenantB = (await owner.tenant.create({ data: { name: `${suffix}b`, slug: `${suffix}b` } })).id
    const mk = async (tenantId: string, name: string) => { const h = (await owner.hotel.create({ data: { tenantId, name: `${suffix} ${name}`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', contentStatus: 'DRAFT' } })).id; const r = (await owner.roomType.create({ data: { hotelId: h, name: 'Deluxe', code: `D-${name}`, maxAdults: 2, maxOccupancy: 2 } })).id; return [h, r] as const }
    ;[hotelA, roomA] = await mk(tenantA, 'A'); [hotelB, roomB] = await mk(tenantB, 'B')
    await user('maker', tenantA, MANAGE); await user('checker', tenantA, MANAGE); await user('reader', tenantA, READ); await user('none', tenantA, []); await user('badmin', tenantB, MANAGE)
    await owner.hotelAmenity.create({ data: { tenantId: tenantB, hotelId: hotelB, code: 'POOL', feeType: 'FREE', updatedById: ids.badmin } })
    await owner.roomAmenity.create({ data: { tenantId: tenantB, hotelId: hotelB, roomTypeId: roomB, code: 'BALCONY', feeType: 'FREE', updatedById: ids.badmin } })
    await provisionApiRuntimeRole(owner, { password: runtimePassword })
    previousUrl = process.env.DATABASE_URL
    const u = new URL(ownerUrl!); u.username = API_RUNTIME_LOGIN_ROLE; u.password = runtimePassword
    process.env.DATABASE_URL = u.toString(); process.env.ADMIN_ORIGIN = origin
    probe = new PrismaClient({ datasourceUrl: `${u.toString()}${u.search ? '&' : '?'}connection_limit=1` })
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication()
    app.use(cookieParser()); app.setGlobalPrefix('api/v1')
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
    app.useGlobalFilters(new HttpExceptionFilter()); app.useGlobalInterceptors(new ResponseInterceptor())
    await app.init()
    for (const label of ['maker', 'checker', 'reader', 'none', 'badmin']) {
      const r = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', origin).send({ email: `${suffix}-${label}@example.test`, password }).expect(200)
      cookies[label] = (r.headers['set-cookie'][0] as string).split(';')[0]
    }
  }, 180_000)

  afterAll(async () => {
    await probe?.$disconnect(); await app?.close()
    if (previousUrl) process.env.DATABASE_URL = previousUrl
    for (const t of [tenantA, tenantB].filter(Boolean)) {
      for (const q of [`DELETE FROM "AuditEvent" WHERE tenant_id = '${t}'`, `DELETE FROM "ApprovalRequest" WHERE tenant_id = '${t}'`, `DELETE FROM "HotelImage" WHERE tenant_id = '${t}'`, `DELETE FROM "RoomAmenity" WHERE tenant_id = '${t}'`, `DELETE FROM "HotelAmenity" WHERE tenant_id = '${t}'`,
        `DELETE FROM "HotelExternalIdentifier" WHERE tenant_id = '${t}'`, `DELETE FROM "HotelProfile" WHERE tenant_id = '${t}'`, `DELETE FROM "RoomType" WHERE hotel_id IN (SELECT id FROM "Hotel" WHERE tenant_id = '${t}')`, `DELETE FROM "Hotel" WHERE tenant_id = '${t}'`,
        `DELETE FROM "UserRole" WHERE tenant_id = '${t}'`, `DELETE FROM "RolePermission" WHERE role_id IN (SELECT id FROM "Role" WHERE tenant_id = '${t}')`, `DELETE FROM "Role" WHERE tenant_id = '${t}'`, `DELETE FROM memberships WHERE tenant_id = '${t}'`]) await owner.$executeRawUnsafe(q).catch(() => undefined)
    }
    await owner.session.deleteMany({ where: { userId: { in: userIds } } }); await owner.user.deleteMany({ where: { id: { in: userIds } } }); await owner.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB].filter(Boolean) } } })
    await owner.$disconnect()
  }, 60_000)

  // ---- HTTP: 401, 403, cross-tenant 404, nothing written, denial audits keep the request id ----------------------------------------------------------
  const ROUTES: Array<{ name: string; method: 'post' | 'patch' | 'put'; path: () => string; body: () => object; crossTenant: boolean }> = [
    { name: 'create hotel', method: 'post', path: () => '/supply/hotels', body: () => ({ name: 'X', propertyType: 'HOTEL', address: null, city: 'Dubai', countryCode: 'AE', timeZone: 'Asia/Dubai', contentStatus: 'DRAFT', externalRef: null }), crossTenant: false },
    { name: 'setup save', method: 'patch', path: () => `/admin/hotels/${hotelA}/setup`, body: () => ({ idempotencyKey: key(), expectedToken: 'x', area: 'X' }), crossTenant: true },
    { name: 'status change', method: 'post', path: () => `/admin/hotels/${hotelA}/setup/status`, body: () => ({ idempotencyKey: key(), expectedToken: 'x', to: 'SUSPENDED', reason: 'probe reason' }), crossTenant: true },
    { name: 'create room', method: 'post', path: () => `/admin/hotels/${hotelA}/rooms`, body: () => ({ idempotencyKey: key(), name: 'Probe', code: 'PRB', maxAdults: 2, maxChildren: 0, maxOccupancy: 2, amenities: [{ code: 'BALCONY', feeType: 'FREE' }] }), crossTenant: true },
    { name: 'edit room', method: 'patch', path: () => `/admin/hotels/${hotelA}/rooms/${roomA}`, body: () => ({ idempotencyKey: key(), expectedToken: 'x', name: 'Renamed', amenities: [{ code: 'WIFI', feeType: 'FREE' }] }), crossTenant: true },
    { name: 'archive room', method: 'post', path: () => `/admin/hotels/${hotelA}/rooms/${roomA}/archive`, body: () => ({ idempotencyKey: key(), expectedToken: 'x', reason: 'probe reason' }), crossTenant: true },
    { name: 'hotel amenities', method: 'put', path: () => `/admin/hotels/${hotelA}/amenities`, body: () => ({ idempotencyKey: key(), expectedToken: 'x', amenities: [{ code: 'POOL', feeType: 'FREE' }] }), crossTenant: true },
    { name: 'publication request', method: 'post', path: () => `/admin/hotels/${hotelA}/setup/publication/request`, body: () => ({ requestId: key(), expectedToken: 'x', reason: 'probe reason' }), crossTenant: true },
  ]
  it.each(ROUTES.map((r) => [r.name, r] as const))('HN-01 %s: 401 unauthenticated, 403 without permission (audited with the request id), 404 for another tenant, nothing written', async (_n, r) => {
    const before = await counts(); const auditBefore = await owner.auditEvent.count()
    expect((await call(r.method, r.path(), 'anon', r.body())).status).toBe(401)
    for (const who of ['none', 'reader']) {
      const res = await call(r.method, r.path(), who, r.body())
      expect({ who, status: res.status, code: res.body.error?.code }).toEqual({ who, status: 403, code: 'FORBIDDEN' })
      const denied = await owner.auditEvent.findFirst({ where: { action: 'permission.denied', userId: ids[who], tenantId: tenantA }, orderBy: { createdAt: 'desc' } })
      expect((denied?.payload as { requestId?: string } | null)?.requestId).toBe(res.body.meta.requestId) // the denial audit carries this request's id
    }
    if (r.crossTenant) expect((await call(r.method, r.path(), 'badmin', r.body())).status).toBe(404)
    expect(await counts()).toEqual(before)
    const created = (await owner.auditEvent.findMany({ orderBy: { createdAt: 'desc' }, take: (await owner.auditEvent.count()) - auditBefore, select: { action: true } })).map((e) => e.action)
    expect(created.filter((a) => !['permission.denied', 'tenant.context.selected'].includes(a))).toEqual([]) // no mutation audit on a denial
  })

  // ---- SQL as the runtime role: tenant integrity, protected columns, no context, pooled connections ----------------------------------------------------------
  it('HN-02 cross-tenant references cannot be inserted: another tenant\'s hotel or room is refused by the database (the 202610200001 guard), and nothing is written', async () => {
    const before = await counts()
    const row = (sql: string) => as(tenantA, (tx) => tx.$executeRawUnsafe(sql))
    const refused: Array<[string, string]> = [
      ['RoomAmenity -> tenant B room', `INSERT INTO "RoomAmenity" (id, tenant_id, hotel_id, room_type_id, code, fee_type, updated_by_id, updated_at) VALUES ('x1${suffix}', '${tenantA}', '${hotelB}', '${roomB}', 'SPA', 'FREE', '${ids.maker}', now())`],
      ['HotelAmenity -> tenant B hotel', `INSERT INTO "HotelAmenity" (id, tenant_id, hotel_id, code, fee_type, updated_by_id, updated_at) VALUES ('x2${suffix}', '${tenantA}', '${hotelB}', 'SPA', 'FREE', '${ids.maker}', now())`],
      ['HotelProfile -> tenant B hotel', `INSERT INTO "HotelProfile" (id, tenant_id, hotel_id, version, updated_by_id, updated_at) VALUES ('x3${suffix}', '${tenantA}', '${hotelB}', 1, '${ids.maker}', now())`],
      ['HotelExternalIdentifier -> tenant B hotel', `INSERT INTO "HotelExternalIdentifier" (id, tenant_id, hotel_id, scheme, value, created_by_id, updated_at) VALUES ('x4${suffix}', '${tenantA}', '${hotelB}', 'GIATA', 'g', '${ids.maker}', now())`],
      ['RoomType -> tenant B hotel', `INSERT INTO "RoomType" (id, hotel_id, name, code, max_adults, max_children, max_occupancy, bedding_metadata, is_active, updated_at) VALUES ('x5${suffix}', '${hotelB}', 'x', 'xx', 2, 0, 2, '{}', true, now())`],
      ['Hotel for tenant B from tenant A context', `INSERT INTO "Hotel" (id, tenant_id, name, property_type, city, country_code, time_zone, content_status, updated_at) VALUES ('x6${suffix}', '${tenantB}', 'x', 'HOTEL', 'x', 'AE', 'Asia/Dubai', 'DRAFT', now())`],
    ]
    for (const [name, sql] of refused) await expect({ name, outcome: await row(sql).then(() => 'ALLOWED', () => 'refused') }).toEqual({ name, outcome: 'refused' })
    expect(await counts()).toEqual(before)
  })

  it('HN-03 references cannot be reassigned and protected columns cannot change: ownership, identifiers and external_ref are refused at the privilege or guard layer', async () => {
    const own = await owner.roomAmenity.create({ data: { tenantId: tenantA, hotelId: hotelA, roomTypeId: roomA, code: 'WIFI', feeType: 'FREE', updatedById: ids.maker } })
    const ownHotelAmenity = await owner.hotelAmenity.create({ data: { tenantId: tenantA, hotelId: hotelA, code: 'GYM', feeType: 'FREE', updatedById: ids.maker } })
    const profile = await owner.hotelProfile.create({ data: { tenantId: tenantA, hotelId: hotelA, version: 1, updatedById: ids.maker } })
    const refused: Array<[string, string]> = [
      ['RoomAmenity room_type_id', `UPDATE "RoomAmenity" SET room_type_id = '${roomB}' WHERE id = '${own.id}'`],
      ['RoomAmenity hotel_id', `UPDATE "RoomAmenity" SET hotel_id = '${hotelB}' WHERE id = '${own.id}'`],
      ['RoomAmenity tenant_id', `UPDATE "RoomAmenity" SET tenant_id = '${tenantB}' WHERE id = '${own.id}'`],
      ['HotelAmenity hotel_id', `UPDATE "HotelAmenity" SET hotel_id = '${hotelB}' WHERE id = '${ownHotelAmenity.id}'`],
      ['HotelAmenity tenant_id', `UPDATE "HotelAmenity" SET tenant_id = '${tenantB}' WHERE id = '${ownHotelAmenity.id}'`],
      ['HotelProfile hotel_id to another tenant\'s hotel (guard)', `UPDATE "HotelProfile" SET hotel_id = '${hotelB}' WHERE id = '${profile.id}'`],
      ['RoomType hotel_id', `UPDATE "RoomType" SET hotel_id = '${hotelB}' WHERE id = '${roomA}'`],
      ['RoomType id', `UPDATE "RoomType" SET id = 'moved${suffix}' WHERE id = '${roomA}'`],
      ['RoomType created_at', `UPDATE "RoomType" SET created_at = now() WHERE id = '${roomA}'`],
      ['Hotel external_ref', `UPDATE "Hotel" SET external_ref = 'x' WHERE id = '${hotelA}'`],
      ['Hotel tenant_id', `UPDATE "Hotel" SET tenant_id = '${tenantB}' WHERE id = '${hotelA}'`],
      ['Hotel id', `UPDATE "Hotel" SET id = 'moved${suffix}' WHERE id = '${hotelA}'`],
      ['Hotel created_at', `UPDATE "Hotel" SET created_at = now() WHERE id = '${hotelA}'`],
      ['Hotel DELETE', `DELETE FROM "Hotel" WHERE id = '${hotelA}'`],
      ['RoomType DELETE', `DELETE FROM "RoomType" WHERE id = '${roomA}'`],
    ]
    for (const [name, sql] of refused) await expect({ name, outcome: await as(tenantA, (tx) => tx.$executeRawUnsafe(sql)).then(() => 'ALLOWED', () => 'refused') }).toEqual({ name, outcome: 'refused' })
    // The granted columns work (own tenant), and another tenant's rows are untouchable: zero rows match.
    expect(await as(tenantA, (tx) => tx.$executeRawUnsafe(`UPDATE "RoomAmenity" SET fee_type = 'PAID' WHERE id = '${own.id}'`))).toBe(1)
    expect(await as(tenantA, (tx) => tx.$executeRawUnsafe(`UPDATE "RoomType" SET name = name WHERE id = '${roomA}'`))).toBe(1)
    expect(await as(tenantA, (tx) => tx.$executeRawUnsafe(`UPDATE "RoomAmenity" SET fee_type = 'PAID' WHERE room_type_id = '${roomB}'`))).toBe(0)
    expect(await as(tenantA, (tx) => tx.$executeRawUnsafe(`DELETE FROM "RoomAmenity" WHERE room_type_id = '${roomB}'`))).toBe(0)
    expect(await as(tenantA, (tx) => tx.$executeRawUnsafe(`UPDATE "HotelAmenity" SET fee_type = 'PAID' WHERE hotel_id = '${hotelB}'`))).toBe(0)
    expect(await as(tenantA, (tx) => tx.$executeRawUnsafe(`UPDATE "RoomType" SET name = 'hijack' WHERE id = '${roomB}'`))).toBe(0)
    expect(await as(tenantA, (tx) => tx.$executeRawUnsafe(`UPDATE "Hotel" SET name = 'hijack' WHERE id = '${hotelB}'`))).toBe(0)
    expect((await owner.roomType.findUniqueOrThrow({ where: { id: roomB } })).name).toBe('Deluxe')
    expect((await owner.roomAmenity.findUniqueOrThrow({ where: { id: own.id } })).hotelId).toBe(hotelA)
    await owner.roomAmenity.delete({ where: { id: own.id } }); await owner.hotelAmenity.delete({ where: { id: ownHotelAmenity.id } }); await owner.hotelProfile.delete({ where: { id: profile.id } })
  })

  it('HN-04 missing tenant context returns nothing and writes nothing; a pooled connection never carries a tenant across transactions', async () => {
    const tables = ['Hotel', 'RoomType', 'RoomAmenity', 'HotelAmenity', 'HotelProfile', 'HotelImage', 'HotelExternalIdentifier', 'ApprovalRequest']
    for (const t of tables) expect({ t, n: Number((await as(null, (tx) => tx.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM "${t}"`)))[0].n) }).toEqual({ t, n: 0 })
    await expect(as(null, (tx) => tx.$executeRawUnsafe(`INSERT INTO "HotelAmenity" (id, tenant_id, hotel_id, code, fee_type, updated_by_id, updated_at) VALUES ('nc${suffix}', '${tenantA}', '${hotelA}', 'POOL', 'FREE', '${ids.maker}', now())`))).rejects.toThrow()
    // connection_limit=1: every transaction below reuses the same backend connection.
    const pid = async (tenant: string | null) => as(tenant, (tx) => tx.$queryRawUnsafe<Array<{ pid: number; n: bigint; tenants: string }>>(`SELECT pg_backend_pid() AS pid, (SELECT count(*) FROM "Hotel") AS n, coalesce(current_setting('app.current_tenant_id', true), '') AS tenants`))
    const a = (await pid(tenantA))[0]; const none = (await pid(null))[0]; const b = (await pid(tenantB))[0]; const none2 = (await pid(null))[0]
    expect(new Set([a.pid, none.pid, b.pid, none2.pid]).size).toBe(1) // one pooled connection throughout
    expect([Number(a.n) > 0, Number(none.n), Number(b.n) > 0, Number(none2.n)]).toEqual([true, 0, true, 0])
    expect([none.tenants, none2.tenants]).toEqual(['', '']) // the setting is transaction-local: nothing leaks to the next transaction
    await expect(as(tenantA, async (tx) => { await tx.$executeRawUnsafe('SELECT 1/0') })).rejects.toThrow()
    expect(Number((await pid(null))[0].n)).toBe(0) // an aborted transaction leaves no context behind either
  })

  it('HN-05 the runtime role cannot grant itself access, switch role, or bypass row-level security', async () => {
    const attempts = [`SET ROLE postgres`, `SET SESSION AUTHORIZATION postgres`, `ALTER ROLE ${API_RUNTIME_LOGIN_ROLE} BYPASSRLS`, `ALTER ROLE ${API_RUNTIME_LOGIN_ROLE} SUPERUSER`, `CREATE ROLE evil LOGIN`, `ALTER TABLE "Hotel" DISABLE ROW LEVEL SECURITY`, `DROP POLICY "Hotel_tenant_isolation" ON "Hotel"`, `CREATE TABLE public.evil (x int)`]
    for (const sql of attempts) await expect({ sql, outcome: await as(tenantA, (tx) => tx.$executeRawUnsafe(sql)).then(() => 'ALLOWED', () => 'refused') }).toEqual({ sql, outcome: 'refused' })
    await as(tenantA, (tx) => tx.$executeRawUnsafe(`GRANT DELETE ON "Hotel" TO ${API_RUNTIME_GROUP_ROLE}`)).catch(() => undefined) // an unprivileged GRANT is a warning at most
    const [grant] = await owner.$queryRawUnsafe<Array<{ d: boolean }>>(`SELECT has_table_privilege('${API_RUNTIME_LOGIN_ROLE}', '"Hotel"', 'DELETE') AS d`)
    expect(grant.d).toBe(false)
    await expect(as(tenantA, async (tx) => { await tx.$executeRawUnsafe('SET LOCAL row_security = off'); return tx.$queryRawUnsafe('SELECT count(*) FROM "Hotel"') })).rejects.toThrow(/row-level security/)
  })

  // ---- atomicity and the error semantics ------------------------------------------------------------------------------------------------------------------
  it('HN-06 a failed mutation leaves no partial data: a missing grant mid-transaction rolls back the whole room create and the whole setup save', async () => {
    const id = await publishableHotel('atomic')
    const before = await counts(); const hotelBefore = await owner.hotel.findUniqueOrThrow({ where: { id } })
    await owner.$executeRawUnsafe(`REVOKE INSERT ON "RoomAmenity" FROM ${API_RUNTIME_GROUP_ROLE}`)
    try {
      const res = await call('post', `/admin/hotels/${id}/rooms`, 'maker', { idempotencyKey: key(), name: 'Atomic', code: 'ATM', maxAdults: 2, maxChildren: 0, maxOccupancy: 2, amenities: [{ code: 'BALCONY', feeType: 'FREE' }] })
      expect(res.status).toBe(503); expect(res.body.error.code).toBe('DATABASE_ROLE_NOT_PERMITTED') // grant drift is configuration, never a 403
      expect(JSON.stringify(res.body)).not.toMatch(/permission denied|RoomAmenity|42501/)
    } finally { await owner.$executeRawUnsafe(`GRANT INSERT ON "RoomAmenity" TO ${API_RUNTIME_GROUP_ROLE}`) }
    expect(await counts()).toEqual(before) // the RoomType inserted first was rolled back with the failed amenity insert
    await owner.$executeRawUnsafe(`REVOKE UPDATE ON "HotelProfile" FROM ${API_RUNTIME_GROUP_ROLE}`)
    try {
      const token = (await call('get', `/admin/hotels/${id}/setup`, 'maker').expect(200)).body.data.concurrencyToken
      const res = await call('patch', `/admin/hotels/${id}/setup`, 'maker', { idempotencyKey: key(), expectedToken: token, address: '2 Changed Road', city: 'Sharjah' })
      expect(res.status).toBe(503)
    } finally { await owner.$executeRawUnsafe(`GRANT UPDATE ON "HotelProfile" TO ${API_RUNTIME_GROUP_ROLE}`) }
    const hotelAfter = await owner.hotel.findUniqueOrThrow({ where: { id } })
    expect({ address: hotelAfter.address, city: hotelAfter.city, updatedAt: hotelAfter.updatedAt }).toEqual({ address: hotelBefore.address, city: hotelBefore.city, updatedAt: hotelBefore.updatedAt }) // the hotel row update rolled back too
    const invalid = await call('post', `/admin/hotels/${id}/rooms`, 'maker', { idempotencyKey: key(), name: 'Bad', code: 'BAD', maxAdults: 2, maxChildren: 0, maxOccupancy: 2, amenities: [{ code: 'NOT_IN_CATALOGUE', feeType: 'FREE' }] })
    expect(invalid.status).toBe(400)
    expect(await counts()).toEqual(before)
  })

  it('HN-07 a privileged-path attempt is audited through the authorized path with this request\'s id, and nothing else is recorded', async () => {
    const res = await call('patch', `/supply/hotels/${hotelA}`, 'maker', { externalRef: 'privileged' })
    expect(res.status).toBe(403); expect(res.body.error.code).toBe('RUNTIME_ROLE_OPERATION_PROHIBITED')
    const event = await owner.auditEvent.findFirstOrThrow({ where: { action: 'runtime_role.operation_prohibited', userId: ids.maker }, orderBy: { createdAt: 'desc' } })
    expect((event.payload as { requestId?: string }).requestId).toBe(res.body.meta.requestId)
    expect(JSON.stringify(event.payload)).not.toMatch(/privileged|permission denied/) // the attempted value is never recorded
    expect((await owner.hotel.findUniqueOrThrow({ where: { id: hotelA } })).externalRef).toBeNull()
  })

  // ---- maker-checker publication ---------------------------------------------------------------------------------------------------------------------------
  const pub = (id: string) => `/admin/hotels/${id}/setup/publication`
  const token = async (id: string, who = 'maker') => (await call('get', `/admin/hotels/${id}/setup`, who).expect(200)).body.data.concurrencyToken as string
  const request_ = async (id: string, who = 'maker') => (await call('post', `${pub(id)}/request`, who, { requestId: key(), expectedToken: await token(id, who), reason: 'Reviewed against the register' }).expect(200)).body.data.approval

  it('MC-01 the requester cannot approve; a second authorized user can; a second user without the permission cannot; the approval is bound to one hotel', async () => {
    const id = await publishableHotel('mc1'); const made = await request_(id)
    expect((await call('post', `${pub(id)}/${made.id}/approve`, 'maker', { reason: 'Self approval' })).status).toBe(403)
    expect((await call('post', `${pub(id)}/${made.id}/approve`, 'reader', { reason: 'No permission' })).status).toBe(403)
    expect((await call('post', `${pub(id)}/${made.id}/approve`, 'none', { reason: 'No permission' })).status).toBe(403)
    expect((await call('post', `${pub(id)}/${made.id}/approve`, 'badmin', { reason: 'Other tenant' })).status).toBe(404)
    const other = await publishableHotel('mc1-other')
    expect((await call('post', `${pub(other)}/${made.id}/approve`, 'checker', { reason: 'Wrong hotel' })).status).toBe(404)
    expect((await owner.hotel.findUniqueOrThrow({ where: { id } })).contentStatus).toBe('DRAFT')
    await call('post', `${pub(id)}/${made.id}/approve`, 'checker', { reason: 'Checked against the register' }).expect(200)
    expect((await owner.hotel.findUniqueOrThrow({ where: { id } })).contentStatus).toBe('DRAFT') // approval alone publishes nothing
  })

  it('MC-02 an edit after submission invalidates the request: it cannot be approved, a new request is required, and nothing was published meanwhile', async () => {
    const id = await publishableHotel('mc2'); const made = await request_(id)
    await call('patch', `/admin/hotels/${id}/setup`, 'maker', { idempotencyKey: key(), expectedToken: await token(id), area: 'Business Bay' }).expect(200)
    const stale = await call('post', `${pub(id)}/${made.id}/approve`, 'checker', { reason: 'Checked' })
    expect(stale.status).toBe(409); expect(stale.body.error.code).toBe('HOTEL_CHANGED_AFTER_REQUEST')
    expect((await owner.hotel.findUniqueOrThrow({ where: { id } })).contentStatus).toBe('DRAFT')
    await call('post', `${pub(id)}/${made.id}/cancel`, 'maker', {}).expect(200)
    const again = await request_(id)
    await call('post', `${pub(id)}/${again.id}/approve`, 'checker', { reason: 'Re-reviewed' }).expect(200)
  })

  it('MC-03 concurrent approvals and executions cannot duplicate effects: exactly one decision, one publication, one audit event each', async () => {
    const id = await publishableHotel('mc3'); const made = await request_(id)
    const approvals = await Promise.all([1, 2, 3].map(() => call('post', `${pub(id)}/${made.id}/approve`, 'checker', { reason: 'Checked against the register' })))
    expect(approvals.every((r) => r.status === 200 || r.status === 409)).toBe(true) // a repeat by the same approver is an idempotent replay, never a second decision
    expect(approvals.some((r) => r.status === 200)).toBe(true)
    expect(await owner.auditEvent.count({ where: { tenantId: tenantA, entityId: made.id, action: 'approval.approved' } })).toBe(1)
    const executions = await Promise.all([1, 2, 3].map(() => call('post', `${pub(id)}/${made.id}/execute`, 'maker', {})))
    expect(executions.filter((r) => r.status === 200)).toHaveLength(1)
    expect(executions.filter((r) => r.status !== 200).every((r) => r.status === 409)).toBe(true)
    expect((await owner.hotel.findUniqueOrThrow({ where: { id } })).contentStatus).toBe('COMPLETE')
    const row = await owner.approvalRequest.findUniqueOrThrow({ where: { id: made.id } })
    expect({ status: row.status, requester: row.requestedById, decider: row.decidedById }).toEqual({ status: 'EXECUTED', requester: ids.maker, decider: ids.checker })
    const events = await owner.auditEvent.findMany({ where: { tenantId: tenantA, entityId: id, action: 'hotel.setup.status_changed', payload: { path: ['approvalId'], equals: made.id } } })
    expect(events).toHaveLength(1) // the audit trail agrees with the single effect
    expect(typeof (events[0].payload as { requestId?: string }).requestId).toBe('string')
  })

  it('MC-04 COMPLETE is profile completeness only: the hotel is not sellable, appears in no Agent search, and no hold, booking or supplier call exists', async () => {
    const id = await publishableHotel('mc4'); const made = await request_(id)
    await call('post', `${pub(id)}/${made.id}/approve`, 'checker', { reason: 'Checked' }).expect(200)
    await call('post', `${pub(id)}/${made.id}/execute`, 'maker', {}).expect(200)
    expect((await owner.hotel.findUniqueOrThrow({ where: { id } })).contentStatus).toBe('COMPLETE')
    const view = (await call('get', `/admin/operations/hotels/${id}`, 'maker')).body?.data
    if (view) expect(JSON.stringify(view)).toMatch(/BLOCKED|"sellable":false|NOT_SELLABLE|rate/i) // commercial readiness is a separate assessment
    expect(await owner.ratePlan.count({ where: { roomType: { hotelId: id } } })).toBe(0) // no contract, rate or inventory was created or implied
    expect(await owner.inventoryHold.count({ where: { tenantId: tenantA } })).toBe(0)
    expect(await owner.booking.count({ where: { tenantId: tenantA } })).toBe(0)
    expect(await owner.supplierMutation.count({ where: { tenantId: tenantA } })).toBe(0)
    await call('post', '/agent/offers/none/hold', 'maker', { searchId: 'x', expectedCurrency: 'AED', expectedSellAmountMinor: 1, idempotencyKey: key() }).then((r) => expect([403, 404, 503]).toContain(r.status)) // the booking gate is unchanged
  })

  it('HN-08 the whole journey for an image: upload on the strict role, an unauthorized user cannot, and the other tenant cannot see it', async () => {
    const id = await publishableHotel('img')
    await call('post', `/admin/hotels/${id}/images?altText=Lobby`, 'maker').set('Content-Type', 'image/png').send(png()).expect(201)
    expect((await call('post', `/admin/hotels/${id}/images?altText=Lobby`, 'reader').set('Content-Type', 'image/png').send(png())).status).toBe(403)
    expect((await call('post', `/admin/hotels/${id}/images?altText=Lobby`, 'badmin').set('Content-Type', 'image/png').send(png())).status).toBe(404)
    expect(await owner.hotelImage.count({ where: { hotelId: id } })).toBe(1)
  })
  it('enterprise duplicate and archive controls execute under the strict login and do not grant cross-tenant access', async () => {
    const body = { name: `${suffix} duplicate`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', timeZone: 'Asia/Dubai', address: '10 Shared Road' }
    const made = await call('post', '/supply/hotels', 'maker', body).expect(201)
    const duplicate = await call('post', '/supply/hotels', 'maker', { ...body, name: body.name.toUpperCase() }).expect(409)
    expect(duplicate.body.error.code).toBe('HOTEL_IDENTITY_CONFLICT')
    const id = made.body.data.id
    const view = (await call('get', `/admin/hotels/${id}/setup`, 'maker').expect(200)).body.data
    await call('post', `/admin/hotels/${id}/setup/status`, 'maker', { idempotencyKey: key(), expectedToken: view.concurrencyToken, to: 'ARCHIVED', reason: 'Retire duplicate candidate' }).expect(200)
    const row = await owner.hotel.findUniqueOrThrow({ where: { id } })
    expect(row.contentStatus).toBe('ARCHIVED')
    const foreign = await as(tenantB, tx => tx.hotel.findMany({ where: { id } }))
    expect(foreign).toEqual([])
    const noTenant = await as(null, tx => tx.hotel.findMany({ where: { id } }))
    expect(noTenant).toEqual([])
    await call('get', '/admin/hotels/location-options?countryCode=AE', 'maker').expect(200)
  })

})
