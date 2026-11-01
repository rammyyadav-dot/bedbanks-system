import { describePasswordProblems, upsertLoginRoleSql } from '../database/hold-expiry-role'

/**
 * The dedicated database role of the compliance exporter (ADR 0067).
 *
 * Why a separate principal: the exporter must read every tenant's compliance records and seal them into batches, which no HTTP request may do.
 * It connects through `COMPLIANCE_DATABASE_URL` as a member of the NOLOGIN group `fbeds_compliance` and still cannot bypass row-level security:
 * every read and write runs in a transaction that selects one scope (a tenant, or the platform scope). It never reads the audit log itself,
 * a booking, a user or any money table: the capture trigger already copied what compliance needs.
 */
export const COMPLIANCE_GROUP_ROLE = 'fbeds_compliance'
export const COMPLIANCE_LOGIN_ROLE = 'fbeds_compliance_export'

type Executor = { $executeRawUnsafe(query: string): Promise<number>; $queryRawUnsafe<T = unknown>(query: string): Promise<T> }

const IDENTIFIER = /^[a-z][a-z0-9_]{2,62}$/
const PASSWORD = /^[A-Za-z0-9_-]{32,128}$/

export const COMPLIANCE_READ_TABLES = ['ComplianceRecord', 'ComplianceExportBatch', 'ComplianceExportBatchRecord'] as const
export const COMPLIANCE_INSERT_TABLES = ['ComplianceExportBatch', 'ComplianceExportBatchRecord'] as const
/** The one update: recording that a sealed batch is now in WORM storage. The table trigger also refuses any other change. */
export const COMPLIANCE_UPDATE_COLUMNS = { ComplianceExportBatch: ['storage_status', 'stored_at', 'object_version_id'] } as const
/** Scope discovery without a cross-tenant read: both return scope keys (tenant ids, 'platform') only. */
export const COMPLIANCE_FUNCTIONS = ['"fbeds_compliance_due_scopes"()', '"fbeds_compliance_known_scopes"()'] as const
/** Tables the role must never reach. Checked by the verifier. */
export const COMPLIANCE_FORBIDDEN_TABLES = ['AuditEvent', 'users', 'sessions', 'memberships', 'Booking', 'BookingGuest', 'LedgerEntry', 'Wallet', 'Agency', 'Hotel', 'ConnectorCredentialReference'] as const

export function assertComplianceRoleInput(loginRole: string, password: string): void {
  if (!IDENTIFIER.test(loginRole)) throw new Error('Login role must match [a-z][a-z0-9_]{2,62}')
  if (loginRole === COMPLIANCE_GROUP_ROLE || loginRole === 'postgres') throw new Error('Login role must be dedicated to the compliance exporter')
  if (!PASSWORD.test(password)) throw new Error('Password must be 32-128 URL-safe characters [A-Za-z0-9_-]')
}

/** Grant statements, in order. The one place the compliance role's privileges are stated. */
export function complianceGrantStatements(group = COMPLIANCE_GROUP_ROLE): string[] {
  return [
    `GRANT USAGE ON SCHEMA public TO "${group}"`,
    ...COMPLIANCE_READ_TABLES.map((table) => `GRANT SELECT ON "${table}" TO "${group}"`),
    ...COMPLIANCE_INSERT_TABLES.map((table) => `GRANT INSERT ON "${table}" TO "${group}"`),
    ...Object.entries(COMPLIANCE_UPDATE_COLUMNS).map(([table, columns]) => `GRANT UPDATE (${columns.map((c) => `"${c}"`).join(', ')}) ON "${table}" TO "${group}"`),
    ...COMPLIANCE_FUNCTIONS.map((fn) => `GRANT EXECUTE ON FUNCTION ${fn} TO "${group}"`),
  ]
}

/**
 * Idempotently creates the group role and one LOGIN member, revokes everything, then grants exactly the statements above.
 * Owner-only. Never creates SUPERUSER, BYPASSRLS, CREATEROLE, CREATEDB or REPLICATION roles. Never log the password.
 */
export async function provisionComplianceRole(db: Executor, input: { loginRole?: string; password: string }): Promise<void> {
  const loginRole = input.loginRole ?? COMPLIANCE_LOGIN_ROLE
  assertComplianceRoleInput(loginRole, input.password)
  const attributes = 'NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'
  await db.$executeRawUnsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${COMPLIANCE_GROUP_ROLE}') THEN CREATE ROLE "${COMPLIANCE_GROUP_ROLE}" NOLOGIN ${attributes}; END IF; END $$`)
  await db.$executeRawUnsafe(upsertLoginRoleSql(loginRole, input.password, attributes, 3))
  await db.$executeRawUnsafe(`GRANT "${COMPLIANCE_GROUP_ROLE}" TO "${loginRole}"`)
  await db.$executeRawUnsafe(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM "${COMPLIANCE_GROUP_ROLE}"`)
  await db.$executeRawUnsafe(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM "${COMPLIANCE_GROUP_ROLE}"`)
  for (const statement of complianceGrantStatements()) await db.$executeRawUnsafe(statement)
}

/** Removes the login role and, optionally, the group role. Used for rotation, rollback and tests. */
export async function deprovisionComplianceRole(db: Executor, loginRole = COMPLIANCE_LOGIN_ROLE, options: { dropGroup?: boolean } = {}): Promise<void> {
  if (!IDENTIFIER.test(loginRole) || loginRole === COMPLIANCE_GROUP_ROLE || loginRole === 'postgres') throw new Error('Invalid login role')
  const drop = (role: string) => `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
    IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN EXECUTE 'GRANT "${role}" TO CURRENT_USER WITH INHERIT TRUE, SET TRUE'; END IF;
    DROP OWNED BY "${role}"; DROP ROLE "${role}"; END IF; END $$`
  await db.$executeRawUnsafe(drop(loginRole))
  if (options.dropGroup) await db.$executeRawUnsafe(drop(COMPLIANCE_GROUP_ROLE))
}

export interface ComplianceRoleReport { ok: boolean; failures: string[] }

const list = (values: readonly string[]) => values.map((v) => `'${v}'`).join(',')

/** Run while connected AS the login role. Read-only catalogue checks; returns no secret. Both directions: a missing and an extra privilege fail. */
export async function verifyComplianceRole(db: Pick<Executor, '$queryRawUnsafe'>): Promise<ComplianceRoleReport> {
  const failures: string[] = []
  const [attrs] = await db.$queryRawUnsafe<Array<{ rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolreplication: boolean; member: boolean; owned: bigint }>>(
    `SELECT r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolreplication,
            pg_has_role(current_user, '${COMPLIANCE_GROUP_ROLE}', 'MEMBER') AS member,
            (SELECT count(*) FROM pg_tables WHERE tableowner = current_user) AS owned
       FROM pg_roles r WHERE r.rolname = current_user`)
  if (!attrs) return { ok: false, failures: ['role not found'] }
  if (attrs.rolsuper) failures.push('role is SUPERUSER')
  if (attrs.rolbypassrls) failures.push('role has BYPASSRLS')
  if (attrs.rolcreaterole) failures.push('role has CREATEROLE')
  if (attrs.rolcreatedb) failures.push('role has CREATEDB')
  if (attrs.rolreplication) failures.push('role has REPLICATION')
  if (!attrs.member) failures.push(`role is not a member of ${COMPLIANCE_GROUP_ROLE}`)
  if (Number(attrs.owned) > 0) failures.push('role owns tables')
  const [counts] = await db.$queryRawUnsafe<Array<{ unreadable: bigint; uninsertable: bigint; extra_insert: bigint; broad: bigint; forbidden: bigint }>>(
    `SELECT
       (SELECT count(*) FROM unnest(ARRAY[${list(COMPLIANCE_READ_TABLES)}]) t WHERE NOT has_table_privilege(current_user, format('%I', t), 'SELECT')) AS unreadable,
       (SELECT count(*) FROM unnest(ARRAY[${list(COMPLIANCE_INSERT_TABLES)}]) t WHERE NOT has_table_privilege(current_user, format('%I', t), 'INSERT')) AS uninsertable,
       (SELECT count(*) FROM unnest(ARRAY[${list(COMPLIANCE_READ_TABLES)}]) t WHERE t <> ALL(ARRAY[${list(COMPLIANCE_INSERT_TABLES)}]) AND has_table_privilege(current_user, format('%I', t), 'INSERT')) AS extra_insert,
       (SELECT count(*) FROM unnest(ARRAY[${list(COMPLIANCE_READ_TABLES)}]) t WHERE has_table_privilege(current_user, format('%I', t), 'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) AS broad,
       (SELECT count(*) FROM unnest(ARRAY[${list(COMPLIANCE_FORBIDDEN_TABLES)}]) t WHERE to_regclass(format('%I', t)) IS NOT NULL AND has_table_privilege(current_user, format('%I', t), 'SELECT,INSERT,UPDATE,DELETE')) AS forbidden`)
  if (Number(counts?.unreadable ?? 0) > 0) failures.push('role cannot read every compliance table')
  if (Number(counts?.uninsertable ?? 0) > 0) failures.push('role cannot insert an export batch')
  if (Number(counts?.extra_insert ?? 0) > 0) failures.push('role can insert compliance records directly (only the capture trigger may)')
  if (Number(counts?.broad ?? 0) > 0) failures.push('role holds a table-wide UPDATE, or any DELETE, TRUNCATE, REFERENCES or TRIGGER privilege on a compliance table')
  if (Number(counts?.forbidden ?? 0) > 0) failures.push('role can reach a table outside the compliance scope')
  for (const [table, columns] of Object.entries(COMPLIANCE_UPDATE_COLUMNS)) {
    const [cols] = await db.$queryRawUnsafe<Array<{ extra: bigint; missing: bigint }>>(
      `SELECT count(*) FILTER (WHERE has_column_privilege(current_user, '"${table}"', a.attname, 'UPDATE') AND a.attname <> ALL(ARRAY[${list(columns)}])) AS extra,
              count(*) FILTER (WHERE NOT has_column_privilege(current_user, '"${table}"', a.attname, 'UPDATE') AND a.attname = ANY(ARRAY[${list(columns)}])) AS missing
         FROM pg_attribute a WHERE a.attrelid = '"${table}"'::regclass AND a.attnum > 0 AND NOT a.attisdropped`)
    if (Number(cols?.extra ?? 0) > 0) failures.push(`role can update a ${table} column other than the storage status`)
    if (Number(cols?.missing ?? 0) > 0) failures.push(`role cannot record that a ${table} row was stored`)
  }
  for (const fn of COMPLIANCE_FUNCTIONS) {
    const [f] = await db.$queryRawUnsafe<Array<{ ok: boolean }>>(`SELECT has_function_privilege(current_user, '${fn.replace(/'/g, "''")}', 'EXECUTE') AS ok`)
    if (!f?.ok) failures.push(`role cannot execute ${fn}`)
  }
  return { ok: failures.length === 0, failures }
}

export { describePasswordProblems }
