// P0-01 (ADR 0040): the process that serves requests must be a restricted database login. It can never be the migration owner, a superuser, a BYPASSRLS role or
// an owner of application objects (an owner can disable policies and, without FORCE, bypass them). This module classifies a connection string without ever
// returning or logging its password, and checks the identity the database itself reports for the live connection. Nothing here writes.

type Executor = { $queryRawUnsafe<T = unknown>(query: string): Promise<T> }

/** Usernames that are, by convention, owners or administrators on the hosted providers we use. Extend per environment with FBEDS_FORBIDDEN_RUNTIME_DB_USERS (comma separated). */
const BUILT_IN_FORBIDDEN = new Set(['postgres', 'neondb_owner', 'rdsadmin', 'admin', 'administrator', 'root', 'superuser', 'owner', 'master', 'fbeds_owner', 'fbeds_migrator'])
const FORBIDDEN_PATTERN = /(^|_)(owner|admin|migrator|superuser)$/

export interface DatabaseTarget { host: string; database: string; user: string }

/** Host, database and user only. Never the password, never the query string. Throws a message that does not contain the input. */
export function describeDatabaseUrl(raw: string | undefined): DatabaseTarget {
  if (!raw) throw new Error('Database URL is not set')
  let parsed: URL
  try { parsed = new URL(raw.trim()) } catch { throw new Error('Database URL is not a valid URL') }
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') throw new Error('Database URL must use the postgresql scheme')
  return { host: parsed.hostname, database: decodeURIComponent(parsed.pathname.replace(/^\//, '')), user: decodeURIComponent(parsed.username) }
}

export function forbiddenRuntimeUsers(env: Record<string, string | undefined> = process.env): Set<string> {
  const extra = (env.FBEDS_FORBIDDEN_RUNTIME_DB_USERS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  return new Set([...BUILT_IN_FORBIDDEN, ...extra])
}

/** Why a database user name may not serve requests, or null when the name is acceptable. A name is never proof of safety; the live check below is. */
export function forbiddenUserReason(user: string, env: Record<string, string | undefined> = process.env): string | null {
  const name = user.trim().toLowerCase()
  if (!name) return 'the connection string names no database user'
  if (forbiddenRuntimeUsers(env).has(name)) return `database user "${name}" is a known owner or administrator login`
  if (FORBIDDEN_PATTERN.test(name)) return `database user "${name}" looks like an owner or administrator login`
  return null
}

/** Static check of a runtime connection string: used by the startup guard and by the CI configuration guard. */
export function checkRuntimeUrl(raw: string | undefined, env: Record<string, string | undefined> = process.env): { ok: boolean; target?: DatabaseTarget; reason?: string } {
  try {
    const target = describeDatabaseUrl(raw)
    const reason = forbiddenUserReason(target.user, env)
    return reason ? { ok: false, target, reason } : { ok: true, target }
  } catch (error) { return { ok: false, reason: (error as Error).message } }
}

export class RuntimeRoleViolation extends Error {
  constructor(readonly label: string, readonly failures: string[]) {
    super(`Refusing to run: ${label} database connection violates the runtime role invariant (${failures.join('; ')}). The API must connect as the restricted runtime login, never the migration owner.`)
    this.name = 'RuntimeRoleViolation'
  }
}

export interface RuntimeIdentity {
  currentUser: string
  sessionUser: string
  superuser: boolean
  bypassRls: boolean
  createRole: boolean
  createDb: boolean
  replication: boolean
  ownedObjects: number
  privilegedMemberships: string[]
}

/** What the database says this connection is. Catalog reads only. */
export async function readRuntimeIdentity(db: Executor): Promise<RuntimeIdentity | null> {
  const rows = await db.$queryRawUnsafe<Array<{ current_user: string; session_user: string; rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolreplication: boolean; owned: bigint | number; privileged: string[] | null }>>(
    `SELECT current_user::text AS current_user, session_user::text AS session_user, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolreplication,
            (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema','pg_toast') AND pg_get_userbyid(c.relowner) = current_user)
          + (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND pg_get_userbyid(p.proowner) = current_user)
          + (SELECT count(*) FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' AND pg_get_userbyid(nspowner) = current_user) AS owned,
            (SELECT array_agg(m.rolname::text ORDER BY m.rolname) FROM pg_roles m WHERE m.rolname <> current_user AND pg_has_role(current_user, m.oid, 'MEMBER') AND (m.rolsuper OR m.rolbypassrls OR m.rolcreaterole)) AS privileged
       FROM pg_roles r WHERE r.rolname = current_user`)
  const row = rows[0]
  if (!row) return null
  return { currentUser: row.current_user, sessionUser: row.session_user, superuser: row.rolsuper, bypassRls: row.rolbypassrls, createRole: row.rolcreaterole, createDb: row.rolcreatedb, replication: row.rolreplication, ownedObjects: Number(row.owned), privilegedMemberships: row.privileged ?? [] }
}

/** The invariants as a list of failures; empty means the identity may serve requests. Pure so it can be tested without a database. */
export function runtimeIdentityFailures(identity: RuntimeIdentity | null, env: Record<string, string | undefined> = process.env): string[] {
  if (!identity) return ['the connected role could not be found in pg_roles']
  const failures: string[] = []
  if (identity.superuser) failures.push('role is SUPERUSER')
  if (identity.bypassRls) failures.push('role has BYPASSRLS')
  if (identity.createRole) failures.push('role has CREATEROLE')
  if (identity.createDb) failures.push('role has CREATEDB')
  if (identity.replication) failures.push('role has REPLICATION')
  if (identity.ownedObjects > 0) failures.push('role owns database objects (tables, functions or schemas)')
  if (identity.privilegedMemberships.length) failures.push(`role is a member of privileged roles: ${identity.privilegedMemberships.join(', ')}`)
  const reason = forbiddenUserReason(identity.currentUser, env)
  if (reason) failures.push(reason)
  if (identity.sessionUser !== identity.currentUser) { const second = forbiddenUserReason(identity.sessionUser, env); if (second) failures.push(`session ${second}`) }
  return failures
}

/** Throws RuntimeRoleViolation unless the connection is a restricted login. The message names the invariant and carries no URL, host or password. */
export async function assertRuntimeDbIdentity(db: Executor, label: string, env: Record<string, string | undefined> = process.env): Promise<RuntimeIdentity> {
  const identity = await readRuntimeIdentity(db)
  const failures = runtimeIdentityFailures(identity, env)
  if (failures.length || !identity) throw new RuntimeRoleViolation(label, failures)
  return identity
}

/**
 * `enforce` is the only mode outside tests. `off` exists so legacy test suites that deliberately use an owner URL keep running; it is honoured only when
 * NODE_ENV=test and any other combination is a startup error (never a silent downgrade).
 */
export function runtimeGuardMode(env: Record<string, string | undefined> = process.env): 'enforce' | 'off' {
  const value = (env.DB_RUNTIME_ROLE_GUARD ?? 'enforce').trim().toLowerCase()
  if (value === 'enforce') return 'enforce'
  if (value === 'off') {
    if (env.NODE_ENV !== 'test') throw new Error('DB_RUNTIME_ROLE_GUARD=off is only allowed when NODE_ENV=test')
    return 'off'
  }
  throw new Error('DB_RUNTIME_ROLE_GUARD must be "enforce" (or "off" in tests)')
}
