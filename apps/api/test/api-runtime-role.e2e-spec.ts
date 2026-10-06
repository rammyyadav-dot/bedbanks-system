import { randomBytes } from 'crypto'
import { mkdirSync, writeFileSync } from 'fs'
import { INestApplication, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { PrismaClient, type Prisma } from '@prisma/client'
import * as cookieParser from 'cookie-parser'
import * as request from 'supertest'
import { AppModule } from '../src/app.module'
import { provisionApiRuntimeRole, verifyApiRuntimeRole, API_RUNTIME_LOGIN_ROLE } from '../src/database/api-runtime-role'
import { RUNTIME_ROLE_GRANTS } from '../src/database/runtime-role-contract'
import { hashPassword } from '../src/auth/utils/password'
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor'

const ownerUrl = process.env.DATABASE_URL
if (!ownerUrl) throw new Error('DATABASE_URL is required')
const owner = new PrismaClient({ datasourceUrl: ownerUrl })

function runtimeDatabaseUrl(password: string): string {
  const url = new URL(ownerUrl!)
  url.username = API_RUNTIME_LOGIN_ROLE
  url.password = password
  return url.toString()
}

describe('API runtime login role', () => {
  const suffix = `api-role-${Date.now()}-${randomBytes(3).toString('hex')}`
  const password = process.env.API_RUNTIME_LOGIN_PASSWORD ?? randomBytes(24).toString('hex')
  const origin = 'http://localhost:3001'
  const agentPassword = 'api-runtime-role-password'
  let runtime: PrismaClient
  let previousDatabaseUrl: string | undefined
  let app: INestApplication | undefined
  let tenantA: { id: string }
  let tenantB: { id: string }
  let hotelA: { id: string }
  let hotelB: { id: string }

  beforeAll(async () => {
    await owner.$connect()
    await provisionApiRuntimeRole(owner, { password })
    runtime = new PrismaClient({ datasourceUrl: runtimeDatabaseUrl(password) })
    await runtime.$connect()
    tenantA = await owner.tenant.create({ data: { name: `${suffix} A`, slug: `${suffix}-a` } })
    tenantB = await owner.tenant.create({ data: { name: `${suffix} B`, slug: `${suffix}-b` } })
    hotelA = await owner.hotel.create({ data: { tenantId: tenantA.id, name: `${suffix} A`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE' } })
    hotelB = await owner.hotel.create({ data: { tenantId: tenantB.id, name: `${suffix} B`, propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE' } })
    const user = await owner.user.create({ data: { email: `${suffix}@example.test`, passwordHash: await hashPassword(agentPassword), status: 'ACTIVE' } })
    await owner.membership.create({ data: { userId: user.id, tenantId: tenantA.id, role: 'agent' } })
  })

  afterAll(async () => {
    if (app) await app.close()
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previousDatabaseUrl
    await owner.hotel.deleteMany({ where: { name: { startsWith: suffix } } })
    await owner.session.deleteMany({ where: { user: { email: `${suffix}@example.test` } } })
    await owner.user.deleteMany({ where: { email: `${suffix}@example.test` } })
    await owner.tenant.deleteMany({ where: { slug: { in: [`${suffix}-a`, `${suffix}-b`] } } })
    await runtime?.$disconnect()
    await owner.$disconnect()
  })

  async function asRuntime<T>(tenantId: string | null, work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return runtime.$transaction(async (tx) => {
      const [who] = await tx.$queryRawUnsafe<Array<{ current_user: string }>>('SELECT current_user')
      if (who?.current_user !== API_RUNTIME_LOGIN_ROLE) throw new Error(`expected ${API_RUNTIME_LOGIN_ROLE}, connected as ${who?.current_user ?? 'unknown'}`)
      if (tenantId) await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`
      return work(tx)
    })
  }

  it('every tenant table in the runtime contract has enabled and forced RLS', async () => {
    const rows = await runtime.$queryRawUnsafe<Array<{ name: string; enabled: boolean; forced: boolean }>>(
      `SELECT c.relname AS name, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relkind IN ('r','p')`,
    )
    for (const grant of RUNTIME_ROLE_GRANTS.filter((g) => g.rls === 'forced-tenant')) {
      expect({ table: grant.table, security: rows.find((r) => r.name === grant.table) }).toEqual({ table: grant.table, security: { name: grant.table, enabled: true, forced: true } })
    }
  })

  it('RolePermission is tenant-scoped on a reused strict-login connection, including absent context', async () => {
    const permission = await owner.permission.create({ data: { key: `${suffix}.rls`, description: 'Synthetic RLS probe' } })
    const roles: string[] = []
    const url = new URL(runtimeDatabaseUrl(password)); url.searchParams.set('connection_limit', '1')
    const single = new PrismaClient({ datasourceUrl: url.toString() })
    try {
      for (const tenantId of [tenantA.id, tenantB.id]) {
        const role = await owner.role.create({ data: { tenantId, name: `${suffix}-rls` } }); roles.push(role.id)
        await owner.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } })
      }
      const read = (tenantId: string | null) => single.$transaction(async (tx) => {
        if (tenantId) await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`
        const [identity] = await tx.$queryRawUnsafe<Array<{ principal: string; pid: number }>>('SELECT current_user AS principal, pg_backend_pid() AS pid')
        expect(identity.principal).toBe(API_RUNTIME_LOGIN_ROLE)
        return { pid: identity.pid, rows: await tx.rolePermission.findMany({ where: { roleId: { in: roles } }, select: { roleId: true } }) }
      })
      const a = await read(tenantA.id), none = await read(null), b = await read(tenantB.id), noneAgain = await read(null)
      expect(a.rows).toEqual([{ roleId: roles[0] }]); expect(b.rows).toEqual([{ roleId: roles[1] }])
      expect(none.rows).toEqual([]); expect(noneAgain.rows).toEqual([])
      expect(new Set([a.pid, none.pid, b.pid, noneAgain.pid]).size).toBe(1)
    } finally {
      await single.$disconnect()
      await owner.role.deleteMany({ where: { id: { in: roles } } })
      await owner.permission.delete({ where: { id: permission.id } })
    }
  })

  it('connects as the non-bypass login role and isolates hotel rows', async () => {
    const report = await verifyApiRuntimeRole(runtime)
    expect(report).toEqual({ ok: true, failures: [] })
    const visible = await asRuntime(tenantA.id, (tx) => tx.hotel.findMany({ where: { name: { startsWith: suffix } } }))
    expect(visible.map((hotel) => hotel.id)).toEqual([hotelA.id])
    expect(await asRuntime(null, (tx) => tx.hotel.findMany({ where: { name: { startsWith: suffix } } }))).toEqual([])
    // `name` is in the Hotel column write set (ADR 0032), so the privilege layer allows the statement and row-level security makes it match nothing.
    expect(await asRuntime(tenantA.id, (tx) => tx.hotel.updateMany({ where: { id: hotelB.id }, data: { name: `${suffix} stolen` } }))).toEqual({ count: 0 })
    // A column outside the write set is refused by privilege, whatever the tenant.
    await expect(asRuntime(tenantA.id, (tx) => tx.hotel.updateMany({ where: { id: hotelA.id }, data: { externalRef: `${suffix}-x` } }))).rejects.toThrow()
    expect(await owner.hotel.findUnique({ where: { id: hotelB.id } })).toMatchObject({ name: `${suffix} B` })

    const [attrs] = await runtime.$queryRawUnsafe<Array<{ rolsuper: boolean; rolbypassrls: boolean; rolcanlogin: boolean; owned: number }>>(
      `SELECT r.rolsuper, r.rolbypassrls, r.rolcanlogin,
              (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public' AND c.relkind = 'r' AND pg_get_userbyid(c.relowner) = r.rolname) AS owned
         FROM pg_roles r WHERE r.rolname = current_user`)
    mkdirSync('/opt/cursor/artifacts', { recursive: true })
    writeFileSync('/opt/cursor/artifacts/rls-runtime-role.json', JSON.stringify({
      role: API_RUNTIME_LOGIN_ROLE,
      ...attrs,
      owner: false,
      httpRuntimeCertification: 'PASS',
      reason: 'Direct connection as fbeds_api_login. Tenant A sees only Tenant A. Missing tenant context returns no hotels. Hotel update is rejected.',
    }, null, 2))
  })

  it('serves login and /auth/me through Nest on that role', async () => {
    previousDatabaseUrl = process.env.DATABASE_URL
    process.env.DATABASE_URL = runtimeDatabaseUrl(password)
    process.env.ADMIN_ORIGIN = origin
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication()
    app.use(cookieParser())
    app.setGlobalPrefix('api/v1')
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
    app.useGlobalInterceptors(new ResponseInterceptor())
    await app.init()

    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', origin)
      .send({ email: `${suffix}@example.test`, password: agentPassword }).expect(200)
    expect(login.body.data.memberships).toEqual([expect.objectContaining({ tenantId: tenantA.id, role: 'agent' })])
    const cookie = login.headers['set-cookie'][0].split(';')[0]
    const me = await request(app.getHttpServer()).get('/api/v1/auth/me').set('Cookie', cookie).expect(200)
    expect(me.body.data.memberships).toEqual([expect.objectContaining({ tenantId: tenantA.id })])
    await request(app.getHttpServer()).post('/api/v1/agent/search').set('Cookie', cookie).set('Origin', origin)
      .send({ destination: 'Dubai', checkIn: '2026-10-15', checkOut: '2026-10-18', rooms: 1, adults: 2, children: 0, childAges: [], nationality: 'IN', currency: 'AED' })
      .expect(403)
  })
})
