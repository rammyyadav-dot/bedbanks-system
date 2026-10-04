import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { API_RUNTIME_GROUP_ROLE, API_RUNTIME_LOGIN_ROLE, provisionApiRuntimeRole, verifyApiRuntimeRole } from '../src/database/api-runtime-role'
import { RUNTIME_ROLE_GRANTS } from '../src/database/runtime-role-contract'

const ownerUrl = process.env.DATABASE_URL
if (!ownerUrl) throw new Error('DATABASE_URL (the disposable owner connection) is required')

/** Admin authoring tables (plus SupplierMutation) that earlier migrations made writable for the runtime role (ADR 0031). */
const AUTHORING_TABLES = ['Hotel', 'RoomType', 'Agency', 'AgencyCreditLimit', 'AgencyMember', 'ApprovalRequest', 'CommercialMarkupRule', 'DistributionRestriction', 'HotelAmenity', 'HotelExternalIdentifier', 'HotelImage', 'HotelProfile', 'InventoryPool', 'InventoryPoolDay', 'RoomAmenity', 'ServiceCase', 'ServiceCaseNote', 'SupplierMutation']
/** The contract's privileges for a table, in the shape `snapshot` reports (column-level INSERT/UPDATE show as the privilege). */
const contractPrivileges = (table: string): string[] => {
  const grant = RUNTIME_ROLE_GRANTS.find((g) => g.table === table)
  if (!grant) return []
  return [...(grant.read ? ['SELECT'] : []), ...new Set(grant.writes.map((w) => w.op as string))].sort()
}

const urlFor = (database: string) => { const url = new URL(ownerUrl); url.pathname = `/${database}`; return url.toString() }
const migrationsDir = join(__dirname, '..', 'prisma', 'migrations')

function deploy(schemaPath: string, databaseUrl: string): void {
  const result = spawnSync('npx', ['prisma', 'migrate', 'deploy', `--schema=${schemaPath}`], { env: { ...process.env, DATABASE_URL: databaseUrl }, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`prisma migrate deploy failed: ${(result.stderr || result.stdout).split('\n').filter((l) => /error|failed/i.test(l)).slice(0, 3).join(' | ')}`)
}

/** Every INSERT/UPDATE/DELETE/TRUNCATE/SELECT the group role holds on public tables, as a sorted, comparable map. */
async function snapshot(db: PrismaClient): Promise<Record<string, string[]>> {
  const rows = await db.$queryRawUnsafe<Array<{ tbl: string; priv: string }>>(
    `SELECT c.relname AS tbl, p.priv
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) p(priv)
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND c.relname <> '_prisma_migrations'
        AND (CASE WHEN p.priv IN ('SELECT','INSERT','UPDATE') THEN has_any_column_privilege('${API_RUNTIME_GROUP_ROLE}', c.oid, p.priv) ELSE has_table_privilege('${API_RUNTIME_GROUP_ROLE}', c.oid, p.priv) END)
      ORDER BY 1, 2`)
  const out: Record<string, string[]> = {}
  for (const row of rows) (out[row.tbl] ??= []).push(row.priv)
  return out
}

describe('migration replay, upgrade and provisioning converge on the strict runtime-role contract (PostgreSQL)', () => {
  const suffix = `${Date.now()}_${randomBytes(3).toString('hex')}`
  const replayDb = `p05_replay_${suffix}`
  const upgradeDb = `p05_upgrade_${suffix}`
  const admin = new PrismaClient({ datasourceUrl: ownerUrl })
  const work = mkdtempSync(join(tmpdir(), 'p05-prior-'))
  const password = randomBytes(24).toString('hex')
  let replay: PrismaClient; let upgrade: PrismaClient
  let beforeLatest: Record<string, string[]>

  beforeAll(async () => {
    await admin.$executeRawUnsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${API_RUNTIME_GROUP_ROLE}') THEN CREATE ROLE "${API_RUNTIME_GROUP_ROLE}" NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$`)
    await admin.$executeRawUnsafe(`CREATE DATABASE "${replayDb}"`)
    await admin.$executeRawUnsafe(`CREATE DATABASE "${upgradeDb}"`)
    // The preceding committed schema: every migration before the two P0.5 role migrations, applied while the group role already exists (the order that left the over-grants).
    const all = readdirSync(migrationsDir).filter((d) => d !== 'migration_lock.toml').sort()
    cpSync(join(__dirname, '..', 'prisma', 'schema.prisma'), join(work, 'schema.prisma'))
    cpSync(join(migrationsDir, 'migration_lock.toml'), join(work, 'migrations', 'migration_lock.toml'))
    for (const dir of all.slice(0, all.indexOf('202610170001_strict_runtime_role_contract'))) cpSync(join(migrationsDir, dir), join(work, 'migrations', dir), { recursive: true })
    deploy(join(work, 'schema.prisma'), urlFor(upgradeDb))
    upgrade = new PrismaClient({ datasourceUrl: urlFor(upgradeDb) }); await upgrade.$connect()
    beforeLatest = await snapshot(upgrade)
    deploy(join('prisma', 'schema.prisma'), urlFor(upgradeDb))
    deploy(join('prisma', 'schema.prisma'), urlFor(replayDb))
    replay = new PrismaClient({ datasourceUrl: urlFor(replayDb) }); await replay.$connect()
  }, 600_000)

  afterAll(async () => {
    await replay?.$disconnect(); await upgrade?.$disconnect()
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${replayDb}" WITH (FORCE)`).catch(() => undefined)
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${upgradeDb}" WITH (FORCE)`).catch(() => undefined)
    await admin.$disconnect(); rmSync(work, { recursive: true, force: true })
  })

  it('SR-01 the preceding schema left writable Admin authoring tables on the runtime group role (the defect)', () => {
    const writable = AUTHORING_TABLES.filter((t) => (beforeLatest[t] ?? []).some((p) => ['INSERT', 'UPDATE', 'DELETE'].includes(p)))
    expect(writable.length).toBeGreaterThanOrEqual(10)
  })

  let afterMigration: Record<string, string[]>
  it('SR-02 after the forward migrations, with no provisioning, every affected table holds exactly the contract privileges (and no privileged path holds anything)', async () => {
    for (const [name, db] of [['replay', replay], ['upgrade', upgrade]] as const) {
      const s = await snapshot(db)
      for (const table of AUTHORING_TABLES) expect({ name, table, privileges: s[table] ?? [] }).toEqual({ name, table, privileges: contractPrivileges(table) })
      afterMigration = s
    }
  })

  it('SR-03 replay and upgrade reach the identical grant state before provisioning', async () => {
    expect(await snapshot(upgrade)).toEqual(await snapshot(replay))
  })

  it('SR-04 provisioning yields the identical, contract-only grant state on both, and re-running it changes nothing', async () => {
    await provisionApiRuntimeRole(replay, { password }); await provisionApiRuntimeRole(upgrade, { password })
    const first = await snapshot(replay)
    expect(await snapshot(upgrade)).toEqual(first)
    await provisionApiRuntimeRole(replay, { password }); await provisionApiRuntimeRole(upgrade, { password })
    expect(await snapshot(replay)).toEqual(first)
    expect(await snapshot(upgrade)).toEqual(first)
    // Provisioned state equals the contract for every table, and the migration-time state of the affected tables equals the provisioned state.
    const contractTables = new Set(RUNTIME_ROLE_GRANTS.map((g) => g.table))
    expect(Object.keys(first).filter((t) => !contractTables.has(t))).toEqual([])
    for (const grant of RUNTIME_ROLE_GRANTS) expect({ table: grant.table, privileges: first[grant.table] ?? [] }).toEqual({ table: grant.table, privileges: contractPrivileges(grant.table) })
    for (const table of AUTHORING_TABLES) expect({ table, privileges: afterMigration[table] ?? [] }).toEqual({ table, privileges: first[table] ?? [] })
  })

  it('SR-05 the login role verifies clean, and the verifier names a migration-style over-grant', async () => {
    const login = (database: string) => { const url = new URL(urlFor(database)); url.username = API_RUNTIME_LOGIN_ROLE; url.password = password; return new PrismaClient({ datasourceUrl: url.toString() }) }
    for (const database of [replayDb, upgradeDb]) {
      const runtime = login(database)
      try { expect(await verifyApiRuntimeRole(runtime)).toEqual({ ok: true, failures: [] }) } finally { await runtime.$disconnect() }
    }
    await replay.$executeRawUnsafe(`GRANT DELETE ON "CommercialMarkupRule" TO ${API_RUNTIME_GROUP_ROLE}`)
    const runtime = login(replayDb)
    try {
      const report = await verifyApiRuntimeRole(runtime)
      expect(report.ok).toBe(false)
      expect(report.failures.join(' ')).toMatch(/role holds DELETE on CommercialMarkupRule, which the contract does not grant/)
    } finally { await runtime.$disconnect(); await replay.$executeRawUnsafe(`REVOKE DELETE ON "CommercialMarkupRule" FROM ${API_RUNTIME_GROUP_ROLE}`) }
  })

  it('SR-06 the verifier names a missing mandatory read', async () => {
    await replay.$executeRawUnsafe(`REVOKE SELECT ON "DistributionRestriction" FROM ${API_RUNTIME_GROUP_ROLE}`)
    const url = new URL(urlFor(replayDb)); url.username = API_RUNTIME_LOGIN_ROLE; url.password = password
    const runtime = new PrismaClient({ datasourceUrl: url.toString() })
    try {
      const report = await verifyApiRuntimeRole(runtime)
      expect(report.failures.join(' ')).toMatch(/cannot read required tables: DistributionRestriction/)
    } finally { await runtime.$disconnect(); await replay.$executeRawUnsafe(`GRANT SELECT ON "DistributionRestriction" TO ${API_RUNTIME_GROUP_ROLE}`) }
  })

  it('SR-08 on replay and upgrade: forced row-level security on every writable tenant table, the same-tenant guard triggers installed, and the login role has no elevated attribute', async () => {
    const guarded = ['HotelProfile', 'HotelExternalIdentifier', 'HotelAmenity', 'RoomAmenity', 'HotelImage', 'CommercialMarkupRule', 'DistributionRestriction', 'AgencyMember', 'AgencyCreditLimit', 'ServiceCase', 'ServiceCaseNote']
    const writableTenantTables = RUNTIME_ROLE_GRANTS.filter((g) => g.writes.length && g.rls === 'forced-tenant').map((g) => g.table)
    for (const [name, db] of [['replay', replay], ['upgrade', upgrade]] as const) {
      const rls = await db.$queryRawUnsafe<Array<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>>(`SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN (${writableTenantTables.map((t) => `'${t}'`).join(',')}) AND relkind = 'r'`)
      expect({ name, tables: rls.map((r) => r.relname).sort(), notForced: rls.filter((r) => !r.relrowsecurity || !r.relforcerowsecurity).map((r) => r.relname) }).toEqual({ name, tables: [...writableTenantTables].sort(), notForced: [] })
      const triggers = await db.$queryRawUnsafe<Array<{ tgrelid: string }>>(`SELECT tgrelid::regclass::text AS tgrelid FROM pg_trigger WHERE tgname LIKE '%\\_tenant\\_references' AND NOT tgisinternal`)
      expect({ name, tables: triggers.map((t) => t.tgrelid.replace(/"/g, '')).sort() }).toEqual({ name, tables: [...guarded].sort() })
      const [attrs] = await db.$queryRawUnsafe<Array<{ rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolreplication: boolean }>>(`SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication FROM pg_roles WHERE rolname = '${API_RUNTIME_LOGIN_ROLE}'`)
      expect({ name, attrs }).toEqual({ name, attrs: { rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false } })
    }
  })

  it('SR-07 no committed migration after the last contract migration grants anything to the runtime role (provisioning is the only source of grants)', () => {
    const all = readdirSync(migrationsDir).filter((d) => d !== 'migration_lock.toml').sort()
    const contract = all.indexOf('202610200001_strict_runtime_role_tenant_integrity')
    expect(contract).toBeGreaterThan(-1)
    for (const dir of all.slice(contract + 1)) {
      const sql = readFileSync(join(migrationsDir, dir, 'migration.sql'), 'utf8')
      expect({ dir, grantsRuntimeRole: /GRANT[\s\S]{0,200}fbeds_api\b/i.test(sql.replace(/--[^\n]*/g, '')) }).toEqual({ dir, grantsRuntimeRole: false })
    }
  })
})
