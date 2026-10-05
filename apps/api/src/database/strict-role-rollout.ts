/**
 * Read-only rollout checks for the strict API runtime role (ADR 0032, ADR 0036 Amendment 1).
 *
 * `status` (owner credential) answers: which migrations are pending or unfinished, does the group role exist, and how do its live grants differ
 * from the single contract. `verify` (runtime login credential) runs the role verifier and a set of privilege probes. Neither writes: the probes
 * are statements with `WHERE false` inside rolled-back transactions, so only the privilege check is exercised. Applying anything stays with
 * `prisma migrate deploy` and `ops:provision-api-runtime-role`, run by the database owner (docs/runbooks/strict-role-rollout.md).
 */
import { API_RUNTIME_GROUP_ROLE, API_RUNTIME_LOGIN_ROLE, inspectRuntimePrivileges, verifyApiRuntimeRole } from './api-runtime-role'

type Reader = { $queryRawUnsafe<T = unknown>(query: string): Promise<T> }
type Transactional = Reader & { $transaction<T>(fn: (tx: Reader & { $executeRawUnsafe(q: string): Promise<number> }) => Promise<T>): Promise<T> }

/** The migration that leaves the pool capacity grants in their final form (it follows 202610260001_strict_runtime_role_pool_capacity). */
export const ROLLOUT_MIGRATION = '202610270001_strict_runtime_role_pool_freshness'

export interface MigrationRow { migration_name: string; finished_at: Date | string | null; rolled_back_at: Date | string | null }
export interface MigrationState {
  applied: string[]
  pending: string[]
  /** Started, never finished, not rolled back: Prisma refuses to continue until a person resolves it. */
  unfinished: string[]
  /** Recorded in the database but not in this repository. */
  unknown: string[]
  /** Rows an earlier repair marked rolled back: reported, ignored. */
  rolledBack: string[]
}

/** Prisma's own view: a row counts when it finished and was not rolled back. Pure. */
export function classifyMigrations(repoNames: readonly string[], rows: readonly MigrationRow[]): MigrationState {
  const repo = new Set(repoNames)
  const applied = new Set<string>(); const unfinished = new Set<string>(); const unknown = new Set<string>(); const rolledBack = new Set<string>()
  for (const row of rows) {
    if (row.rolled_back_at) { rolledBack.add(row.migration_name); continue }
    if (!repo.has(row.migration_name)) unknown.add(row.migration_name)
    if (row.finished_at) applied.add(row.migration_name); else unfinished.add(row.migration_name)
  }
  for (const name of applied) unfinished.delete(name) // a retried migration that later finished
  return {
    applied: [...applied].filter((n) => repo.has(n)).sort(),
    pending: [...repo].filter((n) => !applied.has(n)).sort(),
    unfinished: [...unfinished].sort(), unknown: [...unknown].sort(), rolledBack: [...rolledBack].sort(),
  }
}

/** Neon (and similar) pooled endpoints cannot run migrations or session-level role statements reliably. */
export const isPooledHost = (hostname: string): boolean => /-pooler\.|pgbouncer|\.pooler\./i.test(hostname)

export interface RoleState { groupExists: boolean; loginRoles: Array<{ role: string; canLogin: boolean; superuser: boolean; bypassRls: boolean }> }

export interface RolloutStatus {
  verdict: 'READY' | 'BLOCKED'
  blockers: string[]
  migrations: MigrationState
  roles: RoleState
  /** Differences between the live grants of the group role and the contract (empty when it already matches). */
  grantDrift: string[]
  steps: string[]
}

export async function readRoleState(db: Reader): Promise<RoleState> {
  const group = await db.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM pg_roles WHERE rolname = '${API_RUNTIME_GROUP_ROLE}'`)
  const logins = await db.$queryRawUnsafe<Array<{ role: string; canLogin: boolean; superuser: boolean; bypassRls: boolean }>>(
    `SELECT r.rolname AS role, r.rolcanlogin AS "canLogin", r.rolsuper AS superuser, r.rolbypassrls AS "bypassRls"
       FROM pg_roles r JOIN pg_auth_members m ON m.member = r.oid JOIN pg_roles g ON g.oid = m.roleid AND g.rolname = '${API_RUNTIME_GROUP_ROLE}' ORDER BY 1`).catch(() => [])
  return { groupExists: Number(group[0]?.n ?? 0) > 0, loginRoles: logins }
}

/** Owner-side, read-only. `repoMigrations` is the committed migration directory listing. */
export async function rolloutStatus(db: Reader, repoMigrations: readonly string[], opts: { host: string; loginRole?: string }): Promise<RolloutStatus> {
  const blockers: string[] = []
  if (isPooledHost(opts.host)) blockers.push('the connection string is a pooled endpoint: use the direct (non-pooled) owner connection')
  const rows = await db.$queryRawUnsafe<MigrationRow[]>('SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations"')
  const migrations = classifyMigrations(repoMigrations, rows)
  if (migrations.unfinished.length) blockers.push(`unfinished migrations must be resolved first (docs/production-migration-repair-runbook-2026-09-27.md): ${migrations.unfinished.join(', ')}`)
  if (migrations.unknown.length) blockers.push(`the database records migrations this repository does not have: ${migrations.unknown.join(', ')}`)
  const roles = await readRoleState(db)
  // Only the role the API connects as must be unprivileged. The owner usually holds an administrative membership of the group role it created; that adds nothing to the group's grants.
  const apiLogin = opts.loginRole ?? API_RUNTIME_LOGIN_ROLE
  for (const l of roles.loginRoles.filter((r) => r.role === apiLogin)) {
    if (l.superuser || l.bypassRls) blockers.push(`login role ${l.role} is SUPERUSER or BYPASSRLS: it must not be used by the API`)
  }
  let grantDrift: string[] = []
  if (roles.groupExists) {
    const { problems } = await inspectRuntimePrivileges(db, undefined, API_RUNTIME_GROUP_ROLE)
    grantDrift = problems.map((p) => p.message).sort()
  }
  const steps: string[] = []
  if (migrations.pending.length) steps.push(`prisma migrate deploy (pending: ${migrations.pending.join(', ')})`)
  if (!roles.groupExists) steps.push('ops:provision-api-runtime-role (creates the group role, the login role and the contract grants)')
  else if (grantDrift.length || migrations.pending.includes(ROLLOUT_MIGRATION)) steps.push('ops:provision-api-runtime-role (idempotent: REVOKE ALL then exactly the contract; rotates the login password)')
  steps.push('ops:strict-role-rollout verify with the runtime login URL, then deploy the API')
  return { verdict: blockers.length ? 'BLOCKED' : 'READY', blockers, migrations, roles, grantDrift, steps }
}

export interface ProbeResult { name: string; expected: 'allowed' | 'denied'; actual: 'allowed' | 'denied' | `error: ${string}`; ok: boolean }

/** Statements that only exercise privileges: `WHERE false` means no row is read or written, and each runs in a transaction that is rolled back. */
export const PRIVILEGE_PROBES: ReadonlyArray<{ name: string; sql: string; expected: 'allowed' | 'denied' }> = [
  { name: 'UPDATE InventoryPoolDay.capacity', sql: `UPDATE "InventoryPoolDay" SET "capacity" = "capacity", "updated_at" = now() WHERE false`, expected: 'allowed' },
  { name: 'UPDATE InventoryPoolDay.sold', sql: `UPDATE "InventoryPoolDay" SET "sold" = "sold" WHERE false`, expected: 'denied' },
  { name: 'UPDATE InventoryPoolDay.held', sql: `UPDATE "InventoryPoolDay" SET "held" = "held" WHERE false`, expected: 'denied' },
  { name: 'UPDATE InventoryPoolDay.tenant_id', sql: `UPDATE "InventoryPoolDay" SET "tenant_id" = "tenant_id" WHERE false`, expected: 'denied' },
  { name: 'INSERT InventoryPoolDay', sql: `INSERT INTO "InventoryPoolDay" ("id") SELECT 'x' WHERE false`, expected: 'denied' },
  { name: 'DELETE InventoryPoolDay', sql: `DELETE FROM "InventoryPoolDay" WHERE false`, expected: 'denied' },
  { name: 'UPDATE InventoryHold', sql: `UPDATE "InventoryHold" SET "status" = "status" WHERE false`, expected: 'denied' },
  { name: 'SELECT granted InventoryHold columns', sql: `SELECT "id", "tenant_id", "rate_plan_id", "status" FROM "InventoryHold" WHERE false`, expected: 'allowed' },
  { name: 'SELECT granted InventoryHoldNight columns', sql: `SELECT "tenant_id", "hold_id", "pool_day_id", "counter_kind", "quantity" FROM "InventoryHoldNight" WHERE false`, expected: 'allowed' },
  { name: 'SELECT InventoryHold.sell_amount_minor', sql: `SELECT "sell_amount_minor" FROM "InventoryHold" WHERE false`, expected: 'denied' },
  { name: 'SELECT * FROM InventoryHold', sql: `SELECT * FROM "InventoryHold" WHERE false`, expected: 'denied' },
  { name: 'SELECT Booking', sql: `SELECT 1 FROM "Booking" WHERE false`, expected: 'denied' },
]

export async function runPrivilegeProbes(db: Transactional): Promise<ProbeResult[]> {
  const out: ProbeResult[] = []
  const ROLLBACK = Symbol('rollback')
  for (const probe of PRIVILEGE_PROBES) {
    let actual: ProbeResult['actual']
    try {
      await db.$transaction(async (tx) => { await tx.$executeRawUnsafe(probe.sql); throw ROLLBACK })
      actual = 'allowed'
    } catch (error) {
      if (error === ROLLBACK) actual = 'allowed'
      else {
        const message = error instanceof Error ? error.message : String(error)
        actual = /permission denied|42501/i.test(message) ? 'denied' : `error: ${message.replace(/\s+/g, ' ').slice(0, 100)}`
      }
    }
    out.push({ name: probe.name, expected: probe.expected, actual, ok: actual === probe.expected })
  }
  return out
}

export interface VerifyReport { ok: boolean; roleFailures: string[]; probes: ProbeResult[] }

export async function rolloutVerify(db: Transactional): Promise<VerifyReport> {
  const role = await verifyApiRuntimeRole(db as never)
  const probes = await runPrivilegeProbes(db)
  return { ok: role.ok && probes.every((p) => p.ok), roleFailures: role.failures, probes }
}
