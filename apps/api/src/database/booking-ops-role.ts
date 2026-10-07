import { describePasswordProblems, upsertLoginRoleSql } from './hold-expiry-role'

/**
 * The dedicated limited database role of the Admin booking module (ADR 0039, owner answer 1).
 *
 * Why a separate principal: the strict API runtime role (`fbeds_api`) is deliberately denied the booking tables, because every HTTP request runs
 * as it and booking rows hold guest personal data. The booking module therefore reads through its own connection (`BOOKING_OPS_DATABASE_URL`)
 * as `fbeds_booking_ops`, a member of the NOLOGIN group `fbeds_booking`. Nothing else in the API uses it, and the API role gets no booking grant.
 *
 * Phase 1 read what the list and detail screens need; Phase 2 adds narrow writes for the transition function (see the constants below). Row-level security stays forced and this role cannot
 * bypass it: every read still runs inside a transaction that sets the tenant. Write grants are added per phase, as narrow column grants for the
 * transition function only, in their own change to this file.
 * No grant on LedgerEntry, Wallet or any hotel, agency, user or session table until a later phase needs it.
 */
export const BOOKING_OPS_GROUP_ROLE = 'fbeds_booking'
export const BOOKING_OPS_LOGIN_ROLE = 'fbeds_booking_ops'

type Executor = { $executeRawUnsafe(query: string): Promise<number>; $queryRawUnsafe<T = unknown>(query: string): Promise<T> }

const IDENTIFIER = /^[a-z][a-z0-9_]{2,62}$/
const PASSWORD = /^[A-Za-z0-9_-]{32,128}$/

/** Phase 5 adds BookingDocument (issue-once, immutable by trigger) and BookingFinanceEvent (append-only): SELECT + INSERT, never UPDATE. Phase 1: SELECT only. `SupplierMutation` carries fingerprints, references and failure codes, never request or response payloads. */
export const BOOKING_OPS_READ_TABLES = ['Booking', 'BookingRoom', 'BookingGuest', 'BookingEvent', 'SupplierMutation', 'BookingSupplierJob', 'BookingSupplierCall', 'BookingOpsState', 'BookingDocument', 'BookingFinanceEvent', 'BookingSavedView'] as const
/**
 * Phase 2 write grants, as narrow as the transition function needs (ADR 0039). No DELETE and no TRUNCATE anywhere. Status, lock, version and the supplier
 * references can be UPDATEd only as named columns (which is also why the immutable `BookingEvent` gets INSERT only). AuditEvent is INSERT-only and not readable.
 */
export const BOOKING_OPS_UPDATE_COLUMNS = {
  Booking: ['status', 'supplier_status', 'supplier_ref', 'hotel_confirmation_no', 'agent_ref', 'version', 'closed_at', 'updated_at'],
  /** Phase 3: the runner claims, retries and completes its own jobs, and nothing else about them. */
  BookingSupplierJob: ['status', 'attempt', 'run_after', 'locked_until', 'last_error_code', 'completed_at', 'updated_at'],
  /** Phase 6B: a person's own saved view. The keys (tenant, owner) and the row's creation are never updatable: a view cannot change hands. */
  BookingSavedView: ['name', 'name_key', 'description', 'filter_version', 'filters_json', 'sort_json', 'visible_columns_json', 'default_slot', 'version', 'updated_at'],
  /** Phase 4: the operational state columns, and never the keys (tenant, booking) or the row's creation. */
  BookingOpsState: ['assignee_user_id', 'assigned_at', 'assigned_by_user_id', 'acknowledged_at', 'acknowledged_by_user_id', 'manual_priority', 'escalated_at', 'escalated_by_user_id', 'escalation_reason', 'follow_up', 'follow_up_at', 'resolved_at', 'resolved_by_user_id', 'version', 'updated_at'],
} as const
/** Phase 3: the one function the runner may call, to learn which tenants have due jobs (returns tenant ids only). */
export const BOOKING_OPS_FUNCTIONS = ['"fbeds_booking_due_tenants"(timestamp)'] as const
export const BOOKING_OPS_INSERT_TABLES = ['Booking', 'BookingRoom', 'BookingGuest', 'BookingEvent', 'AuditEvent', 'BookingSupplierJob', 'BookingSupplierCall', 'BookingOpsState', 'BookingDocument', 'BookingFinanceEvent', 'BookingSavedView'] as const
/**
 * The ONE table the role may DELETE from: a person's own saved booking views (Phase 6B). They are preferences, not records: no evidence is lost by removing one, and the
 * deletion is audited. Every other table is delete-proof for this role, and the verifier checks both sides of that.
 */
export const BOOKING_OPS_DELETE_TABLES = ['BookingSavedView'] as const
/** Tables the role must never be able to read or write. Checked by the verifier. */
export const BOOKING_OPS_FORBIDDEN_TABLES = ['LedgerEntry', 'Wallet', 'Cancellation', 'InventoryHold', 'users', 'sessions', 'memberships', 'Agency', 'AgencyMember', 'Hotel', 'Contract', 'DailyRate', 'ConnectorCredentialReference'] as const

export function assertBookingOpsInput(loginRole: string, password: string): void {
  if (!IDENTIFIER.test(loginRole)) throw new Error('Login role must match [a-z][a-z0-9_]{2,62}')
  if (loginRole === BOOKING_OPS_GROUP_ROLE || loginRole === 'postgres') throw new Error('Login role must be dedicated to the booking module')
  if (!PASSWORD.test(password)) throw new Error('Password must be 32-128 URL-safe characters [A-Za-z0-9_-]')
}

/** Grant statements, in order. The one place the booking role's privileges are stated. */
export function bookingOpsGrantStatements(group = BOOKING_OPS_GROUP_ROLE): string[] {
  return [
    `GRANT USAGE ON SCHEMA public TO "${group}"`,
    ...BOOKING_OPS_READ_TABLES.map((table) => `GRANT SELECT ON "${table}" TO "${group}"`),
    ...BOOKING_OPS_INSERT_TABLES.map((table) => `GRANT INSERT ON "${table}" TO "${group}"`),
    ...Object.entries(BOOKING_OPS_UPDATE_COLUMNS).map(([table, columns]) => `GRANT UPDATE (${columns.map((c) => `"${c}"`).join(', ')}) ON "${table}" TO "${group}"`),
    ...BOOKING_OPS_FUNCTIONS.map((fn) => `GRANT EXECUTE ON FUNCTION ${fn} TO "${group}"`),
    ...BOOKING_OPS_DELETE_TABLES.map((table) => `GRANT DELETE ON "${table}" TO "${group}"`),
  ]
}

/**
 * Idempotently creates the group role and one LOGIN member, then (re)asserts exactly the granted privileges (read, plus the narrow Phase 2 writes).
 * Owner-only: it must run as the database owner or another role allowed to CREATE ROLE and GRANT. It never creates SUPERUSER, BYPASSRLS,
 * CREATEROLE, CREATEDB or REPLICATION roles, and it revokes everything first so a stale or broader grant cannot survive. Never log the password.
 */
export async function provisionBookingOpsRole(db: Executor, input: { loginRole?: string; password: string }): Promise<void> {
  const loginRole = input.loginRole ?? BOOKING_OPS_LOGIN_ROLE
  assertBookingOpsInput(loginRole, input.password)
  const attributes = 'NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'
  await db.$executeRawUnsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${BOOKING_OPS_GROUP_ROLE}') THEN CREATE ROLE "${BOOKING_OPS_GROUP_ROLE}" NOLOGIN ${attributes}; END IF; END $$`)
  await db.$executeRawUnsafe(upsertLoginRoleSql(loginRole, input.password, attributes, 10))
  await db.$executeRawUnsafe(`GRANT "${BOOKING_OPS_GROUP_ROLE}" TO "${loginRole}"`)
  await db.$executeRawUnsafe(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM "${BOOKING_OPS_GROUP_ROLE}"`)
  await db.$executeRawUnsafe(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM "${BOOKING_OPS_GROUP_ROLE}"`)
  for (const statement of bookingOpsGrantStatements()) await db.$executeRawUnsafe(statement)
}

/** Removes the login role and, optionally, the group role. Used for rotation, rollback and tests. */
export async function deprovisionBookingOpsRole(db: Executor, loginRole = BOOKING_OPS_LOGIN_ROLE, options: { dropGroup?: boolean } = {}): Promise<void> {
  if (!IDENTIFIER.test(loginRole) || loginRole === BOOKING_OPS_GROUP_ROLE || loginRole === 'postgres') throw new Error('Invalid login role')
  const drop = (role: string) => `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
    IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN EXECUTE 'GRANT "${role}" TO CURRENT_USER WITH INHERIT TRUE, SET TRUE'; END IF;
    DROP OWNED BY "${role}"; DROP ROLE "${role}"; END IF; END $$`
  await db.$executeRawUnsafe(drop(loginRole))
  if (options.dropGroup) await db.$executeRawUnsafe(drop(BOOKING_OPS_GROUP_ROLE))
}

export interface BookingOpsRoleReport { ok: boolean; failures: string[] }

/** Run while connected AS the login role. Read-only catalogue checks; returns no secret. */
export async function verifyBookingOpsRole(db: Pick<Executor, '$queryRawUnsafe'>): Promise<BookingOpsRoleReport> {
  const failures: string[] = []
  const [attrs] = await db.$queryRawUnsafe<Array<{ rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolreplication: boolean; member: boolean; owned: bigint }>>(
    `SELECT r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolreplication,
            pg_has_role(current_user, '${BOOKING_OPS_GROUP_ROLE}', 'MEMBER') AS member,
            (SELECT count(*) FROM pg_tables WHERE tableowner = current_user) AS owned
       FROM pg_roles r WHERE r.rolname = current_user`)
  if (!attrs) return { ok: false, failures: ['role not found'] }
  if (attrs.rolsuper) failures.push('role is SUPERUSER')
  if (attrs.rolbypassrls) failures.push('role has BYPASSRLS')
  if (attrs.rolcreaterole) failures.push('role has CREATEROLE')
  if (attrs.rolcreatedb) failures.push('role has CREATEDB')
  if (attrs.rolreplication) failures.push('role has REPLICATION')
  if (!attrs.member) failures.push(`role is not a member of ${BOOKING_OPS_GROUP_ROLE}`)
  if (Number(attrs.owned) > 0) failures.push('role owns tables')
  const readList = BOOKING_OPS_READ_TABLES.map((t) => `'${t}'`).join(',')
  const [missing] = await db.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM unnest(ARRAY[${readList}]) t WHERE NOT has_table_privilege(current_user, format('%I', t), 'SELECT')`)
  if (Number(missing?.n ?? 0) > 0) failures.push('role cannot read every booking table it needs')
  const everyTable = [...new Set<string>([...BOOKING_OPS_READ_TABLES, ...BOOKING_OPS_INSERT_TABLES])].map((t) => `'${t}'`).join(',')
  const deletable = BOOKING_OPS_DELETE_TABLES.map((t) => `'${t}'`).join(',')
  const [broad] = await db.$queryRawUnsafe<Array<{ n: bigint }>>(
    `SELECT count(*) AS n FROM unnest(ARRAY[${everyTable}]) t
      WHERE CASE WHEN t = ANY(ARRAY[${deletable}]) THEN has_table_privilege(current_user, format('%I', t), 'UPDATE,TRUNCATE,REFERENCES,TRIGGER')
                 ELSE has_table_privilege(current_user, format('%I', t), 'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') END`)
  const [noDelete] = await db.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM unnest(ARRAY[${deletable}]) t WHERE NOT has_table_privilege(current_user, format('%I', t), 'DELETE')`)
  if (Number(noDelete?.n ?? 0) > 0) failures.push('role cannot delete a saved view')
  if (Number(broad?.n ?? 0) > 0) failures.push('role holds a table-wide UPDATE, a DELETE outside saved views, or any TRUNCATE, REFERENCES or TRIGGER privilege')
  const insertList = BOOKING_OPS_INSERT_TABLES.map((t) => `'${t}'`).join(',')
  const [insertGap] = await db.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM unnest(ARRAY[${insertList}]) t WHERE NOT has_table_privilege(current_user, format('%I', t), 'INSERT')`)
  if (Number(insertGap?.n ?? 0) > 0) failures.push('role cannot insert where the transition function needs it')
  const [extraInsert] = await db.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM unnest(ARRAY[${readList}]) t WHERE t <> ALL(ARRAY[${insertList}]) AND has_table_privilege(current_user, format('%I', t), 'INSERT')`)
  if (Number(extraInsert?.n ?? 0) > 0) failures.push('role can insert into a table that is read-only for it')
  for (const fn of BOOKING_OPS_FUNCTIONS) {
    const [f] = await db.$queryRawUnsafe<Array<{ ok: boolean }>>(`SELECT has_function_privilege(current_user, '${fn.replace(/'/g, "''")}', 'EXECUTE') AS ok`)
    if (!f?.ok) failures.push(`role cannot execute ${fn}`)
  }
  const [audit] = await db.$queryRawUnsafe<Array<{ readable: boolean }>>(`SELECT has_table_privilege(current_user, '"AuditEvent"', 'SELECT') AS readable`)
  if (audit?.readable) failures.push('role can read the audit log')
  for (const [table, columns] of Object.entries(BOOKING_OPS_UPDATE_COLUMNS)) {
    const [cols] = await db.$queryRawUnsafe<Array<{ extra: bigint; missing: bigint }>>(
      `SELECT count(*) FILTER (WHERE has_column_privilege(current_user, '"${table}"', a.attname, 'UPDATE') AND a.attname <> ALL(ARRAY[${columns.map((c) => `'${c}'`).join(',')}])) AS extra,
              count(*) FILTER (WHERE NOT has_column_privilege(current_user, '"${table}"', a.attname, 'UPDATE') AND a.attname = ANY(ARRAY[${columns.map((c) => `'${c}'`).join(',')}])) AS missing
         FROM pg_attribute a WHERE a.attrelid = '"${table}"'::regclass AND a.attnum > 0 AND NOT a.attisdropped`)
    if (Number(cols?.extra ?? 0) > 0) failures.push(`role can update a ${table} column the transition function does not own`)
    if (Number(cols?.missing ?? 0) > 0) failures.push(`role cannot update a ${table} column it needs`)
  }
  const forbiddenList = BOOKING_OPS_FORBIDDEN_TABLES.map((t) => `'${t}'`).join(',')
  const [forbidden] = await db.$queryRawUnsafe<Array<{ n: bigint }>>(
    `SELECT count(*) AS n FROM unnest(ARRAY[${forbiddenList}]) t WHERE has_table_privilege(current_user, format('%I', t), 'SELECT,INSERT,UPDATE,DELETE')`)
  if (Number(forbidden?.n ?? 0) > 0) failures.push('role can reach a table outside the booking module scope')
  return { ok: failures.length === 0, failures }
}

export { describePasswordProblems }
