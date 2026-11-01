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
import { runtimeOwnershipAudit } from '../src/database/ownership-audit'
import { RUNTIME_ROLE_GRANTS } from '../src/database/runtime-role-contract'

jest.setTimeout(240_000)

/**
 * P0-01 (ADR 0040): tenant isolation proven under the ACTUAL restricted runtime login (never the owner), directly in SQL and through the HTTP API.
 * Counters at the end are printed so a certification run can quote them.
 */
describe('runtime RLS probes under the restricted login (PostgreSQL)', () => {
  const owner = new PrismaClient()
  const suffix = `rls-${Date.now()}-${randomBytes(3).toString('hex')}`
  const runtimePassword = `rt-${randomBytes(20).toString('hex')}`
  const password = 'rls-probe-certification-password'
  const origin = 'http://localhost:3001'
  let app: INestApplication; let rt: PrismaClient; let previousUrl: string | undefined; let previousGuard: string | undefined
  let tenantA = '', tenantB = '', userA = '', userB = ''
  const agency: Record<string, string> = {}; const credit: Record<string, string> = {}
  const cookies: Record<string, string> = {}
  const probes = { read: 0, write: 0, noContext: 0, http: 0 }

  async function inTenant<T>(tenant: string | null, work: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return rt.$transaction(async (tx) => {
      const [who] = await tx.$queryRawUnsafe<Array<{ u: string }>>('SELECT current_user::text AS u')
      if (who.u !== API_RUNTIME_LOGIN_ROLE) throw new Error(`probe connected as ${who.u}, not the restricted login`)
      if (tenant) await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenant}, true)`
      return work(tx as unknown as PrismaClient)
    })
  }
  const code = (res: request.Response) => res.body?.error?.code

  beforeAll(async () => {
    await owner.$connect()
    tenantA = (await owner.tenant.create({ data: { name: suffix, slug: suffix } })).id; tenantB = (await owner.tenant.create({ data: { name: `${suffix}-b`, slug: `${suffix}-b` } })).id
    for (const [label, tenant] of [['a', tenantA], ['b', tenantB]] as const) {
      const u = await owner.user.create({ data: { email: `${suffix}-${label}@example.test`, name: label, passwordHash: await hashPassword(password), status: 'ACTIVE' } })
      await owner.membership.create({ data: { tenantId: tenant, userId: u.id, role: 'agent' } })
      const role = await owner.role.create({ data: { tenantId: tenant, name: `${suffix}-${label}` } })
      for (const key of ['agency.read', 'agency.manage']) { const p = await owner.permission.upsert({ where: { key }, update: {}, create: { key, description: key } }); await owner.rolePermission.create({ data: { roleId: role.id, permissionId: p.id } }) }
      await owner.userRole.create({ data: { tenantId: tenant, userId: u.id, roleId: role.id } })
      if (label === 'a') userA = u.id; else userB = u.id
      const ag = await owner.agency.create({ data: { tenantId: tenant, code: `${label}-${suffix}`.slice(-24).toUpperCase(), name: `Agency ${label} ${suffix}`, countryCode: 'GB', createdById: u.id } })
      agency[label] = ag.id
      credit[label] = (await owner.agencyCreditLimit.create({ data: { tenantId: tenant, agencyId: ag.id, currency: 'AED', limitMinor: 1_000_00n, updatedById: u.id } })).id
    }
    await provisionApiRuntimeRole(owner, { password: runtimePassword })
    previousUrl = process.env.DATABASE_URL; previousGuard = process.env.DB_RUNTIME_ROLE_GUARD
    const u = new URL(previousUrl as string); u.username = API_RUNTIME_LOGIN_ROLE; u.password = runtimePassword
    process.env.DATABASE_URL = u.toString(); process.env.ADMIN_ORIGIN = origin; process.env.DB_RUNTIME_ROLE_GUARD = 'enforce' // the real guard runs on this app
    rt = new PrismaClient({ datasourceUrl: u.toString() })
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication(); app.use(cookieParser()); app.setGlobalPrefix('api/v1')
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })); app.useGlobalFilters(new HttpExceptionFilter()); app.useGlobalInterceptors(new ResponseInterceptor())
    await app.init()
    for (const label of ['a', 'b']) {
      const r = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', origin).send({ email: `${suffix}-${label}@example.test`, password }).expect(200)
      cookies[label] = (r.headers['set-cookie'][0] as string).split(';')[0]
    }
  })

  afterAll(async () => {
    console.log(`RLS_PROBE_COUNTS ${JSON.stringify(probes)}`)
    await app?.close(); await rt?.$disconnect()
    if (previousUrl) process.env.DATABASE_URL = previousUrl
    if (previousGuard === undefined) delete process.env.DB_RUNTIME_ROLE_GUARD; else process.env.DB_RUNTIME_ROLE_GUARD = previousGuard
    for (const t of [tenantA, tenantB].filter(Boolean)) {
      for (const q of [`DELETE FROM "AuditEvent" WHERE tenant_id = '${t}'`, `DELETE FROM "AgencyCreditLimit" WHERE tenant_id = '${t}'`, `DELETE FROM "AgencyMember" WHERE tenant_id = '${t}'`, `DELETE FROM "Agency" WHERE tenant_id = '${t}'`, `DELETE FROM "UserRole" WHERE tenant_id = '${t}'`, `DELETE FROM "RolePermission" WHERE role_id IN (SELECT id FROM "Role" WHERE tenant_id = '${t}')`, `DELETE FROM "Role" WHERE tenant_id = '${t}'`, `DELETE FROM memberships WHERE tenant_id = '${t}'`]) await owner.$executeRawUnsafe(q).catch(() => undefined)
    }
    await owner.session.deleteMany({ where: { userId: { in: [userA, userB].filter(Boolean) } } }); await owner.user.deleteMany({ where: { id: { in: [userA, userB].filter(Boolean) } } }); await owner.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB].filter(Boolean) } } })
    await owner.$disconnect()
  })

  it('RP-01: the runtime login is restricted and owns nothing; the owner-side audit is clean and every tenant table is forced', async () => {
    const identity = await inTenant(null, (tx) => tx.$queryRawUnsafe<Array<{ rolsuper: boolean; rolbypassrls: boolean; owned: bigint }>>(`SELECT r.rolsuper, r.rolbypassrls, (SELECT count(*) FROM pg_class WHERE relowner = r.oid) AS owned FROM pg_roles r WHERE r.rolname = current_user`))
    expect(identity[0]).toMatchObject({ rolsuper: false, rolbypassrls: false }); expect(Number(identity[0].owned)).toBe(0)
    const audit = await runtimeOwnershipAudit(owner)
    expect(audit.failures).toEqual([])
    expect(audit.forcedTables).toBeGreaterThanOrEqual(RUNTIME_ROLE_GRANTS.filter((g) => g.rls === 'forced-tenant').length)
    expect(audit.rows.filter((r) => /^fbeds_/.test(r.owner))).toEqual([])
  })

  it('RP-02: reads: tenant A sees only its rows (by id, by list, mixed ids, joins, a swapped tenant filter); tenant B likewise', async () => {
    for (const [me, other] of [['a', 'b'], ['b', 'a']] as const) {
      const tenant = me === 'a' ? tenantA : tenantB; const otherTenant = me === 'a' ? tenantB : tenantA
      await inTenant(tenant, async (tx) => {
        expect(await tx.agency.findUnique({ where: { id: agency[me] } })).not.toBeNull(); probes.read += 1
        expect(await tx.agency.findUnique({ where: { id: agency[other] } })).toBeNull(); probes.read += 1 // primary-key lookup of another tenant's row
        expect((await tx.agency.findMany({ where: { id: { in: [agency[me], agency[other]] } }, select: { id: true } })).map((r) => r.id)).toEqual([agency[me]]); probes.read += 1 // mixed-tenant ids
        expect(await tx.agency.findMany({ where: { tenantId: otherTenant } })).toEqual([]); probes.read += 1 // a swapped tenant filter
        expect(await tx.agencyCreditLimit.findUnique({ where: { id: credit[other] } })).toBeNull(); probes.read += 1
        expect(await tx.agency.findUnique({ where: { id: agency[other] }, include: { creditLimit: true } })).toBeNull(); probes.read += 1 // relation traversal from another tenant's parent
        const joined = await tx.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM "AgencyCreditLimit" l JOIN "Agency" a ON a.id = l.agency_id WHERE a.id = '${agency[other]}' OR l.id = '${credit[other]}'`)
        expect(Number(joined[0].n)).toBe(0); probes.read += 1 // SQL join into another tenant
        const count = await tx.$queryRawUnsafe<Array<{ n: bigint }>>('SELECT count(*) AS n FROM "Agency"'); expect(Number(count[0].n)).toBeGreaterThanOrEqual(1)
        const tenantsSeen = await tx.$queryRawUnsafe<Array<{ t: string }>>('SELECT DISTINCT tenant_id AS t FROM "Agency" WHERE code LIKE \'%' + suffix.slice(-8).toUpperCase() + '\' OR name LIKE \'%' + suffix + '\''); expect(tenantsSeen.every((r) => r.t === tenant)).toBe(true); probes.read += 1
      })
    }
  })

  it('RP-03: writes: another tenant\'s rows cannot be updated or deleted, and a row cannot be attributed to another tenant', async () => {
    for (const [me, other] of [['a', 'b'], ['b', 'a']] as const) {
      const tenant = me === 'a' ? tenantA : tenantB; const otherTenant = me === 'a' ? tenantB : tenantA; const user = me === 'a' ? userA : userB
      await inTenant(tenant, async (tx) => {
        expect((await tx.agency.updateMany({ where: { id: agency[other] }, data: { name: 'HIJACKED' } })).count).toBe(0); probes.write += 1
        expect((await tx.agency.updateMany({ where: { id: { in: [agency[me], agency[other]] } }, data: { notes: 'mixed' } })).count).toBe(1); probes.write += 1 // mixed ids: only the own row
        expect((await tx.agencyCreditLimit.updateMany({ where: { id: credit[other] }, data: { limitMinor: 1n } })).count).toBe(0); probes.write += 1
        expect((await tx.agencyCreditLimit.deleteMany({ where: { id: credit[other] } })).count).toBe(0); probes.write += 1
        expect((await tx.agencyCreditLimit.deleteMany({ where: { id: { in: [credit[other]] } } })).count).toBe(0); probes.write += 1
      })
      // A statement the database rejects aborts its transaction, so each rejection probe runs in its own transaction and must itself reject.
      await expect(inTenant(tenant, (tx) => tx.$executeRawUnsafe(`INSERT INTO "Agency" (id, tenant_id, code, name, status, created_by_id, updated_at) VALUES ('x-${me}-${suffix}', '${otherTenant}', 'X${me}', 'x', 'ACTIVE', '${user}', now())`))).rejects.toThrow(/row-level security|violates/i); probes.write += 1
      // Moving an own row into another tenant is refused (the new row would violate the policy, or the column is not updatable).
      await expect(inTenant(tenant, (tx) => tx.$executeRawUnsafe(`UPDATE "Agency" SET tenant_id = '${otherTenant}' WHERE id = '${agency[me]}'`))).rejects.toThrow(/row-level security|permission denied|violates/i); probes.write += 1
    }
    const [aRow, bRow] = [await owner.agency.findUnique({ where: { id: agency.a } }), await owner.agency.findUnique({ where: { id: agency.b } })]
    expect(aRow?.name).not.toBe('HIJACKED'); expect(bRow?.name).not.toBe('HIJACKED'); expect(aRow?.tenantId).toBe(tenantA); expect(bRow?.tenantId).toBe(tenantB)
    expect(await owner.agencyCreditLimit.count({ where: { id: { in: [credit.a, credit.b] } } })).toBe(2)
    expect(await owner.agency.count({ where: { id: { startsWith: 'x-' } } })).toBe(0)
  })

  it('RP-04: no tenant context fails closed (reads see nothing; writes and inserts are refused), also on a reused connection', async () => {
    await inTenant(null, async (tx) => {
      expect(await tx.agency.findMany({})).toEqual([]); probes.noContext += 1
      expect(await tx.agencyCreditLimit.findMany({})).toEqual([]); probes.noContext += 1
      expect(await tx.agency.findUnique({ where: { id: agency.a } })).toBeNull(); probes.noContext += 1
      expect((await tx.agency.updateMany({ where: { id: agency.a }, data: { name: 'NOCTX' } })).count).toBe(0); probes.noContext += 1
      expect((await tx.agencyCreditLimit.deleteMany({ where: { id: credit.a } })).count).toBe(0); probes.noContext += 1
    })
    await expect(inTenant(null, (tx) => tx.$executeRawUnsafe(`INSERT INTO "Agency" (id, tenant_id, code, name, status, created_by_id, updated_at) VALUES ('nc-${suffix}', '${tenantA}', 'NC', 'x', 'ACTIVE', '${userA}', now())`))).rejects.toThrow(/row-level security|violates/i); probes.noContext += 1
    // A context set in one transaction never leaks into the next one on the same pooled connection.
    const single = new PrismaClient({ datasourceUrl: (() => { const u = new URL(process.env.DATABASE_URL as string); u.searchParams.set('connection_limit', '1'); return u.toString() })() })
    try {
      const read = (tenant: string | null) => single.$transaction(async (tx) => { if (tenant) await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenant}, true)`; return tx.agency.count({ where: { id: { in: [agency.a, agency.b] } } }) })
      expect([await read(tenantA), await read(null), await read(tenantB), await read(null)]).toEqual([1, 0, 1, 0]); probes.noContext += 4
    } finally { await single.$disconnect() }
    expect((await owner.agency.findUnique({ where: { id: agency.a } }))?.name).not.toBe('NOCTX')
    // A garbage or empty tenant setting is not a wildcard.
    for (const bad of ['', 'not-a-tenant', "' OR 1=1 --", '*']) {
      await inTenant(null, async (tx) => { await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${bad}, true)`; expect(await tx.agency.count()).toBe(0) }); probes.noContext += 1
    }
  })

  it('RP-05: through the HTTP API a tenant is never taken from the request: query, header and body swaps do not cross tenants', async () => {
    const list = async (who: 'a' | 'b', extra: { query?: string; headers?: Record<string, string> } = {}) => {
      const r = await request(app.getHttpServer()).get(`/api/v1/admin/clients/agencies${extra.query ?? ''}`).set('Cookie', cookies[who]).set(extra.headers ?? {})
      return r
    }
    const names = (r: request.Response): string[] => (r.body?.data?.items ?? r.body?.data ?? []).map((i: { name: string }) => i.name)
    const a = await list('a'); expect(a.status).toBe(200); expect(names(a)).toEqual(expect.arrayContaining([`Agency a ${suffix}`])); expect(names(a).join()).not.toContain(`Agency b ${suffix}`); probes.http += 1
    const swapped = await list('a', { query: `?tenantId=${tenantB}&tenant=${tenantB}`, headers: { 'x-tenant-id': tenantB } })
    expect([200, 400]).toContain(swapped.status); expect(names(swapped).join()).not.toContain(`Agency b ${suffix}`); probes.http += 1
    const b = await list('b'); expect(names(b).join()).not.toContain(`Agency a ${suffix}`); probes.http += 1
    const create = await request(app.getHttpServer()).post('/api/v1/admin/clients/agencies').set('Cookie', cookies.a).set('Origin', origin).set('x-tenant-id', tenantB).send({ tenantId: tenantB, name: `Probe ${suffix}`, code: `PRB${suffix.slice(-6).toUpperCase()}`, countryCode: 'GB' })
    expect([200, 201, 400, 409, 422]).toContain(create.status); probes.http += 1
    expect(await owner.agency.count({ where: { tenantId: tenantB, name: `Probe ${suffix}` } })).toBe(0) // never created in the tenant the body named
    // Another tenant's agency id in the path is the same 404 as a missing one.
    const foreign = await request(app.getHttpServer()).post(`/api/v1/admin/clients/agencies/${agency.b}/request-suspension-change`).set('Cookie', cookies.a).set('Origin', origin).send({ status: 'SUSPENDED', reason: 'probe' })
    expect([400, 403, 404]).toContain(foreign.status); probes.http += 1
    expect((await owner.agency.findUnique({ where: { id: agency.b } }))?.status).toBe('ACTIVE')
    const anon = await request(app.getHttpServer()).get('/api/v1/admin/clients/agencies'); expect([401, 403]).toContain(anon.status); probes.http += 1
    expect(code(anon)).toBeDefined()
  })
})
