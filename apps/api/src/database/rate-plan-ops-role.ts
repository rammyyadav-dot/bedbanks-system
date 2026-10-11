import { upsertLoginRoleSql } from './hold-expiry-role'

/**
 * The narrow database role that performs rate plan lifecycle transitions (ADR 0041 Amendment 2).
 *
 * ADR 0032 keeps RatePlan writes away from the strict API runtime role (`fbeds_api`), so activation and suspension could not succeed
 * in a strict deployment. This login (`fbeds_rateplan_ops`, member of the NOLOGIN group `fbeds_rateplan_status`) closes that gap without widening
 * the runtime role: it may change exactly two columns of RatePlan (`status`, `updated_at`), read the rows the readiness evaluator needs,
 * and append audit events. It cannot INSERT or DELETE a rate plan, cannot touch rates, availability, contracts, inventory or any other table,
 * cannot read the audit log, and row-level security still applies (every use sets the tenant in its transaction). Only
 * `SupplyService.transitionRatePlan` connects with it (`RATE_PLAN_OPS_DATABASE_URL`, which must differ from `DATABASE_URL`).
 */
export const RATE_PLAN_OPS_GROUP_ROLE = 'fbeds_rateplan_status'
export const RATE_PLAN_OPS_LOGIN_ROLE = 'fbeds_rateplan_ops'

type Executor = { $executeRawUnsafe(query: string): Promise<number>; $queryRawUnsafe<T = unknown>(query: string): Promise<T> }

const IDENTIFIER = /^[a-z][a-z0-9_]{2,62}$/
const PASSWORD = /^[A-Za-z0-9_-]{32,128}$/

/** Read-only inputs of the readiness evaluator. Whole-table SELECT is needed because the ORM reads every column of these models. */
export const RATE_PLAN_OPS_READ_TABLES = ['RatePlan', 'RoomType', 'BoardBasis', 'Contract', 'SupplierHotelMapping', 'CancellationPolicy', 'DailyRate', 'DailyAvailability'] as const
/** Hotel is read by column only (identity and time zone). `tenant_id` must be readable for its row-level policy. */
export const RATE_PLAN_OPS_HOTEL_COLUMNS = ['id', 'tenant_id', 'time_zone'] as const
/** The only columns the role may write, and only on RatePlan. */
export const RATE_PLAN_OPS_UPDATE_COLUMNS = { RatePlan: ['status', 'updated_at'] } as const
/** INSERT-only: the audit trail. Not readable by the role. */
export const RATE_PLAN_OPS_INSERT_TABLES = ['AuditEvent'] as const
/** Must stay unreadable and unwritable. Checked by the verifier. */
export const RATE_PLAN_OPS_FORBIDDEN_TABLES = ['users', 'sessions', 'memberships', 'LedgerEntry', 'Wallet', 'Booking', 'BookingGuest', 'InventoryHold', 'Agency', 'ConnectorCredentialReference', 'AuditEvent'] as const

export function assertRatePlanOpsInput(loginRole: string, password: string): void {
  if (!IDENTIFIER.test(loginRole)) throw new Error('Login role must match [a-z][a-z0-9_]{2,62}')
  if (loginRole === RATE_PLAN_OPS_GROUP_ROLE || loginRole === 'postgres') throw new Error('Login role must be dedicated to rate plan transitions')
  if (!PASSWORD.test(password)) throw new Error('Password must be 32-128 URL-safe characters [A-Za-z0-9_-]')
}

/** The one place the role's privileges are stated. */
export function ratePlanOpsGrantStatements(group = RATE_PLAN_OPS_GROUP_ROLE): string[] {
  return [
    `GRANT USAGE ON SCHEMA public TO "${group}"`,
    ...RATE_PLAN_OPS_READ_TABLES.map((table) => `GRANT SELECT ON "${table}" TO "${group}"`),
    `GRANT SELECT (${RATE_PLAN_OPS_HOTEL_COLUMNS.map((c) => `"${c}"`).join(', ')}) ON "Hotel" TO "${group}"`,
    ...RATE_PLAN_OPS_INSERT_TABLES.map((table) => `GRANT INSERT ON "${table}" TO "${group}"`),
    ...Object.entries(RATE_PLAN_OPS_UPDATE_COLUMNS).map(([table, columns]) => `GRANT UPDATE (${columns.map((c) => `"${c}"`).join(', ')}) ON "${table}" TO "${group}"`),
  ]
}

/** Idempotent, owner-run. Never creates SUPERUSER, BYPASSRLS, CREATEROLE, CREATEDB or REPLICATION. Revokes everything first so a stale grant cannot survive. Never log the password. */
export async function provisionRatePlanOpsRole(db: Executor, input: { loginRole?: string; password: string }): Promise<void> {
  const loginRole = input.loginRole ?? RATE_PLAN_OPS_LOGIN_ROLE
  assertRatePlanOpsInput(loginRole, input.password)
  const attributes = 'NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'
  await db.$executeRawUnsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RATE_PLAN_OPS_GROUP_ROLE}') THEN CREATE ROLE "${RATE_PLAN_OPS_GROUP_ROLE}" NOLOGIN ${attributes}; END IF; END $$`)
  await db.$executeRawUnsafe(upsertLoginRoleSql(loginRole, input.password, attributes, 5))
  await db.$executeRawUnsafe(`GRANT "${RATE_PLAN_OPS_GROUP_ROLE}" TO "${loginRole}"`)
  await db.$executeRawUnsafe(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM "${RATE_PLAN_OPS_GROUP_ROLE}"`)
  await db.$executeRawUnsafe(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM "${RATE_PLAN_OPS_GROUP_ROLE}"`)
  // Column ACLs survive a table-level REVOKE, so clear them on the two column-granted tables explicitly (ADR 0037).
  await db.$executeRawUnsafe(`REVOKE ALL (${RATE_PLAN_OPS_HOTEL_COLUMNS.map((c) => `"${c}"`).join(', ')}) ON "Hotel" FROM "${RATE_PLAN_OPS_GROUP_ROLE}"`)
  await db.$executeRawUnsafe(`REVOKE ALL ("status", "updated_at") ON "RatePlan" FROM "${RATE_PLAN_OPS_GROUP_ROLE}"`)
  for (const statement of ratePlanOpsGrantStatements()) await db.$executeRawUnsafe(statement)
}

export async function deprovisionRatePlanOpsRole(db: Executor, loginRole = RATE_PLAN_OPS_LOGIN_ROLE, options: { dropGroup?: boolean } = {}): Promise<void> {
  if (!IDENTIFIER.test(loginRole) || loginRole === RATE_PLAN_OPS_GROUP_ROLE || loginRole === 'postgres') throw new Error('Invalid login role')
  const drop = (role: string) => `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
    IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN EXECUTE 'GRANT "${role}" TO CURRENT_USER WITH INHERIT TRUE, SET TRUE'; END IF;
    DROP OWNED BY "${role}"; DROP ROLE "${role}"; END IF; END $$`
  await db.$executeRawUnsafe(drop(loginRole))
  if (options.dropGroup) await db.$executeRawUnsafe(drop(RATE_PLAN_OPS_GROUP_ROLE))
}

export interface RatePlanOpsRoleReport { ok: boolean; failures: string[] }

/** Run while connected AS the login role. Read-only catalogue checks; returns no secret. */
export async function verifyRatePlanOpsRole(db: Pick<Executor, '$queryRawUnsafe'>): Promise<RatePlanOpsRoleReport> {
  const failures: string[] = []
  const [attrs] = await db.$queryRawUnsafe<Array<{ rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolreplication: boolean; member: boolean; owned: bigint }>>(
    `SELECT r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolreplication,
            pg_has_role(current_user, '${RATE_PLAN_OPS_GROUP_ROLE}', 'MEMBER') AS member,
            (SELECT count(*) FROM pg_tables WHERE tableowner = current_user) AS owned
       FROM pg_roles r WHERE r.rolname = current_user`)
  if (!attrs) return { ok: false, failures: ['role not found'] }
  if (attrs.rolsuper) failures.push('role is SUPERUSER')
  if (attrs.rolbypassrls) failures.push('role has BYPASSRLS')
  if (attrs.rolcreaterole) failures.push('role has CREATEROLE')
  if (attrs.rolcreatedb) failures.push('role has CREATEDB')
  if (attrs.rolreplication) failures.push('role has REPLICATION')
  if (!attrs.member) failures.push(`role is not a member of ${RATE_PLAN_OPS_GROUP_ROLE}`)
  if (Number(attrs.owned) > 0) failures.push('role owns tables')

  const list = (items: readonly string[]) => items.map((t) => `'${t}'`).join(',')
  const count = async (sql: string) => Number((await db.$queryRawUnsafe<Array<{ n: bigint }>>(sql))[0]?.n ?? 0)
  if (await count(`SELECT count(*) AS n FROM unnest(ARRAY[${list(RATE_PLAN_OPS_READ_TABLES)}]) t WHERE NOT has_table_privilege(current_user, format('%I', t), 'SELECT')`) > 0) failures.push('role cannot read an input of the readiness evaluator')
  // No table-level write of any kind anywhere in the schema, except INSERT on the audit log.
  if (await count(`SELECT count(*) AS n FROM pg_tables t WHERE t.schemaname = 'public'
      AND has_table_privilege(current_user, format('%I.%I', t.schemaname, t.tablename), 'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')`) > 0) failures.push('role holds a table-wide UPDATE, DELETE, TRUNCATE, REFERENCES or TRIGGER privilege')
  if (await count(`SELECT count(*) AS n FROM pg_tables t WHERE t.schemaname = 'public' AND t.tablename <> ALL(ARRAY[${list(RATE_PLAN_OPS_INSERT_TABLES)}])
      AND has_table_privilege(current_user, format('%I.%I', t.schemaname, t.tablename), 'INSERT')`) > 0) failures.push('role can insert outside the audit log')
  if (!(await count(`SELECT CASE WHEN has_table_privilege(current_user, '"AuditEvent"', 'INSERT') THEN 1 ELSE 0 END AS n`))) failures.push('role cannot append audit events')
  for (const [table, columns] of Object.entries(RATE_PLAN_OPS_UPDATE_COLUMNS)) {
    const extra = await count(`SELECT count(*) AS n FROM pg_attribute a WHERE a.attrelid = '"${table}"'::regclass AND a.attnum > 0 AND NOT a.attisdropped AND has_column_privilege(current_user, '"${table}"', a.attname, 'UPDATE') AND a.attname <> ALL(ARRAY[${list(columns)}])`)
    const missing = await count(`SELECT count(*) AS n FROM unnest(ARRAY[${list(columns)}]) c WHERE NOT has_column_privilege(current_user, '"${table}"', c, 'UPDATE')`)
    if (extra > 0) failures.push(`role can update a ${table} column outside its set`)
    if (missing > 0) failures.push(`role cannot update every ${table} column it needs`)
  }
  // Writes to other tables, column-level included, are checked by name: none may exist.
  if (await count(`SELECT count(*) AS n FROM information_schema.column_privileges p WHERE p.grantee IN (current_user, '${RATE_PLAN_OPS_GROUP_ROLE}') AND p.privilege_type IN ('UPDATE','INSERT') AND p.table_schema = 'public' AND p.table_name <> ALL(ARRAY['RatePlan','AuditEvent'])`) > 0) failures.push('role holds a column write outside RatePlan and the audit log')
  if (await count(`SELECT count(*) AS n FROM unnest(ARRAY[${list(RATE_PLAN_OPS_FORBIDDEN_TABLES)}]) t WHERE has_table_privilege(current_user, format('%I', t), 'SELECT')`) > 0) failures.push('role can read a table outside the transition scope (including the audit log)')
  const hotelExtra = await count(`SELECT count(*) AS n FROM pg_attribute a WHERE a.attrelid = '"Hotel"'::regclass AND a.attnum > 0 AND NOT a.attisdropped AND has_column_privilege(current_user, '"Hotel"', a.attname, 'SELECT') AND a.attname <> ALL(ARRAY[${list(RATE_PLAN_OPS_HOTEL_COLUMNS)}])`)
  if (hotelExtra > 0 || (await count(`SELECT CASE WHEN has_table_privilege(current_user, '"Hotel"', 'SELECT') THEN 1 ELSE 0 END AS n`)) > 0) failures.push('role can read hotel columns beyond identity and time zone')
  return { ok: failures.length === 0, failures }
}
