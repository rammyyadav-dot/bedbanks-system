import { describePasswordProblems, upsertLoginRoleSql } from './hold-expiry-role'
import { RUNTIME_READ_TABLES, expectedColumnReads, expectedWrites, runtimeGrantStatements, type WritePrivilege } from './runtime-role-contract'

export const API_RUNTIME_GROUP_ROLE = 'fbeds_api'
export const API_RUNTIME_LOGIN_ROLE = 'fbeds_api_login'

type Executor = { $executeRawUnsafe(query: string): Promise<number>; $queryRawUnsafe<T = unknown>(query: string): Promise<T> }

const IDENTIFIER = /^[a-z][a-z0-9_]{2,62}$/
const RESERVED = new Set(['postgres', API_RUNTIME_GROUP_ROLE, 'fbeds_hold_expiry', 'fbeds_hold_expiry_login', 'fbeds_rls_test'])

/**
 * Statements the owner runs to grant the API group role: REVOKE ALL, then exactly the contract in `runtime-role-contract.ts`.
 * There is no second definition of the grants anywhere (ADR 0032).
 */
export function apiRuntimeGrantStatements(groupRole = API_RUNTIME_GROUP_ROLE): string[] {
  return runtimeGrantStatements(groupRole)
}

export function assertApiRuntimeInput(loginRole: string, password: string): void {
  if (!IDENTIFIER.test(loginRole) || RESERVED.has(loginRole)) throw new Error('Login role must be a dedicated API runtime role')
  const problems = describePasswordProblems(password)
  if (problems.length) throw new Error('Password must be 32-128 URL-safe characters [A-Za-z0-9_-]')
}

/**
 * Idempotently creates the least-privilege API group role and one LOGIN member.
 * Must run as the database owner. It never creates SUPERUSER, BYPASSRLS,
 * CREATEROLE, CREATEDB, or REPLICATION. Never log the password.
 */
export async function provisionApiRuntimeRole(db: Executor, input: { loginRole?: string; password: string }): Promise<void> {
  const loginRole = input.loginRole ?? API_RUNTIME_LOGIN_ROLE
  assertApiRuntimeInput(loginRole, input.password)
  const login = `"${loginRole}"`
  const group = `"${API_RUNTIME_GROUP_ROLE}"`
  const attributes = 'NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'
  await db.$executeRawUnsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${API_RUNTIME_GROUP_ROLE}') THEN CREATE ROLE ${group} NOLOGIN ${attributes}; END IF; END $$`)
  await db.$executeRawUnsafe(upsertLoginRoleSql(loginRole, input.password, attributes, 20))
  await db.$executeRawUnsafe(`GRANT ${group} TO ${login}`)
  for (const statement of apiRuntimeGrantStatements()) await db.$executeRawUnsafe(statement)
}

export interface ApiRuntimeRoleReport { ok: boolean; failures: string[] }

/** Run while connected AS the API login role. Read-only catalog checks; no secrets returned. */
export async function verifyApiRuntimeRole(db: Pick<Executor, '$queryRawUnsafe'>): Promise<ApiRuntimeRoleReport> {
  const failures: string[] = []
  const [attrs] = await db.$queryRawUnsafe<Array<{ rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolreplication: boolean; rolcanlogin: boolean; member: boolean; owned: bigint }>>(
    `SELECT r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolreplication, r.rolcanlogin,
            pg_has_role(current_user, '${API_RUNTIME_GROUP_ROLE}', 'MEMBER') AS member,
            (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relkind = 'r' AND pg_get_userbyid(c.relowner) = current_user) AS owned
       FROM pg_roles r WHERE r.rolname = current_user`)
  if (!attrs) return { ok: false, failures: ['role not found'] }
  if (attrs.rolsuper) failures.push('role is SUPERUSER')
  if (attrs.rolbypassrls) failures.push('role has BYPASSRLS')
  if (attrs.rolcreaterole) failures.push('role has CREATEROLE')
  if (attrs.rolcreatedb) failures.push('role has CREATEDB')
  if (attrs.rolreplication) failures.push('role has REPLICATION')
  if (!attrs.rolcanlogin) failures.push('role cannot login')
  if (!attrs.member) failures.push(`role is not a member of ${API_RUNTIME_GROUP_ROLE}`)
  if (Number(attrs.owned) > 0) failures.push('role owns tables')
  const [owns] = await db.$queryRawUnsafe<Array<{ n: bigint }>>(
    `SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND pg_get_userbyid(c.relowner) = current_user)
          + (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND pg_get_userbyid(p.proowner) = current_user)
          + (SELECT count(*) FROM pg_namespace WHERE pg_get_userbyid(nspowner) = current_user) AS n`)
  if (Number(owns?.n ?? 0) > 0) failures.push('role owns database objects (relations, functions or schemas)')
  const memberships = await db.$queryRawUnsafe<Array<{ rolname: string }>>(
    `SELECT r.rolname FROM pg_roles r WHERE pg_has_role(current_user, r.oid, 'MEMBER') AND r.rolname NOT IN (current_user, '${API_RUNTIME_GROUP_ROLE}') ORDER BY 1`)
  if (memberships.length) failures.push(`role is a member of unexpected roles: ${memberships.map((m) => m.rolname).join(', ')}`)
  const [forbidden] = await db.$queryRawUnsafe<Array<{ n: bigint }>>(
    `SELECT count(*) AS n FROM unnest(ARRAY['Wallet','LedgerEntry','Booking','ConnectorCredentialReference']) t
      WHERE has_table_privilege(current_user, format('%I', t), 'SELECT')`)
  if (Number(forbidden?.n ?? 0) > 0) failures.push('role can read finance or credential tables')
  const privileges = await inspectRuntimePrivileges(db)
  failures.push(...privileges.problems.map((p) => p.message))
  if (privileges.missingReads.length) failures.push(`role cannot read required tables: ${privileges.missingReads.join(', ')}`)
  return { ok: failures.length === 0, failures }
}

export interface PrivilegeProblem { table: string; message: string }

type WriteRow = { tbl: string; priv: string; table_level: boolean; cols: string[] | null }

/**
 * Compares the live privileges of the CURRENT user against the contract: every write privilege (table or column level) the role holds
 * must be in the contract, and every contract write and read must be held. Catalog queries only; no secrets. With `onlyTable`, inspects that table
 * (the 403-versus-503 classification of a database denial uses this). With `subject`, inspects that role by name instead of the connected user (owner-side rollout check).
 */
export async function inspectRuntimePrivileges(db: Pick<Executor, '$queryRawUnsafe'>, onlyTable?: string, subject?: string): Promise<{ problems: PrivilegeProblem[]; missingReads: string[] }> {
  const literal = (value: string) => `'${value.replace(/'/g, "''")}'`
  const who = subject ? literal(subject) : 'current_user' // a role name (owner-side rollout check of the group role) or the connected user
  const filter = onlyTable ? `AND c.relname = ${literal(onlyTable)}` : ''
  const rows = await db.$queryRawUnsafe<WriteRow[]>(
    `SELECT c.relname AS tbl, p.priv,
            has_table_privilege(${who}, c.oid, p.priv) AS table_level,
            CASE WHEN p.priv IN ('INSERT','UPDATE') THEN
              (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a
                WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND has_column_privilege(${who}, c.oid, a.attnum, p.priv))
            END AS cols
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE']) p(priv)
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p') ${filter}
        AND (has_table_privilege(${who}, c.oid, p.priv) OR (p.priv IN ('INSERT','UPDATE') AND has_any_column_privilege(${who}, c.oid, p.priv)))`)
  const expected = expectedWrites()
  const problems: PrivilegeProblem[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const priv = row.priv as WritePrivilege | 'TRUNCATE'
    const want = expected.get(row.tbl)
    seen.add(`${row.tbl}:${priv}`)
    if (priv === 'TRUNCATE' || !want) { problems.push({ table: row.tbl, message: `role holds ${priv} on ${row.tbl}, which the contract does not grant` }); continue }
    if (want.table.has(priv as WritePrivilege)) { if (!row.table_level) problems.push({ table: row.tbl, message: `role lacks table-level ${priv} on ${row.tbl}` }); continue }
    const columns = want.columns.get(priv as WritePrivilege)
    if (!columns) { problems.push({ table: row.tbl, message: `role holds ${priv} on ${row.tbl}, which the contract does not grant` }); continue }
    const held = new Set(row.table_level ? ['*'] : (row.cols ?? []))
    const same = !row.table_level && held.size === columns.size && [...columns].every((c) => held.has(c))
    if (!same) problems.push({ table: row.tbl, message: `role's ${priv} columns on ${row.tbl} differ from the contract (${row.table_level ? 'table-level' : [...held].join(', ')})` })
  }
  for (const [table, want] of expected) {
    if (onlyTable && table !== onlyTable) continue
    const needed: WritePrivilege[] = [...want.table, ...want.columns.keys()]
    for (const priv of needed) if (!seen.has(`${table}:${priv}`)) problems.push({ table, message: `role lacks contract write ${priv} on ${table}` })
  }
  const missingReads: string[] = []
  // Reads: every SELECT the role holds, table-level or column-level, must be in the contract, and the contract's reads must all be held.
  const readRows = await db.$queryRawUnsafe<Array<{ tbl: string; table_level: boolean; cols: string[] | null }>>(
    `SELECT c.relname AS tbl, has_table_privilege(${who}, c.oid, 'SELECT') AS table_level,
            (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a
              WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND has_column_privilege(${who}, c.oid, a.attnum, 'SELECT')) AS cols
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p') ${filter}
        AND (has_table_privilege(${who}, c.oid, 'SELECT') OR has_any_column_privilege(${who}, c.oid, 'SELECT'))`)
  const tableReads = new Set(RUNTIME_READ_TABLES)
  const columnReads = expectedColumnReads()
  const readSeen = new Set<string>()
  for (const row of readRows) {
    readSeen.add(row.tbl)
    const wanted = columnReads.get(row.tbl)
    if (wanted) {
      if (row.table_level) { problems.push({ table: row.tbl, message: `role holds table-level SELECT on ${row.tbl}, which overrides the contract's column-level read` }); continue }
      const held = new Set(row.cols ?? [])
      const extra = [...held].filter((c) => !wanted.has(c)); const missing = [...wanted].filter((c) => !held.has(c))
      if (extra.length) problems.push({ table: row.tbl, message: `role reads columns of ${row.tbl} outside the contract: ${extra.join(', ')}` })
      if (missing.length) { problems.push({ table: row.tbl, message: `role cannot read required columns of ${row.tbl}: ${missing.join(', ')}` }); if (!missingReads.includes(row.tbl)) missingReads.push(row.tbl) }
    } else if (tableReads.has(row.tbl)) {
      if (!row.table_level) problems.push({ table: row.tbl, message: `role lacks table-level SELECT on ${row.tbl} (it holds only some columns)` })
    } else {
      problems.push({ table: row.tbl, message: `role can read ${row.tbl}, which the contract does not grant` })
    }
  }
  for (const table of [...tableReads, ...columnReads.keys()]) {
    if (onlyTable && table !== onlyTable) continue
    if (!readSeen.has(table)) { problems.push({ table, message: `role cannot read ${table}` }); missingReads.push(table) }
  }
  missingReads.sort()
  return { problems, missingReads }
}
