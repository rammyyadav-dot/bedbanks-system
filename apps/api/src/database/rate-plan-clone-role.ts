import { upsertLoginRoleSql } from './hold-expiry-role'

/**
 * The narrow database role that INSERTs a cloned rate plan (ADR 0057, S8, decision D5).
 *
 * ADR 0032 keeps RatePlan writes away from the strict API runtime role, and the lifecycle role (ADR 0041 Amendment 2) must not insert. This login
 * (`fbeds_rateplan_cloner`, member of the NOLOGIN group `fbeds_rateplan_clone`) may INSERT into RatePlan and append audit events, and read exactly the
 * rows a clone copies from. It cannot UPDATE or DELETE anything, cannot write rates, availability, contracts or inventory, and cannot read the
 * audit log. A database trigger (migration `202611150001`) refuses any insert that is not a DRAFT without an inventory pool, so even this role can
 * never create a sellable plan or bypass the activation approval. Row-level security still applies. Only `SupplyService.cloneRatePlan` uses it
 * (`RATE_PLAN_CLONE_DATABASE_URL`, which must differ from `DATABASE_URL`).
 */
export const RATE_PLAN_CLONE_GROUP_ROLE = 'fbeds_rateplan_clone'
export const RATE_PLAN_CLONE_LOGIN_ROLE = 'fbeds_rateplan_cloner'

type Executor = { $executeRawUnsafe(query: string): Promise<number>; $queryRawUnsafe<T = unknown>(query: string): Promise<T> }

const IDENTIFIER = /^[a-z][a-z0-9_]{2,62}$/
const PASSWORD = /^[A-Za-z0-9_-]{32,128}$/

/** What a clone reads: the source plan, both rooms, and the contract with its hotel mapping. Whole-table SELECT because the ORM reads every column. */
export const RATE_PLAN_CLONE_READ_TABLES = ['RatePlan', 'RoomType', 'Contract', 'SupplierHotelMapping'] as const
/** Hotel is read by column only: RoomType's row-level policy and the clone's room lookup go through the hotel's tenant. Nothing else about a hotel is readable. */
export const RATE_PLAN_CLONE_HOTEL_COLUMNS = ['id', 'tenant_id'] as const
/** INSERT-only. RatePlan is the clone itself; AuditEvent is the trail and is not readable by the role. */
export const RATE_PLAN_CLONE_INSERT_TABLES = ['RatePlan', 'AuditEvent'] as const
/** Must stay unreadable. Checked by the verifier. */
export const RATE_PLAN_CLONE_FORBIDDEN_TABLES = ['users', 'sessions', 'memberships', 'LedgerEntry', 'Wallet', 'Booking', 'BookingGuest', 'InventoryHold', 'Agency', 'ConnectorCredentialReference', 'AuditEvent', 'DailyRate', 'DailyAvailability', 'tenants'] as const

export function assertRatePlanCloneInput(loginRole: string, password: string): void {
  if (!IDENTIFIER.test(loginRole)) throw new Error('Login role must match [a-z][a-z0-9_]{2,62}')
  if (loginRole === RATE_PLAN_CLONE_GROUP_ROLE || loginRole === 'postgres') throw new Error('Login role must be dedicated to rate plan cloning')
  if (!PASSWORD.test(password)) throw new Error('Password must be 32-128 URL-safe characters [A-Za-z0-9_-]')
}

/** The one place the role's privileges are stated. */
export function ratePlanCloneGrantStatements(group = RATE_PLAN_CLONE_GROUP_ROLE): string[] {
  return [
    `GRANT USAGE ON SCHEMA public TO "${group}"`,
    ...RATE_PLAN_CLONE_READ_TABLES.map((table) => `GRANT SELECT ON "${table}" TO "${group}"`),
    `GRANT SELECT (${RATE_PLAN_CLONE_HOTEL_COLUMNS.map((c) => `"${c}"`).join(', ')}) ON "Hotel" TO "${group}"`,
    ...RATE_PLAN_CLONE_INSERT_TABLES.map((table) => `GRANT INSERT ON "${table}" TO "${group}"`),
  ]
}

/** Idempotent, owner-run. Never creates SUPERUSER, BYPASSRLS, CREATEROLE, CREATEDB or REPLICATION. Revokes everything first so a stale grant cannot survive. Never log the password. */
export async function provisionRatePlanCloneRole(db: Executor, input: { loginRole?: string; password: string }): Promise<void> {
  const loginRole = input.loginRole ?? RATE_PLAN_CLONE_LOGIN_ROLE
  assertRatePlanCloneInput(loginRole, input.password)
  const attributes = 'NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'
  await db.$executeRawUnsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RATE_PLAN_CLONE_GROUP_ROLE}') THEN CREATE ROLE "${RATE_PLAN_CLONE_GROUP_ROLE}" NOLOGIN ${attributes}; END IF; END $$`)
  await db.$executeRawUnsafe(upsertLoginRoleSql(loginRole, input.password, attributes, 5))
  await db.$executeRawUnsafe(`GRANT "${RATE_PLAN_CLONE_GROUP_ROLE}" TO "${loginRole}"`)
  await db.$executeRawUnsafe(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM "${RATE_PLAN_CLONE_GROUP_ROLE}"`)
  await db.$executeRawUnsafe(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM "${RATE_PLAN_CLONE_GROUP_ROLE}"`)
  // Column ACLs survive a table-level REVOKE, so clear the column-granted table explicitly (ADR 0037).
  await db.$executeRawUnsafe(`REVOKE ALL (${RATE_PLAN_CLONE_HOTEL_COLUMNS.map((c) => `"${c}"`).join(', ')}) ON "Hotel" FROM "${RATE_PLAN_CLONE_GROUP_ROLE}"`)
  for (const statement of ratePlanCloneGrantStatements()) await db.$executeRawUnsafe(statement)
}

export async function deprovisionRatePlanCloneRole(db: Executor, loginRole = RATE_PLAN_CLONE_LOGIN_ROLE, options: { dropGroup?: boolean } = {}): Promise<void> {
  if (!IDENTIFIER.test(loginRole) || loginRole === RATE_PLAN_CLONE_GROUP_ROLE || loginRole === 'postgres') throw new Error('Invalid login role')
  const drop = (role: string) => `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
    IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN EXECUTE 'GRANT "${role}" TO CURRENT_USER WITH INHERIT TRUE, SET TRUE'; END IF;
    DROP OWNED BY "${role}"; DROP ROLE "${role}"; END IF; END $$`
  await db.$executeRawUnsafe(drop(loginRole))
  if (options.dropGroup) await db.$executeRawUnsafe(drop(RATE_PLAN_CLONE_GROUP_ROLE))
}

export interface RatePlanCloneRoleReport { ok: boolean; failures: string[] }

/** Run while connected AS the login role. Read-only catalogue checks; returns no secret. */
export async function verifyRatePlanCloneRole(db: Pick<Executor, '$queryRawUnsafe'>): Promise<RatePlanCloneRoleReport> {
  const failures: string[] = []
  const [attrs] = await db.$queryRawUnsafe<Array<{ rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolreplication: boolean; member: boolean; owned: bigint }>>(
    `SELECT r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolreplication,
            pg_has_role(current_user, '${RATE_PLAN_CLONE_GROUP_ROLE}', 'MEMBER') AS member,
            (SELECT count(*) FROM pg_tables WHERE tableowner = current_user) AS owned
       FROM pg_roles r WHERE r.rolname = current_user`)
  if (!attrs) return { ok: false, failures: ['role not found'] }
  if (attrs.rolsuper) failures.push('role is SUPERUSER')
  if (attrs.rolbypassrls) failures.push('role has BYPASSRLS')
  if (attrs.rolcreaterole) failures.push('role has CREATEROLE')
  if (attrs.rolcreatedb) failures.push('role has CREATEDB')
  if (attrs.rolreplication) failures.push('role has REPLICATION')
  if (!attrs.member) failures.push(`role is not a member of ${RATE_PLAN_CLONE_GROUP_ROLE}`)
  if (Number(attrs.owned) > 0) failures.push('role owns tables')

  const list = (items: readonly string[]) => items.map((t) => `'${t}'`).join(',')
  const count = async (sql: string) => Number((await db.$queryRawUnsafe<Array<{ n: bigint }>>(sql))[0]?.n ?? 0)
  if (await count(`SELECT count(*) AS n FROM unnest(ARRAY[${list(RATE_PLAN_CLONE_READ_TABLES)}]) t WHERE NOT has_table_privilege(current_user, format('%I', t), 'SELECT')`) > 0) failures.push('role cannot read an input of a clone')
  // No UPDATE, DELETE, TRUNCATE, REFERENCES or TRIGGER anywhere, at table or column level.
  if (await count(`SELECT count(*) AS n FROM pg_tables t WHERE t.schemaname = 'public'
      AND has_table_privilege(current_user, format('%I.%I', t.schemaname, t.tablename), 'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')`) > 0) failures.push('role holds a table-wide UPDATE, DELETE, TRUNCATE, REFERENCES or TRIGGER privilege')
  if (await count(`SELECT count(*) AS n FROM information_schema.column_privileges p WHERE p.grantee IN (current_user, '${RATE_PLAN_CLONE_GROUP_ROLE}') AND p.privilege_type = 'UPDATE' AND p.table_schema = 'public'`) > 0) failures.push('role holds a column-level UPDATE privilege')
  // INSERT only on RatePlan and AuditEvent.
  if (await count(`SELECT count(*) AS n FROM pg_tables t WHERE t.schemaname = 'public' AND t.tablename <> ALL(ARRAY[${list(RATE_PLAN_CLONE_INSERT_TABLES)}])
      AND has_table_privilege(current_user, format('%I.%I', t.schemaname, t.tablename), 'INSERT')`) > 0) failures.push('role can insert outside RatePlan and the audit log')
  if (await count(`SELECT count(*) AS n FROM unnest(ARRAY[${list(RATE_PLAN_CLONE_INSERT_TABLES)}]) t WHERE NOT has_table_privilege(current_user, format('%I', t), 'INSERT')`) > 0) failures.push('role cannot insert what a clone needs')
  if (await count(`SELECT count(*) AS n FROM unnest(ARRAY[${list(RATE_PLAN_CLONE_FORBIDDEN_TABLES)}]) t WHERE has_table_privilege(current_user, format('%I', t), 'SELECT')`) > 0) failures.push('role can read a table outside what a clone needs')
  const hotelExtra = await count(`SELECT count(*) AS n FROM pg_attribute a WHERE a.attrelid = '"Hotel"'::regclass AND a.attnum > 0 AND NOT a.attisdropped AND has_column_privilege(current_user, '"Hotel"', a.attname, 'SELECT') AND a.attname <> ALL(ARRAY[${list(RATE_PLAN_CLONE_HOTEL_COLUMNS)}])`)
  if (hotelExtra > 0 || (await count(`SELECT CASE WHEN has_table_privilege(current_user, '"Hotel"', 'SELECT') THEN 1 ELSE 0 END AS n`)) > 0) failures.push('role can read hotel columns beyond id and tenant')
  // The trigger that makes DRAFT-only a database rule must exist and be enabled.
  if (await count(`SELECT count(*) AS n FROM pg_trigger WHERE tgrelid = '"RatePlan"'::regclass AND tgname = 'RatePlan_clone_guard' AND tgenabled = 'O'`) !== 1) failures.push('the DRAFT-only guard trigger is missing or disabled')
  return { ok: failures.length === 0, failures }
}
