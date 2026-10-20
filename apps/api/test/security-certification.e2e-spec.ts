/**
 * Tenant and database security certification (docs/tenant-database-security-certification.md).
 *
 * Runs the real Nest application on the strict API runtime login (fbeds_api_login, NOBYPASSRLS, forced RLS)
 * against the disposable PostgreSQL 16 database. Fixtures are written by the owner connection; every HTTP
 * request goes through the restricted role. Sections:
 *   1. every restricted role provisioned, verified as itself, and the catalog certified database-wide
 *   2. every HTTP route classified by how it authorizes (a new unclassified route fails)
 *   3. an authenticated member with no permission is refused on every non-public route
 *   4. cross-tenant denial for Admin, Agent and Supplier, each with a positive control
 *   5. session security
 *   6. audit logging of privileged writes and denials; the audit log cannot be rewritten
 */
import { createHash, randomBytes } from 'crypto'
import { INestApplication, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { PrismaClient } from '@prisma/client'
import * as cookieParser from 'cookie-parser'
import * as request from 'supertest'
import { AppModule } from '../src/app.module'
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter'
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor'
import { hashPassword } from '../src/auth/utils/password'
import { hashSessionToken } from '../src/auth/utils/session-token'
import { API_RUNTIME_LOGIN_ROLE, provisionApiRuntimeRole, verifyApiRuntimeRole } from '../src/database/api-runtime-role'
import { BOOKING_OPS_LOGIN_ROLE, provisionBookingOpsRole, verifyBookingOpsRole } from '../src/database/booking-ops-role'
import { HOLD_EXPIRY_GROUP_ROLE, provisionHoldExpiryRole, verifyHoldExpiryRole } from '../src/database/hold-expiry-role'
import { RATE_PLAN_OPS_LOGIN_ROLE, provisionRatePlanOpsRole, verifyRatePlanOpsRole } from '../src/database/rate-plan-ops-role'
import { RATE_PLAN_CLONE_LOGIN_ROLE, provisionRatePlanCloneRole, verifyRatePlanCloneRole } from '../src/database/rate-plan-clone-role'
import { COMPLIANCE_LOGIN_ROLE, provisionComplianceRole, verifyComplianceRole } from '../src/compliance/compliance-role'
import { TENANT_CONTROL_LOGIN, provisionTenantControlRole } from '../src/database/tenant-control-role'
import { certifyDatabaseSecurity } from '../src/database/security-certification'

const ownerUrl = process.env.TEST_OWNER_DATABASE_URL ?? process.env.DATABASE_URL
if (!ownerUrl) throw new Error('DATABASE_URL is required')
const owner = new PrismaClient({ datasourceUrl: ownerUrl })
const HOLD_EXPIRY_LOGIN = 'fbeds_hold_expiry_login'
/** NOLOGIN probe role other suites grant broad DML to exercise RLS (runtime-rls-role, tenant-finance). Disposable databases only. */
const TEST_FIXTURE_ROLES = ['fbeds_rls_test']

function loginUrl(role: string, password: string): string {
  const url = new URL(ownerUrl!)
  url.username = role
  url.password = password
  return url.toString()
}

/** How a route authorizes. Every route of the application must appear in exactly one class. */
type RouteClass =
  | 'public' //            no session: liveness, login, logout
  | 'self' //              session only; answers about the caller's own identity or grants
  | 'guard-permission' //  an RBAC guard reads a declared permission and fails closed
  | 'booking-scope' //     BookingAccessGuard: booking.read (operator) or booking.view.agency (own agency)
  | 'supplier-membership' // SupplierOrganizationGuard plus a supplier.extranet.* permission in the service

const PERMISSION_KEYS = ['fbeds:required-admin-permission', 'fbeds:required-permission', 'fbeds:required-supply-permission', 'fbeds:booking-action-permissions', 'platform_permission']
const GUARD_FOR_KEY: Record<string, string> = {
  'fbeds:required-admin-permission': 'AdminRbacGuard',
  'fbeds:required-permission': 'AgentRbacGuard',
  'fbeds:required-supply-permission': 'SupplyPermissionGuard',
  'fbeds:booking-action-permissions': 'BookingAccessGuard',
  platform_permission: 'PlatformRbacGuard',
}
const PUBLIC_ROUTES = new Set(['GET /health', 'GET /health/ready', 'POST /auth/login', 'POST /auth/logout'])
const SELF_ROUTES = new Set([
  'GET /auth/me', 'GET /agent/context', 'GET /supplier/extranet/memberships',
  // Capability lists: the caller's own permission keys, used only to hide controls.
  'GET /admin/operations/capabilities', 'GET /supply/capabilities',
])
/** Routes a zero-permission member may reach: they answer only about the caller. */
const ZERO_PERMISSION_ALLOWED = new Set([...SELF_ROUTES])

interface Route { method: string; path: string; handler: string; guards: string[]; keys: string[]; cls?: RouteClass }

function inventory(): Route[] {
  const seen = new Set<unknown>()
  const controllers: Array<new (...args: never[]) => unknown> = []
  const walk = (entry: unknown) => {
    if (!entry) return
    const mod = (entry as { module?: unknown }).module ?? entry
    if (seen.has(mod)) return
    seen.add(mod)
    for (const c of Reflect.getMetadata('controllers', mod as object) ?? []) controllers.push(c)
    for (const i of [...(Reflect.getMetadata('imports', mod as object) ?? []), ...((entry as { imports?: unknown[] }).imports ?? [])]) walk(i)
  }
  walk(AppModule)
  const methods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD']
  const routes: Route[] = []
  for (const c of controllers) {
    const base = Reflect.getMetadata('path', c) as string
    const classGuards = (Reflect.getMetadata('__guards__', c) ?? []).map((g: { name: string }) => g.name)
    for (const name of Object.getOwnPropertyNames(c.prototype)) {
      const handler = (c.prototype as Record<string, unknown>)[name]
      if (name === 'constructor' || typeof handler !== 'function') continue
      const path = Reflect.getMetadata('path', handler) as string | undefined
      if (path === undefined) continue
      const guards = [...classGuards, ...(Reflect.getMetadata('__guards__', handler) ?? []).map((g: { name: string }) => g.name)]
      const keys = PERMISSION_KEYS.filter((k) => Reflect.getMetadata(k, handler) !== undefined || Reflect.getMetadata(k, c) !== undefined)
      routes.push({ method: methods[Reflect.getMetadata('method', handler) as number], path: `/${base}/${path}`.replace(/\/+/g, '/').replace(/(.)\/$/, '$1'), handler: `${c.name}.${name}`, guards, keys })
    }
  }
  return routes
}

function classify(route: Route): RouteClass | undefined {
  const id = `${route.method} ${route.path}`
  if (PUBLIC_ROUTES.has(id)) return 'public'
  if (!route.guards.includes('SessionAuthGuard')) return undefined
  if (SELF_ROUTES.has(id)) return 'self'
  if (route.keys.length) return route.keys.every((k) => route.guards.includes(GUARD_FOR_KEY[k])) ? 'guard-permission' : undefined
  if (route.guards.includes('BookingAccessGuard') && route.guards.includes('TenantContextGuard')) return 'booking-scope'
  if (route.guards.includes('SupplierOrganizationGuard') && route.guards.includes('TenantContextGuard')) return 'supplier-membership'
  return undefined
}

describe('Tenant and database security certification', () => {
  const suffix = `seccert-${Date.now()}-${randomBytes(3).toString('hex')}`
  const origin = 'http://localhost:3001'
  const password = 'security-certification-password'
  const passwords = Object.fromEntries(['api', 'booking', 'hold', 'ops', 'clone', 'compliance', 'control'].map((k) => [k, randomBytes(32).toString('hex')]))
  const env: Record<string, string | undefined> = {}
  let app: INestApplication
  const routes = inventory()

  const t = { A: '', B: '' }
  const ids = { hotelA: '', hotelB: '', roomA: '', roomB: '', supplierA: '', supplierB: '', bookingA: '', bookingB: '', imageA: '', imageB: '' }
  const cookies: Record<string, string> = {}
  const userIds: Record<string, string> = {}

  const http = () => request(app.getHttpServer())
  const as = (who: string, test: request.Test, tenant?: string) => {
    test.set('Cookie', cookies[who]).set('Origin', origin)
    return tenant ? test.set('x-fbeds-tenant-id', tenant) : test
  }

  const email = (who: string) => `${suffix}-${who}@example.test`.toLowerCase()

  async function login(who: string) {
    const res = await http().post('/api/v1/auth/login').set('Origin', origin).send({ email: email(who), password }).expect(200)
    const raw = ([] as string[]).concat(res.headers['set-cookie'] ?? [])
    cookies[who] = raw[0].split(';')[0]
    return raw[0]
  }

  beforeAll(async () => {
    await owner.$connect()
    // 1. Every restricted role, each with a fresh generated password (never printed).
    await provisionApiRuntimeRole(owner, { password: passwords.api })
    await provisionBookingOpsRole(owner, { password: passwords.booking })
    await provisionHoldExpiryRole(owner, { loginRole: HOLD_EXPIRY_LOGIN, password: passwords.hold })
    await provisionRatePlanOpsRole(owner, { password: passwords.ops })
    await provisionRatePlanCloneRole(owner, { password: passwords.clone })
    await provisionComplianceRole(owner, { password: passwords.compliance })
    await provisionTenantControlRole(owner, passwords.control)

    const passwordHash = await hashPassword(password)
    const [a, b] = await Promise.all([
      owner.tenant.create({ data: { name: `${suffix} A`, slug: `${suffix}-a` } }),
      owner.tenant.create({ data: { name: `${suffix} B`, slug: `${suffix}-b` } }),
    ])
    t.A = a.id; t.B = b.id
    const keys = [
      'supply.hotels.read', 'supply.hotels.manage', 'supply.suppliers.read', 'supply.suppliers.manage', 'supply.rooms.read',
      'supplier.extranet.hotels.read', 'supplier.extranet.rooms.read', 'supplier.extranet.drafts.manage', 'supplier.extranet.bookings.read', 'supplier.extranet.bookings.answer', 'supplier.extranet.contracts.read',
      'hotel.search', 'booking.read', 'audit.read',
    ]
    const permissions = await Promise.all(keys.map((key) => owner.permission.upsert({ where: { key }, update: {}, create: { key, description: key } })))
    const byKey = new Map(permissions.map((p) => [p.key, p.id]))
    const roleIds: Record<string, string> = {}
    for (const [tenant, tid] of Object.entries(t)) {
      const hotel = await owner.hotel.create({ data: { tenantId: tid, name: `${suffix} Hotel ${tenant}`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', contentStatus: 'COMPLETE' } })
      const room = await owner.roomType.create({ data: { hotelId: hotel.id, name: `Room ${tenant}`, code: `${suffix}-${tenant}`, maxAdults: 2, maxOccupancy: 2 } })
      const supplier = await owner.supplier.create({ data: { tenantId: tid, type: 'HOTEL_DIRECT', status: 'ACTIVE', legalName: `${suffix} Supplier ${tenant}`, displayName: `Supplier ${tenant}`, countryCode: 'AE', defaultCurrency: 'AED' } })
      await owner.supplierHotelMapping.create({ data: { tenantId: tid, supplierId: supplier.id, hotelId: hotel.id, supplierHotelId: `${suffix}-${tenant}`, status: 'MAPPED' } })
      const booking = await owner.booking.create({ data: {
        tenantId: tid, reference: `FB-${randomBytes(8).toString('hex').toUpperCase()}`, supplier: 'contracted-inventory', supplierId: supplier.id, hotelId: hotel.id,
        status: 'CONFIRMED', currency: 'AED', totalMinor: 100_000n, idempotencyKey: `${suffix}-${tenant}`, searchSnapshot: {}, checkIn: new Date('2027-03-01'), checkOut: new Date('2027-03-03'), nights: 2, netMinor: 80_000n,
      } })
      Object.assign(ids, { [`hotel${tenant}`]: hotel.id, [`room${tenant}`]: room.id, [`supplier${tenant}`]: supplier.id, [`booking${tenant}`]: booking.id })
      const role = await owner.role.create({ data: { tenantId: tid, name: `${suffix}-all` } })
      await owner.rolePermission.createMany({ data: keys.map((key) => ({ roleId: role.id, permissionId: byKey.get(key)! })) })
      roleIds[tenant] = role.id
    }
    // Admin, Agent and Supplier per tenant, all with the same broad role so a denial can only come from tenancy. Plus a zero-permission member of A.
    const people: Array<[string, 'A' | 'B', string, boolean]> = [
      ['adminA', 'A', 'owner', true], ['adminB', 'B', 'owner', true],
      ['agentA', 'A', 'agent', true], ['agentB', 'B', 'agent', true],
      ['supplierA', 'A', 'member', true], ['supplierB', 'B', 'member', true],
      ['zero', 'A', 'member', false], ['victim', 'A', 'member', false],
    ]
    for (const [who, tenant, membershipRole, roled] of people) {
      const user = await owner.user.create({ data: { email: email(who), passwordHash, name: who, status: 'ACTIVE' } })
      userIds[who] = user.id
      await owner.membership.create({ data: { userId: user.id, tenantId: t[tenant], role: membershipRole } })
      if (roled) await owner.userRole.create({ data: { tenantId: t[tenant], userId: user.id, roleId: roleIds[tenant] } })
      if (who.startsWith('supplier')) await owner.supplierMembership.create({ data: { tenantId: t[tenant], userId: user.id, supplierId: tenant === 'A' ? ids.supplierA : ids.supplierB, status: 'ACTIVE' } })
    }

    // A published-hotel image per tenant: Agent catalogue content readable under the strict role.
    for (const tenant of ['A', 'B'] as const) {
      const data = Buffer.from(`${suffix}-${tenant}`)
      const image = await owner.hotelImage.create({ data: { tenantId: t[tenant], hotelId: ids[`hotel${tenant}`], contentType: 'image/png', bytes: data.length, width: 800, height: 600, sha256: createHash('sha256').update(data).digest('hex'), altText: tenant, data, uploadedById: userIds[`admin${tenant}`] } })
      ids[`image${tenant}`] = image.id
    }

    for (const key of ['DATABASE_URL', 'ADMIN_ORIGIN', 'BOOKING_OPS_DATABASE_URL', 'TENANT_CONTROL_DATABASE_URL', 'DB_RUNTIME_ROLE_GUARD']) env[key] = process.env[key]
    process.env.DATABASE_URL = loginUrl(API_RUNTIME_LOGIN_ROLE, passwords.api)
    process.env.BOOKING_OPS_DATABASE_URL = loginUrl(BOOKING_OPS_LOGIN_ROLE, passwords.booking)
    process.env.TENANT_CONTROL_DATABASE_URL = loginUrl(TENANT_CONTROL_LOGIN, passwords.control)
    process.env.ADMIN_ORIGIN = origin
    process.env.DB_RUNTIME_ROLE_GUARD = 'enforce'
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication()
    app.use(cookieParser())
    app.setGlobalPrefix('api/v1')
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
    app.useGlobalFilters(new HttpExceptionFilter())
    app.useGlobalInterceptors(new ResponseInterceptor())
    await app.init()
    // Listen up front: supertest 7.3 closes a server it started once no request is pending, which races requests built around an awaited login.
    await app.listen(0, '127.0.0.1')
    for (const who of people.map((p) => p[0])) await login(who)
  }, 120_000)

  afterAll(async () => {
    await app?.close()
    for (const [key, value] of Object.entries(env)) if (value === undefined) delete process.env[key]; else process.env[key] = value
    const tenants = [t.A, t.B].filter(Boolean)
    const users = Object.values(userIds)
    await owner.$transaction([
      owner.auditEvent.deleteMany({ where: { OR: [{ tenantId: { in: tenants } }, { userId: { in: users } }] } }),
      owner.hotelImage.deleteMany({ where: { tenantId: { in: tenants } } }),
      owner.supplierRoomDraft.deleteMany({ where: { tenantId: { in: tenants } } }),
      owner.supplierMembership.deleteMany({ where: { tenantId: { in: tenants } } }),
      owner.booking.deleteMany({ where: { tenantId: { in: tenants } } }),
      owner.supplierHotelMapping.deleteMany({ where: { tenantId: { in: tenants } } }),
      owner.roomType.deleteMany({ where: { hotel: { tenantId: { in: tenants } } } }),
      owner.hotel.deleteMany({ where: { tenantId: { in: tenants } } }),
      owner.supplier.deleteMany({ where: { tenantId: { in: tenants } } }),
      owner.userRole.deleteMany({ where: { tenantId: { in: tenants } } }),
      owner.role.deleteMany({ where: { tenantId: { in: tenants } } }),
      owner.session.deleteMany({ where: { userId: { in: users } } }),
      owner.membership.deleteMany({ where: { tenantId: { in: tenants } } }),
      owner.user.deleteMany({ where: { id: { in: users } } }),
      owner.tenant.deleteMany({ where: { id: { in: tenants } } }),
    ]).catch(() => undefined)
    await owner.$disconnect()
  })

  describe('1. restricted database roles and forced RLS', () => {
    const verifiers: Array<[string, string, (db: PrismaClient) => Promise<{ ok: boolean; failures: string[] }>]> = [
      [API_RUNTIME_LOGIN_ROLE, 'api', verifyApiRuntimeRole],
      [BOOKING_OPS_LOGIN_ROLE, 'booking', verifyBookingOpsRole],
      [HOLD_EXPIRY_LOGIN, 'hold', verifyHoldExpiryRole],
      [RATE_PLAN_OPS_LOGIN_ROLE, 'ops', verifyRatePlanOpsRole],
      [RATE_PLAN_CLONE_LOGIN_ROLE, 'clone', verifyRatePlanCloneRole],
      [COMPLIANCE_LOGIN_ROLE, 'compliance', verifyComplianceRole],
    ]
    it.each(verifiers)('%s passes its own contract verifier while connected as itself', async (role, key, verify) => {
      const db = new PrismaClient({ datasourceUrl: loginUrl(role, passwords[key]) })
      try {
        const [who] = await db.$queryRawUnsafe<Array<{ u: string }>>('SELECT current_user AS u')
        expect(who.u).toBe(role)
        expect(await verify(db)).toEqual({ ok: true, failures: [] })
      } finally { await db.$disconnect() }
    })

    it('the catalog is certified database-wide, read through the restricted runtime login', async () => {
      const db = new PrismaClient({ datasourceUrl: loginUrl(API_RUNTIME_LOGIN_ROLE, passwords.api) })
      try {
        const report = await certifyDatabaseSecurity(db, { testFixtureRoles: TEST_FIXTURE_ROLES })
        expect(report.failures).toEqual([])
        for (const role of ['fbeds_api', API_RUNTIME_LOGIN_ROLE, 'fbeds_booking', BOOKING_OPS_LOGIN_ROLE, HOLD_EXPIRY_GROUP_ROLE, HOLD_EXPIRY_LOGIN, RATE_PLAN_OPS_LOGIN_ROLE, RATE_PLAN_CLONE_LOGIN_ROLE, COMPLIANCE_LOGIN_ROLE, TENANT_CONTROL_LOGIN]) {
          expect(report.summary.restrictedRoles).toContain(role)
        }
        expect(report.summary.tenantTables).toBeGreaterThan(50)
      } finally { await db.$disconnect() }
    })

    it('the certifier detects each class of violation (negative controls, rolled back)', async () => {
      const probe = `zz_${suffix.replace(/-/g, '_')}`
      const outcome = await owner.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`CREATE TABLE "${probe}" (id text PRIMARY KEY, tenant_id text NOT NULL)`)
        await tx.$executeRawUnsafe(`CREATE TABLE "${probe}_global" (id text PRIMARY KEY)`)
        await tx.$executeRawUnsafe(`GRANT TRUNCATE ON "Hotel" TO fbeds_api`)
        await tx.$executeRawUnsafe(`GRANT UPDATE ("action") ON "AuditEvent" TO fbeds_booking`)
        await tx.$executeRawUnsafe(`GRANT SELECT (password_hash) ON users TO fbeds_hold_expiry`)
        await tx.$executeRawUnsafe(`GRANT SELECT ON "Hotel" TO PUBLIC`)
        await tx.$executeRawUnsafe(`ALTER ROLE fbeds_rateplan_clone BYPASSRLS`)
        await tx.$executeRawUnsafe(`CREATE POLICY "${probe}_open" ON "Hotel" USING (true)`)
        const report = await certifyDatabaseSecurity(tx as unknown as PrismaClient, { testFixtureRoles: TEST_FIXTURE_ROLES })
        throw Object.assign(new Error('rollback'), { report })
      }).catch((error: { report?: Awaited<ReturnType<typeof certifyDatabaseSecurity>> }) => error.report)
      expect(outcome?.ok).toBe(false)
      expect(outcome?.failures).toEqual(expect.arrayContaining([
        `${probe}: tenant table without enabled and forced RLS`,
        `${probe}_global: table without tenant_id is not classified in NON_TENANT_TABLES`,
        'fbeds_api: holds TRUNCATE on Hotel',
        'fbeds_booking: may UPDATE append-only AuditEvent',
        'fbeds_hold_expiry: may read users.password_hash',
        'PUBLIC holds SELECT on Hotel',
        'fbeds_rateplan_clone: restricted role has BYPASSRLS',
        `Hotel.${probe}_open: policy has no tenant, user, platform or compliance predicate`,
      ]))
      // Rolled back: the live catalog is clean again.
      expect((await certifyDatabaseSecurity(owner, { testFixtureRoles: TEST_FIXTURE_ROLES })).failures).toEqual([])
    })

    it('with no tenant context the runtime login reads and writes nothing; another tenant is invisible', async () => {
      const db = new PrismaClient({ datasourceUrl: loginUrl(API_RUNTIME_LOGIN_ROLE, passwords.api) })
      try {
        const read = (tenant: string | null) => db.$transaction(async (tx) => {
          if (tenant) await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenant}, true)`
          return {
            hotels: (await tx.hotel.findMany({ where: { id: { in: [ids.hotelA, ids.hotelB] } }, select: { id: true } })).map((h) => h.id),
            bookings: (await tx.booking.findMany({ where: { id: { in: [ids.bookingA, ids.bookingB] } }, select: { id: true } })).map((h) => h.id),
            audit: await tx.auditEvent.count({ where: { tenantId: { in: [t.A, t.B] } } }),
          }
        })
        expect(await read(null)).toEqual({ hotels: [], bookings: [], audit: 0 })
        expect((await read(t.A)).hotels).toEqual([ids.hotelA])
        expect((await read(t.A)).bookings).toEqual([ids.bookingA])
        await expect(db.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${t.A}, true)`
          return tx.auditEvent.create({ data: { tenantId: t.B, actorType: 'SYSTEM', action: 'forged', entityType: 'probe', entityId: 'x', payload: {} } })
        })).rejects.toThrow()
        await expect(db.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${t.A}, true)`
          return tx.hotel.updateMany({ where: { id: ids.hotelB }, data: { name: 'stolen' } })
        })).resolves.toEqual({ count: 0 })
      } finally { await db.$disconnect() }
    })
  })

  describe('2. every route declares how it authorizes', () => {
    it('inventory is complete and every route is classified', () => {
      expect(routes.length).toBeGreaterThan(250)
      const unclassified = routes.filter((r) => !classify(r)).map((r) => `${r.method} ${r.path} (${r.handler}; guards ${r.guards.join('+') || 'none'})`)
      expect(unclassified).toEqual([])
      for (const r of routes) r.cls = classify(r)
    })

    it('every tenant-scoped route resolves the tenant through TenantContextGuard, never a raw header', () => {
      const tenantScoped = routes.filter((r) => ['booking-scope', 'supplier-membership'].includes(classify(r)!))
      expect(tenantScoped.filter((r) => !r.guards.includes('TenantContextGuard')).map((r) => r.path)).toEqual([])
      // Guard-permission routes either pass TenantContextGuard or use a guard that validates the selected tenant itself (Admin owner/membership, Platform).
      const guarded = routes.filter((r) => classify(r) === 'guard-permission' && !r.guards.includes('TenantContextGuard'))
      expect(guarded.filter((r) => !r.guards.some((g) => g === 'AdminRbacGuard' || g === 'PlatformRbacGuard')).map((r) => r.path)).toEqual([])
    })

    it('every public route is on the explicit allowlist', () => {
      expect(routes.filter((r) => classify(r) === 'public').map((r) => `${r.method} ${r.path}`).sort()).toEqual([...PUBLIC_ROUTES].sort())
    })
  })

  describe('3. an authenticated member with no permission is refused everywhere', () => {
    it('every non-public, non-self route answers 401/403 to a zero-permission member, and 401 without a session', async () => {
      const fake = 'c' + randomBytes(12).toString('hex')
      const leaks: string[] = []
      for (const r of routes) {
        const id = `${r.method} ${r.path}`
        if (classify(r) === 'public' || ZERO_PERMISSION_ALLOWED.has(id)) continue
        const url = `/api/v1${r.path.replace(/:[A-Za-z]+/g, fake)}`
        const call = (http() as unknown as Record<string, (u: string) => request.Test>)[r.method.toLowerCase()](url)
        const anonymous = await (http() as unknown as Record<string, (u: string) => request.Test>)[r.method.toLowerCase()](url).set('Origin', origin).send({})
        if (anonymous.status !== 401) leaks.push(`${id}: anonymous ${anonymous.status}`)
        const res = await as('zero', call).send({})
        if (res.status !== 403) leaks.push(`${id}: zero-permission ${res.status}`)
      }
      expect(leaks).toEqual([])
    }, 300_000)

    it('a zero-permission refusal is audited as a denial in the caller tenant', async () => {
      const before = await owner.auditEvent.count({ where: { tenantId: t.A, userId: userIds.zero, action: 'permission.denied' } })
      await as('zero', http().get('/api/v1/agent/audit')).expect(403)
      await as('zero', http().post('/api/v1/supply/hotels')).send({ name: 'x' }).expect(403)
      expect(await owner.auditEvent.count({ where: { tenantId: t.A, userId: userIds.zero, action: 'permission.denied' } })).toBeGreaterThanOrEqual(before + 2)
    })
  })

  describe('4. cross-tenant denial', () => {
    it('Admin: positive control on own tenant; another tenant is refused by header, by id and by body', async () => {
      await as('adminA', http().get(`/api/v1/supply/hotels/${ids.hotelA}`)).expect(200)
      await as('adminA', http().get(`/api/v1/admin/hotels/${ids.hotelA}/setup`)).expect(200)
      await as('adminA', http().get(`/api/v1/admin/operations/bookings/${ids.bookingA}`)).expect(200)
      // Selecting a tenant the session has no membership in.
      await as('adminA', http().get('/api/v1/supply/hotels'), t.B).expect(403)
      await as('adminA', http().get(`/api/v1/supply/hotels/${ids.hotelB}`), t.B).expect(403)
      // Another tenant's ids inside the caller's own tenant are simply not there.
      await as('adminA', http().get(`/api/v1/supply/hotels/${ids.hotelB}`)).expect(404)
      await as('adminA', http().get(`/api/v1/supply/suppliers/${ids.supplierB}`)).expect(404)
      await as('adminA', http().get(`/api/v1/admin/hotels/${ids.hotelB}/setup`)).expect(404)
      await as('adminA', http().get(`/api/v1/admin/operations/bookings/${ids.bookingB}`)).expect(404)
      await as('adminA', http().patch(`/api/v1/supply/hotels/${ids.hotelB}`)).send({ name: `${suffix} stolen` }).expect(404)
      // A body tenantId is never trusted.
      await as('adminA', http().post('/api/v1/supply/hotels')).send({ name: `${suffix} injected`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', tenantId: t.B }).expect(400)
      const list = await as('adminA', http().get('/api/v1/supply/hotels')).expect(200)
      expect(JSON.stringify(list.body)).not.toContain(ids.hotelB)
      expect(await owner.hotel.findUnique({ where: { id: ids.hotelB } })).toMatchObject({ name: `${suffix} Hotel B` })
      expect(await owner.hotel.count({ where: { name: `${suffix} injected` } })).toBe(0)
    })

    it('Agent: positive control on own tenant; another tenant is refused by header and by id', async () => {
      // Booking reads stay behind BOOKING_ENABLED (booking is gated); catalogue content and the audit trail are live on the strict role.
      await as('agentA', http().get(`/api/v1/agent/hotels/${ids.hotelA}/images/${ids.imageA}/content`)).expect(200)
      await as('agentA', http().get(`/api/v1/agent/hotels/${ids.hotelA}/images/${ids.imageA}/content`), t.B).expect(403)
      await as('agentA', http().get(`/api/v1/agent/hotels/${ids.hotelB}/images/${ids.imageB}/content`)).expect(404)
      await as('agentA', http().get(`/api/v1/agent/hotels/${ids.hotelA}/images/${ids.imageB}/content`)).expect(404)
      await as('agentA', http().get('/api/v1/agent/audit'), t.B).expect(403)
      const audit = await as('agentA', http().get('/api/v1/agent/audit')).expect(200)
      expect(JSON.stringify(audit.body)).toContain(t.A)
      expect(JSON.stringify(audit.body)).not.toContain(t.B)
      const context = await as('agentA', http().get('/api/v1/agent/context')).expect(200)
      expect(JSON.stringify(context.body)).not.toContain(t.B)
      await as('agentA', http().delete(`/api/v1/agent/bookings/${ids.bookingB}`)).set('Idempotency-Key', `${suffix}-cancel`).send({}).expect(403)
      expect(await owner.booking.findUnique({ where: { id: ids.bookingB }, select: { status: true } })).toEqual({ status: 'CONFIRMED' })
    })

    it('Supplier: positive control on own organization; another tenant and its supplier are refused', async () => {
      await as('supplierA', http().get(`/api/v1/supplier/extranet/hotels/${ids.hotelA}`)).expect(200)
      await as('supplierA', http().get(`/api/v1/supplier/extranet/bookings/${ids.bookingA}`)).expect(200)
      await as('supplierA', http().get('/api/v1/supplier/extranet/hotels'), t.B).expect(403)
      await as('supplierA', http().get('/api/v1/supplier/extranet/hotels')).set('x-fbeds-supplier-id', ids.supplierB).expect(403)
      await as('supplierA', http().get(`/api/v1/supplier/extranet/hotels/${ids.hotelB}`)).expect(404)
      await as('supplierA', http().get(`/api/v1/supplier/extranet/hotels/${ids.hotelB}/rooms`)).expect(404)
      await as('supplierA', http().get(`/api/v1/supplier/extranet/bookings/${ids.bookingB}`)).expect(404)
      await as('supplierA', http().patch(`/api/v1/supplier/extranet/hotels/${ids.hotelB}/rooms/${ids.roomB}/draft`)).send({ supplierNotes: 'stolen' }).expect(404)
      const list = await as('supplierA', http().get('/api/v1/supplier/extranet/bookings')).expect(200)
      expect(JSON.stringify(list.body)).not.toContain(ids.bookingB)
      expect(await owner.supplierRoomDraft.count({ where: { tenantId: t.B } })).toBe(0)
      // An Admin of tenant A is not a supplier: no supplier membership means no extranet.
      await as('adminA', http().get('/api/v1/supplier/extranet/hotels')).expect(403)
    })

    it('each refused cross-tenant selection is audited against the caller, never written into the other tenant', async () => {
      const before = await owner.auditEvent.count({ where: { tenantId: t.B } })
      await as('adminA', http().get('/api/v1/supply/hotels'), t.B).expect(403)
      expect(await owner.auditEvent.count({ where: { tenantId: t.B } })).toBe(before)
    })
  })

  describe('5. session security', () => {
    it('session cookie is HttpOnly, Secure, SameSite and path-scoped; the token is stored only as a hash', async () => {
      const cookie = await login('victim')
      expect(cookie).toMatch(/HttpOnly/i)
      expect(cookie).toMatch(/Secure/i)
      expect(cookie).toMatch(/SameSite=(Lax|Strict)/i)
      expect(cookie).toMatch(/Path=\//)
      const raw = cookies.victim.split('=')[1]
      const stored = await owner.session.findMany({ where: { userId: userIds.victim } })
      expect(stored.some((s) => s.tokenHash === hashSessionToken(raw))).toBe(true)
      expect(JSON.stringify(stored)).not.toContain(raw)
    })

    it('identity comes only from the cookie: no cookie, a forged cookie, a bearer token or a user header are refused', async () => {
      await http().get('/api/v1/auth/me').expect(401)
      await http().get('/api/v1/auth/me').set('Cookie', `fbeds_session=${randomBytes(32).toString('hex')}`).expect(401)
      await http().get('/api/v1/auth/me').set('Cookie', 'fbeds_session=not-a-token').expect(401)
      await http().get('/api/v1/auth/me').set('Authorization', `Bearer ${cookies.adminA.split('=')[1]}`).expect(401)
      await http().get('/api/v1/auth/me').set('x-user-id', userIds.adminA).expect(401)
    })

    it('logout revokes server-side: the old cookie no longer authenticates', async () => {
      await login('victim')
      const old = cookies.victim
      await http().get('/api/v1/auth/me').set('Cookie', old).expect(200)
      await http().post('/api/v1/auth/logout').set('Cookie', old).set('Origin', origin).expect(200)
      await http().get('/api/v1/auth/me').set('Cookie', old).expect(401)
    })

    it('expired sessions, suspended users and revoked memberships lose access immediately', async () => {
      await login('victim')
      const raw = cookies.victim.split('=')[1]
      await owner.session.update({ where: { tokenHash: hashSessionToken(raw) }, data: { expiresAt: new Date(Date.now() - 1000) } })
      await http().get('/api/v1/auth/me').set('Cookie', cookies.victim).expect(401)

      await login('victim')
      await owner.user.update({ where: { id: userIds.victim }, data: { status: 'SUSPENDED' } })
      await http().get('/api/v1/auth/me').set('Cookie', cookies.victim).expect(401)
      await http().post('/api/v1/auth/login').set('Origin', origin).send({ email: email('victim'), password }).expect(401)
      await owner.user.update({ where: { id: userIds.victim }, data: { status: 'ACTIVE' } })

      // A revoked membership: the session still authenticates, but the tenant is gone from it.
      await login('supplierB')
      await as('supplierB', http().get('/api/v1/supplier/extranet/hotels')).expect(200)
      await owner.membership.update({ where: { userId_tenantId: { userId: userIds.supplierB, tenantId: t.B } }, data: { revokedAt: new Date() } })
      await as('supplierB', http().get('/api/v1/supplier/extranet/hotels')).expect(403)
      await as('supplierB', http().get('/api/v1/supplier/extranet/hotels'), t.B).expect(403)
      await owner.membership.update({ where: { userId_tenantId: { userId: userIds.supplierB, tenantId: t.B } }, data: { revokedAt: null } })
    })

    it('unsafe requests from an untrusted origin are refused before authorization', async () => {
      await http().post('/api/v1/supply/hotels').set('Cookie', cookies.adminA).set('Origin', 'https://evil.example').send({ name: 'x' }).expect(403)
      await http().post('/api/v1/auth/login').set('Origin', 'https://evil.example').send({ email: email('adminA'), password }).expect(403)
    })

    it('login failures are generic and audited without the password', async () => {
      const unknown = await http().post('/api/v1/auth/login').set('Origin', origin).send({ email: `${suffix}-nobody@example.test`, password: 'wrong-password-123' }).expect(401)
      const wrong = await http().post('/api/v1/auth/login').set('Origin', origin).send({ email: email('adminA'), password: 'wrong-password-123' }).expect(401)
      expect(unknown.body.message ?? unknown.body.error?.message).toEqual(wrong.body.message ?? wrong.body.error?.message)
      const failures = await owner.auditEvent.findMany({ where: { userId: userIds.adminA, action: 'auth.login.failure' } })
      expect(failures.length).toBeGreaterThan(0)
      expect(JSON.stringify(failures)).not.toContain('wrong-password-123')
    })
  })

  describe('6. audit logging and privileged write paths', () => {
    it('a privileged write creates an audit event with actor, tenant and request id', async () => {
      const requestId = `${suffix}-audit`
      const created = await as('adminA', http().post('/api/v1/supply/hotels')).set('x-request-id', requestId)
        .send({ name: `${suffix} Audited`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE' }).expect(201)
      const hotelId = created.body.data.id as string
      expect(await owner.hotel.findUnique({ where: { id: hotelId }, select: { tenantId: true } })).toEqual({ tenantId: t.A })
      const events = await owner.auditEvent.findMany({ where: { entityId: hotelId } })
      expect(events).toEqual([expect.objectContaining({ tenantId: t.A, userId: userIds.adminA, actorType: 'USER', action: 'supply.hotel.created' })])
      expect(JSON.stringify(events[0].payload)).toContain(requestId)
      expect(JSON.stringify(events)).not.toContain(password)
    })

    it('the audit log cannot be rewritten or deleted by any restricted login, even in its own tenant', async () => {
      const [event] = await owner.auditEvent.findMany({ where: { tenantId: t.A }, take: 1 })
      for (const [role, key] of [[API_RUNTIME_LOGIN_ROLE, 'api'], [BOOKING_OPS_LOGIN_ROLE, 'booking'], [HOLD_EXPIRY_LOGIN, 'hold'], [TENANT_CONTROL_LOGIN, 'control']] as const) {
        const db = new PrismaClient({ datasourceUrl: loginUrl(role, passwords[key]) })
        try {
          const inTenant = <T>(sql: string) => db.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${t.A}, true)`
            return tx.$executeRawUnsafe<T>(sql)
          })
          await expect(inTenant(`UPDATE "AuditEvent" SET action = 'tampered' WHERE id = '${event.id}'`)).rejects.toThrow(/permission denied/)
          await expect(inTenant(`DELETE FROM "AuditEvent" WHERE id = '${event.id}'`)).rejects.toThrow(/permission denied/)
          await expect(inTenant(`TRUNCATE "AuditEvent"`)).rejects.toThrow(/permission denied/)
        } finally { await db.$disconnect() }
      }
      expect(await owner.auditEvent.findUnique({ where: { id: event.id } })).toMatchObject({ action: event.action })
    })

    it('privileged financial and supply-authoring tables are not writable by the HTTP runtime role', async () => {
      const db = new PrismaClient({ datasourceUrl: loginUrl(API_RUNTIME_LOGIN_ROLE, passwords.api) })
      try {
        const [row] = await db.$queryRawUnsafe<Array<Record<string, boolean>>>(`SELECT
          has_table_privilege('"LedgerEntry"', 'INSERT') AS ledger, has_table_privilege('"Wallet"', 'INSERT') OR has_any_column_privilege('"Wallet"', 'UPDATE') AS wallet,
          has_table_privilege('"Booking"', 'INSERT') OR has_any_column_privilege('"Booking"', 'UPDATE') AS booking,
          has_table_privilege('"DailyRate"', 'INSERT') OR has_any_column_privilege('"DailyRate"', 'UPDATE') AS rate,
          has_table_privilege('"PlatformRoleAssignment"', 'INSERT') AS platform, has_table_privilege('memberships', 'INSERT') OR has_any_column_privilege('memberships', 'UPDATE') AS membership,
          has_table_privilege('"UserRole"', 'INSERT') AS "userRole", has_table_privilege('"RolePermission"', 'INSERT') AS "rolePermission"`)
        expect(row).toEqual({ ledger: false, wallet: false, booking: false, rate: false, platform: false, membership: false, userRole: false, rolePermission: false })
      } finally { await db.$disconnect() }
    })
  })
})
