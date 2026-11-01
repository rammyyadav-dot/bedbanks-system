import { randomBytes } from 'crypto'
import { readdirSync } from 'fs'
import { join } from 'path'
import { PrismaClient } from '@prisma/client'
import { API_RUNTIME_LOGIN_ROLE, provisionApiRuntimeRole } from '../src/database/api-runtime-role'
import { ROLLOUT_MIGRATION, rolloutStatus, rolloutVerify } from '../src/database/strict-role-rollout'

const ownerUrl = process.env.DATABASE_URL
if (!ownerUrl) throw new Error('DATABASE_URL (the disposable owner connection) is required')
jest.setTimeout(120_000)

/** Rollout checks against a disposable database: they report accurately and never change anything. */
describe('strict-role rollout status and verify (PostgreSQL, disposable)', () => {
  const owner = new PrismaClient({ datasourceUrl: ownerUrl })
  const repo = readdirSync(join(__dirname, '..', 'prisma', 'migrations'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  const host = new URL(ownerUrl).hostname
  const password = randomBytes(24).toString('hex')
  const loginUrl = () => { const u = new URL(ownerUrl); u.username = API_RUNTIME_LOGIN_ROLE; u.password = password; return u.toString() }
  const fingerprint = async () => (await owner.$queryRawUnsafe<Array<{ h: string }>>(`SELECT md5(string_agg(x, '|' ORDER BY x)) AS h FROM (
      SELECT format('%s:%s:%s', grantee, table_name, privilege_type) AS x FROM information_schema.table_privileges WHERE table_schema = 'public'
      UNION ALL SELECT format('%s:%s:%s:%s', grantee, table_name, column_name, privilege_type) FROM information_schema.column_privileges WHERE table_schema = 'public'
      UNION ALL SELECT format('M:%s', migration_name) FROM "_prisma_migrations"
      UNION ALL SELECT format('R:%s:%s:%s:%s', rolname, rolcanlogin, rolsuper, rolbypassrls) FROM pg_roles WHERE rolname LIKE 'fbeds%') s`))[0].h

  beforeAll(async () => { await owner.$connect(); await provisionApiRuntimeRole(owner, { password }) })
  afterAll(async () => { await owner.$disconnect() })

  it('RO-01 status on a provisioned database is READY with no drift, and writes nothing', async () => {
    const before = await fingerprint()
    const s = await rolloutStatus(owner, repo, { host })
    expect(s).toMatchObject({ verdict: 'READY', blockers: [], grantDrift: [] })
    expect(s.migrations.pending).toEqual([]); expect(s.migrations.applied).toContain(ROLLOUT_MIGRATION)
    expect(s.roles).toMatchObject({ groupExists: true })
    expect(s.roles.loginRoles.map((l) => l.role)).toContain(API_RUNTIME_LOGIN_ROLE)
    expect(await fingerprint()).toBe(before)
  })

  it('RO-02 status names every kind of grant drift and the provisioning step, and still writes nothing', async () => {
    for (const ddl of ['GRANT SELECT ON "InventoryHold" TO fbeds_api', 'GRANT UPDATE ("sold") ON "InventoryPoolDay" TO fbeds_api', 'REVOKE SELECT ("rate_plan_id") ON "InventoryHold" FROM fbeds_api', 'GRANT INSERT ON "InventoryPoolDay" TO fbeds_api']) {
      await owner.$executeRawUnsafe(ddl)
      try {
        const before = await fingerprint()
        const s = await rolloutStatus(owner, repo, { host })
        expect({ ddl, drift: s.grantDrift.length > 0 }).toEqual({ ddl, drift: true })
        expect(s.steps.join(' ')).toMatch(/ops:provision-api-runtime-role/)
        expect(await fingerprint()).toBe(before)
      } finally { await provisionApiRuntimeRole(owner, { password }) }
    }
    expect((await rolloutStatus(owner, repo, { host })).grantDrift).toEqual([])
  })

  it('RO-03 status reports pending, unfinished and unknown migrations and a pooled host as BLOCKED or pending', async () => {
    const s1 = await rolloutStatus(owner, [...repo, '299901010001_not_applied_yet'], { host })
    expect(s1.migrations.pending).toEqual(['299901010001_not_applied_yet']); expect(s1.steps.join(' ')).toMatch(/prisma migrate deploy/)
    const s2 = await rolloutStatus(owner, repo.filter((n) => n !== ROLLOUT_MIGRATION), { host })
    expect(s2.verdict).toBe('BLOCKED'); expect(s2.blockers.join(' ')).toMatch(new RegExp(ROLLOUT_MIGRATION))
    const s3 = await rolloutStatus(owner, repo, { host: 'ep-x-pooler.eu-west-2.aws.neon.tech' })
    expect(s3.verdict).toBe('BLOCKED'); expect(s3.blockers.join(' ')).toMatch(/pooled/)
  })

  it('RO-04 verify as the runtime login passes every probe, and writes nothing', async () => {
    const before = await fingerprint()
    const c = new PrismaClient({ datasourceUrl: loginUrl() })
    try {
      const r = await rolloutVerify(c as never)
      expect(r.roleFailures).toEqual([]); expect(r.probes.filter((p) => !p.ok)).toEqual([]); expect(r.ok).toBe(true)
      expect(r.probes.length).toBeGreaterThan(8)
    } finally { await c.$disconnect() }
    expect(await fingerprint()).toBe(before)
  })

  it('RO-05 verify fails on a broad grant and on a missing grant, naming the probe', async () => {
    for (const [ddl, probe] of [['GRANT SELECT ON "InventoryHold" TO fbeds_api', /sell_amount_minor|SELECT \*/], ['GRANT UPDATE ("sold") ON "InventoryPoolDay" TO fbeds_api', /InventoryPoolDay\.sold/], ['REVOKE UPDATE ("capacity") ON "InventoryPoolDay" FROM fbeds_api', /InventoryPoolDay\.capacity/]] as const) {
      await owner.$executeRawUnsafe(ddl)
      const c = new PrismaClient({ datasourceUrl: loginUrl() })
      try {
        const r = await rolloutVerify(c as never)
        expect({ ddl, ok: r.ok }).toEqual({ ddl, ok: false })
        expect(r.probes.filter((p) => !p.ok).map((p) => p.name).join(' | ') + r.roleFailures.join(' | ')).toMatch(probe)
      } finally { await c.$disconnect(); await provisionApiRuntimeRole(owner, { password }) }
    }
  })
})
