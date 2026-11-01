import { upsertLoginRoleSql } from './hold-expiry-role'
import { isDatabasePermissionDenied } from './db-errors'

/**
 * The narrow database role of supplier promotion (ADR 0084).
 *
 * Promotion turns ingested observations (ADR 0078) into contracted rates, availability and pool capacity under the rules of ADR 0082 and 0083. No other principal may write those tables from a
 * feed, and the strict API runtime role must not (ADR 0032). This login (`fbeds_promote_ops`, a member of the NOLOGIN group `fbeds_promote`) reads the observations, the mapping tables and a few
 * plan, pool and hotel columns it needs, writes nightly rates, availability and pool capacity through named columns only, appends its own run evidence and audit events. It can NEVER touch
 * restrictions (minimum stay, closed to arrival or departure), `sold` or `held`, contracts, rate plans, mappings, pools, cancellation policies, markup rules, bookings, finance, credentials, users
 * or sessions, and can never delete anything. Row-level security still applies (every use sets the tenant in its transaction). Only `SupplierPromotionDatabase` connects with it
 * (`SUPPLIER_PROMOTION_DATABASE_URL`, which must differ from `DATABASE_URL`).
 */
export const PROMOTE_GROUP_ROLE = 'fbeds_promote'
export const PROMOTE_LOGIN_ROLE = 'fbeds_promote_ops'

type Executor = { $executeRawUnsafe(query: string): Promise<number>; $queryRawUnsafe<T = unknown>(query: string): Promise<T> }

const IDENTIFIER = /^[a-z][a-z0-9_]{2,62}$/
const PASSWORD = /^[A-Za-z0-9_-]{32,128}$/

/** Read and append: the run evidence, and the three tables promotion writes. */
export const PROMOTE_OWN_TABLES = ['SupplierPromotionRun', 'DailyRate', 'DailyAvailability', 'InventoryPoolDay'] as const
/** Read only, whole table: the observations being promoted. */
export const PROMOTE_READ_TABLES = ['SupplierRateObservation', 'SupplierAllotmentObservation'] as const
/** The only columns the role may update. Identity, restrictions (min_stay, closed_to_*), sold and held are deliberately absent. */
export const PROMOTE_UPDATE_COLUMNS = {
  DailyRate: ['amount_minor', 'amount_basis', 'currency', 'source_version', 'source_updated_at', 'updated_at'],
  DailyAvailability: ['allotment', 'stop_sell', 'release_days', 'inventory_mode', 'source', 'source_updated_at', 'received_at', 'fresh_until', 'updated_at'],
  InventoryPoolDay: ['capacity', 'source', 'source_updated_at', 'received_at', 'fresh_until', 'updated_at'],
} as const
/** Column-level SELECT on tables the role reads but must not read whole. `tenant_id` must be readable for the row-level policy. */
export const PROMOTE_READ_COLUMNS = {
  SupplierHotelMapping: ['id', 'tenant_id', 'supplier_id', 'supplier_hotel_id', 'hotel_id', 'status'],
  SupplierRoomMapping: ['id', 'tenant_id', 'supplier_hotel_mapping_id', 'supplier_room_id', 'room_type_id', 'status'],
  SupplierRatePlanMapping: ['id', 'tenant_id', 'supplier_room_mapping_id', 'supplier_rate_plan_code', 'rate_plan_id', 'status'],
  RatePlan: ['id', 'tenant_id', 'contract_id', 'room_type_id', 'currency', 'taxes_included', 'occupancy', 'derived_from_id', 'inventory_pool_id', 'status'],
  InventoryPool: ['id', 'tenant_id', 'status'],
  Hotel: ['id', 'tenant_id', 'time_zone'],
  /** Which delivery is the latest applied one for a connector and feed kind. No counts, hashes or reject summaries. */
  SupplierIngestRun: ['id', 'tenant_id', 'supplier_id', 'connector_id', 'kind', 'applied', 'received_at'],
} as const
/** INSERT-only: the audit trail. Not readable by the role. */
export const PROMOTE_INSERT_ONLY_TABLES = ['AuditEvent'] as const
/** Must stay unreadable and unwritable. Checked by the verifier. */
export const PROMOTE_FORBIDDEN_TABLES = ['users', 'sessions', 'memberships', 'ConnectorCredentialReference', 'ConnectorDefinition', 'Supplier', 'Contract', 'CancellationPolicy', 'CommercialMarkupRule', 'SupplierCancellationObservation', 'Booking', 'BookingGuest', 'InventoryHold', 'InventoryHoldNight', 'LedgerEntry', 'Wallet', 'AuditEvent'] as const

export function assertPromoteInput(loginRole: string, password: string): void {
  if (!IDENTIFIER.test(loginRole)) throw new Error('Login role must match [a-z][a-z0-9_]{2,62}')
  if (loginRole === PROMOTE_GROUP_ROLE || loginRole === 'postgres') throw new Error('Login role must be dedicated to supplier promotion')
  if (!PASSWORD.test(password)) throw new Error('Password must be 32-128 URL-safe characters [A-Za-z0-9_-]')
}

const cols = (columns: readonly string[]) => columns.map((c) => `"${c}"`).join(', ')

/** The one place the role's privileges are stated. */
export function promoteGrantStatements(group = PROMOTE_GROUP_ROLE): string[] {
  return [
    `GRANT USAGE ON SCHEMA public TO "${group}"`,
    ...PROMOTE_OWN_TABLES.map((table) => `GRANT SELECT, INSERT ON "${table}" TO "${group}"`),
    ...PROMOTE_READ_TABLES.map((table) => `GRANT SELECT ON "${table}" TO "${group}"`),
    ...Object.entries(PROMOTE_UPDATE_COLUMNS).map(([table, columns]) => `GRANT UPDATE (${cols(columns)}) ON "${table}" TO "${group}"`),
    ...Object.entries(PROMOTE_READ_COLUMNS).map(([table, columns]) => `GRANT SELECT (${cols(columns)}) ON "${table}" TO "${group}"`),
    ...PROMOTE_INSERT_ONLY_TABLES.map((table) => `GRANT INSERT ON "${table}" TO "${group}"`),
  ]
}

/** Idempotent, owner-run. Never creates SUPERUSER, BYPASSRLS, CREATEROLE, CREATEDB or REPLICATION. Revokes everything first so a stale grant cannot survive. Never log the password. */
export async function provisionPromoteRole(db: Executor, input: { loginRole?: string; password: string }): Promise<void> {
  const loginRole = input.loginRole ?? PROMOTE_LOGIN_ROLE
  assertPromoteInput(loginRole, input.password)
  const attributes = 'NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'
  await db.$executeRawUnsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${PROMOTE_GROUP_ROLE}') THEN CREATE ROLE "${PROMOTE_GROUP_ROLE}" NOLOGIN ${attributes}; END IF; END $$`)
  await db.$executeRawUnsafe(upsertLoginRoleSql(loginRole, input.password, attributes, 5))
  await db.$executeRawUnsafe(`GRANT "${PROMOTE_GROUP_ROLE}" TO "${loginRole}"`)
  await db.$executeRawUnsafe(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM "${PROMOTE_GROUP_ROLE}"`)
  await db.$executeRawUnsafe(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM "${PROMOTE_GROUP_ROLE}"`)
  // Column ACLs survive a table-level REVOKE, so clear them on every column-granted table explicitly (ADR 0037).
  for (const [table, columns] of [...Object.entries(PROMOTE_UPDATE_COLUMNS), ...Object.entries(PROMOTE_READ_COLUMNS)]) await db.$executeRawUnsafe(`REVOKE ALL (${cols(columns)}) ON "${table}" FROM "${PROMOTE_GROUP_ROLE}"`)
  for (const statement of promoteGrantStatements()) await db.$executeRawUnsafe(statement)
}

export async function deprovisionPromoteRole(db: Executor, loginRole = PROMOTE_LOGIN_ROLE, options: { dropGroup?: boolean } = {}): Promise<void> {
  if (!IDENTIFIER.test(loginRole) || loginRole === PROMOTE_GROUP_ROLE || loginRole === 'postgres') throw new Error('Invalid login role')
  const drop = (role: string) => `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
    IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN EXECUTE 'GRANT "${role}" TO CURRENT_USER WITH INHERIT TRUE, SET TRUE'; END IF;
    DROP OWNED BY "${role}"; DROP ROLE "${role}"; END IF; END $$`
  await db.$executeRawUnsafe(drop(loginRole))
  if (options.dropGroup) await db.$executeRawUnsafe(drop(PROMOTE_GROUP_ROLE))
}

export interface PromoteRoleReport { ok: boolean; failures: string[] }

/** Run while connected AS the login role. Read-only catalogue checks; returns no secret. */
export async function verifyPromoteRole(db: Pick<Executor, '$queryRawUnsafe'>): Promise<PromoteRoleReport> {
  const failures: string[] = []
  const [attrs] = await db.$queryRawUnsafe<Array<{ rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolreplication: boolean; member: boolean; owned: bigint }>>(
    `SELECT r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolreplication,
            pg_has_role(current_user, '${PROMOTE_GROUP_ROLE}', 'MEMBER') AS member,
            (SELECT count(*) FROM pg_tables WHERE tableowner = current_user) AS owned
       FROM pg_roles r WHERE r.rolname = current_user`)
  if (!attrs) return { ok: false, failures: ['role not found'] }
  if (attrs.rolsuper) failures.push('role is SUPERUSER')
  if (attrs.rolbypassrls) failures.push('role has BYPASSRLS')
  if (attrs.rolcreaterole) failures.push('role has CREATEROLE')
  if (attrs.rolcreatedb) failures.push('role has CREATEDB')
  if (attrs.rolreplication) failures.push('role has REPLICATION')
  if (!attrs.member) failures.push(`role is not a member of ${PROMOTE_GROUP_ROLE}`)
  if (Number(attrs.owned) > 0) failures.push('role owns tables')

  const list = (items: readonly string[]) => items.map((t) => `'${t}'`).join(',')
  const count = async (sql: string) => Number((await db.$queryRawUnsafe<Array<{ n: bigint }>>(sql))[0]?.n ?? 0)
  if (await count(`SELECT count(*) AS n FROM unnest(ARRAY[${list(PROMOTE_OWN_TABLES)}]) t WHERE NOT has_table_privilege(current_user, format('%I', t), 'SELECT,INSERT')`) > 0) failures.push('role cannot read and append every promotion table')
  if (await count(`SELECT count(*) AS n FROM unnest(ARRAY[${list(PROMOTE_READ_TABLES)}]) t WHERE NOT has_table_privilege(current_user, format('%I', t), 'SELECT')`) > 0) failures.push('role cannot read the observation tables')
  if (await count(`SELECT count(*) AS n FROM unnest(ARRAY[${list(PROMOTE_READ_TABLES)}]) t WHERE has_table_privilege(current_user, format('%I', t), 'INSERT')`) > 0) failures.push('role can write an observation table')
  // No table-wide UPDATE, DELETE, TRUNCATE, REFERENCES or TRIGGER anywhere; INSERT only on its own tables and the audit log.
  if (await count(`SELECT count(*) AS n FROM pg_tables t WHERE t.schemaname = 'public'
      AND has_table_privilege(current_user, format('%I.%I', t.schemaname, t.tablename), 'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')`) > 0) failures.push('role holds a table-wide UPDATE, DELETE, TRUNCATE, REFERENCES or TRIGGER privilege')
  if (await count(`SELECT count(*) AS n FROM pg_tables t WHERE t.schemaname = 'public' AND t.tablename <> ALL(ARRAY[${list([...PROMOTE_OWN_TABLES, ...PROMOTE_INSERT_ONLY_TABLES])}])
      AND has_table_privilege(current_user, format('%I.%I', t.schemaname, t.tablename), 'INSERT')`) > 0) failures.push('role can insert outside the promotion tables and the audit log')
  for (const [table, columns] of Object.entries(PROMOTE_UPDATE_COLUMNS)) {
    const extra = await count(`SELECT count(*) AS n FROM pg_attribute a WHERE a.attrelid = '"${table}"'::regclass AND a.attnum > 0 AND NOT a.attisdropped AND has_column_privilege(current_user, '"${table}"', a.attname, 'UPDATE') AND a.attname <> ALL(ARRAY[${list(columns)}])`)
    const missing = await count(`SELECT count(*) AS n FROM unnest(ARRAY[${list(columns)}]) c WHERE NOT has_column_privilege(current_user, '"${table}"', c, 'UPDATE')`)
    if (extra > 0) failures.push(`role can update a ${table} column outside its allowed set`)
    if (missing > 0) failures.push(`role cannot update every ${table} column it needs`)
  }
  // The run table is evidence: no column of it is updatable.
  if (await count(`SELECT count(*) AS n FROM pg_attribute a WHERE a.attrelid = '"SupplierPromotionRun"'::regclass AND a.attnum > 0 AND NOT a.attisdropped AND has_column_privilege(current_user, '"SupplierPromotionRun"', a.attname, 'UPDATE')`) > 0) failures.push('role can update a promotion run column')
  for (const [table, columns] of Object.entries(PROMOTE_READ_COLUMNS)) {
    const extra = await count(`SELECT count(*) AS n FROM pg_attribute a WHERE a.attrelid = '"${table}"'::regclass AND a.attnum > 0 AND NOT a.attisdropped AND has_column_privilege(current_user, '"${table}"', a.attname, 'SELECT') AND a.attname <> ALL(ARRAY[${list(columns)}])`)
    const whole = await count(`SELECT CASE WHEN has_table_privilege(current_user, '"${table}"', 'SELECT') THEN 1 ELSE 0 END AS n`)
    if (extra > 0 || whole > 0) failures.push(`role can read ${table} columns beyond the connector status check`)
  }
  if (!(await count(`SELECT CASE WHEN has_table_privilege(current_user, '"AuditEvent"', 'INSERT') THEN 1 ELSE 0 END AS n`))) failures.push('role cannot append audit events')
  if (await count(`SELECT count(*) AS n FROM unnest(ARRAY[${list(PROMOTE_FORBIDDEN_TABLES)}]) t WHERE has_table_privilege(current_user, format('%I', t), 'SELECT')`) > 0) failures.push('role can read a table outside the promotion scope')
  if (await count(`SELECT count(*) AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prosecdef AND has_function_privilege(current_user, p.oid, 'EXECUTE')`) > 0) failures.push('role can execute a SECURITY DEFINER function')
  return { ok: failures.length === 0, failures }
}

export interface PromoteProbe { name: string; sql: string; expect: 'allowed' | 'denied' }
export interface PromoteProbeResult { name: string; expect: 'allowed' | 'denied'; ok: boolean }

const denyInsert = (table: string): PromoteProbe => ({ name: `INSERT ${table}`, sql: `INSERT INTO "${table}" ("id") SELECT 'x' WHERE false`, expect: 'denied' })
const denySelect = (table: string): PromoteProbe => ({ name: `SELECT ${table}`, sql: `SELECT "id" FROM "${table}" WHERE false`, expect: 'denied' })
const upd = (table: string, column: string, expectation: 'allowed' | 'denied'): PromoteProbe => ({ name: `UPDATE ${table}.${column}`, sql: `UPDATE "${table}" SET "${column}" = "${column}" WHERE false`, expect: expectation })

/**
 * Privilege probes. Every statement is `WHERE false`, so PostgreSQL decides on privilege at plan time and no row is read or written. Denied probes on a table this role must not write are
 * schema-qualified where the runtime-role contract spec would otherwise read them as application writes.
 */
export const PROMOTE_PROBES: readonly PromoteProbe[] = [
  ...PROMOTE_OWN_TABLES.flatMap((table): PromoteProbe[] => [
    { name: `SELECT ${table}`, sql: `SELECT "id" FROM "${table}" WHERE false`, expect: 'allowed' },
    { name: `INSERT ${table}`, sql: `INSERT INTO "${table}" ("id") SELECT 'x' WHERE false`, expect: 'allowed' },
    { name: `DELETE ${table}`, sql: `DELETE FROM "${table}" WHERE false`, expect: 'denied' },
  ]),
  ...PROMOTE_READ_TABLES.flatMap((table): PromoteProbe[] => [
    { name: `SELECT ${table}`, sql: `SELECT "id" FROM "${table}" WHERE false`, expect: 'allowed' },
    { name: `INSERT ${table}`, sql: `INSERT INTO public."${table}" ("id") SELECT 'x' WHERE false`, expect: 'denied' },
    { name: `UPDATE ${table}`, sql: `UPDATE public."${table}" SET "run_id" = "run_id" WHERE false`, expect: 'denied' },
  ]),
  ...Object.entries(PROMOTE_UPDATE_COLUMNS).flatMap(([table, columns]) => columns.map((c) => upd(table, c, 'allowed'))),
  upd('DailyRate', 'tenant_id', 'denied'), upd('DailyRate', 'rate_plan_id', 'denied'), upd('DailyRate', 'stay_date', 'denied'), upd('DailyRate', 'occupancy', 'denied'),
  upd('DailyAvailability', 'sold', 'denied'), upd('DailyAvailability', 'held', 'denied'), upd('DailyAvailability', 'min_stay', 'denied'), upd('DailyAvailability', 'closed_to_arrival', 'denied'),
  upd('DailyAvailability', 'closed_to_departure', 'denied'), upd('DailyAvailability', 'rate_plan_id', 'denied'), upd('DailyAvailability', 'stay_date', 'denied'),
  upd('InventoryPoolDay', 'sold', 'denied'), upd('InventoryPoolDay', 'held', 'denied'), upd('InventoryPoolDay', 'pool_id', 'denied'), upd('InventoryPoolDay', 'stay_date', 'denied'),
  upd('SupplierPromotionRun', 'status', 'denied'),
  { name: 'SELECT ratePlan columns', sql: `SELECT "id", "tenant_id", "contract_id", "room_type_id", "currency", "taxes_included", "occupancy", "derived_from_id", "inventory_pool_id", "status" FROM "RatePlan" WHERE false`, expect: 'allowed' },
  { name: 'SELECT mapping columns', sql: `SELECT m."id", r."id", p."id" FROM "SupplierHotelMapping" m, "SupplierRoomMapping" r, "SupplierRatePlanMapping" p WHERE false`, expect: 'allowed' },
  { name: 'SELECT InventoryPool status', sql: `SELECT "id", "tenant_id", "status" FROM "InventoryPool" WHERE false`, expect: 'allowed' },
  { name: 'SELECT SupplierIngestRun latest columns', sql: `SELECT "id", "tenant_id", "supplier_id", "connector_id", "kind", "applied", "received_at" FROM "SupplierIngestRun" WHERE false`, expect: 'allowed' },
  { name: 'SELECT SupplierIngestRun.request_hash', sql: `SELECT "request_hash" FROM "SupplierIngestRun" WHERE false`, expect: 'denied' },
  { name: 'INSERT SupplierIngestRun', sql: `INSERT INTO public."SupplierIngestRun" ("id") SELECT 'x' WHERE false`, expect: 'denied' },
  { name: 'SELECT Hotel time_zone', sql: `SELECT "id", "tenant_id", "time_zone" FROM "Hotel" WHERE false`, expect: 'allowed' },
  { name: 'INSERT AuditEvent', sql: `INSERT INTO "AuditEvent" ("id") SELECT 'x' WHERE false`, expect: 'allowed' },
  { name: 'SELECT RatePlan.code', sql: `SELECT "code" FROM "RatePlan" WHERE false`, expect: 'denied' },
  { name: 'SELECT Hotel.name', sql: `SELECT "name" FROM "Hotel" WHERE false`, expect: 'denied' },
  { name: 'UPDATE RatePlan', sql: `UPDATE public."RatePlan" SET "status" = "status" WHERE false`, expect: 'denied' },
  { name: 'UPDATE InventoryPool', sql: `UPDATE public."InventoryPool" SET "status" = "status" WHERE false`, expect: 'denied' },
  { name: 'UPDATE SupplierRatePlanMapping', sql: `UPDATE public."SupplierRatePlanMapping" SET "status" = "status" WHERE false`, expect: 'denied' },
  { name: 'INSERT SupplierRatePlanMapping', sql: `INSERT INTO public."SupplierRatePlanMapping" ("id") SELECT 'x' WHERE false`, expect: 'denied' },
  { name: 'INSERT RatePlan', sql: `INSERT INTO public."RatePlan" ("id") SELECT 'x' WHERE false`, expect: 'denied' },
  { name: 'SELECT Contract', sql: `SELECT "id" FROM "Contract" WHERE false`, expect: 'denied' },
  ...['CancellationPolicy', 'CommercialMarkupRule', 'SupplierCancellationObservation', 'Booking', 'LedgerEntry', 'Wallet', 'ConnectorDefinition', 'Supplier'].flatMap((t) => [denyInsert(t), denySelect(t)]),
  { name: 'SELECT ConnectorCredentialReference', sql: `SELECT "id" FROM "ConnectorCredentialReference" WHERE false`, expect: 'denied' },
  { name: 'SELECT AuditEvent', sql: `SELECT "id" FROM "AuditEvent" WHERE false`, expect: 'denied' },
  { name: 'SELECT users', sql: `SELECT "id" FROM "users" WHERE false`, expect: 'denied' },
]

/** A probe is ok when an `allowed` statement runs, or a `denied` statement fails with insufficient_privilege (any other failure is not a pass). */
export async function runPromoteProbes(db: Executor): Promise<PromoteProbeResult[]> {
  const results: PromoteProbeResult[] = []
  for (const probe of PROMOTE_PROBES) {
    let outcome: 'allowed' | 'denied' | 'error' = 'allowed'
    try { await (probe.sql.startsWith('SELECT') ? db.$queryRawUnsafe(probe.sql) : db.$executeRawUnsafe(probe.sql)) } catch (error) {
      outcome = isDatabasePermissionDenied(error) ? 'denied' : 'error'
    }
    results.push({ name: probe.name, expect: probe.expect, ok: outcome === probe.expect })
  }
  return results
}

export interface PromoteCertification { ok: boolean; role: PromoteRoleReport; probes: PromoteProbeResult[] }

/** Run while connected AS the promotion login. Read-only. */
export async function certifyPromoteRole(db: Executor): Promise<PromoteCertification> {
  const role = await verifyPromoteRole(db)
  const probes = await runPromoteProbes(db)
  return { ok: role.ok && probes.every((p) => p.ok), role, probes }
}
