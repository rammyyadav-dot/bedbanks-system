import { upsertLoginRoleSql } from './hold-expiry-role'
import { isDatabasePermissionDenied } from './db-errors'

/**
 * The narrow database role of supplier ingestion (ADR 0079).
 *
 * ADR 0078 stores normalized feeds as observations and keeps those tables away from the strict API runtime role (ADR 0032). This login (`fbeds_ingest_ops`, member of the
 * NOLOGIN group `fbeds_ingest`) is the one principal that writes them. It may read and append the four ingestion tables, refresh only the value columns of an observation (never its
 * identity), read four columns of the connector registry to check a connector is ACTIVE for its supplier, and append audit events. It can NEVER touch contracted rates, availability,
 * cancellation policies, rate plans, mappings, suppliers, bookings, finance, credentials, users or sessions, can never update or delete an ingestion run, and can never delete an
 * observation. Row-level security still applies (every use sets the tenant in its transaction). Only `SupplierIngestDatabase` connects with it (`SUPPLIER_INGEST_DATABASE_URL`,
 * which must differ from `DATABASE_URL`).
 */
export const INGEST_GROUP_ROLE = 'fbeds_ingest'
export const INGEST_LOGIN_ROLE = 'fbeds_ingest_ops'

type Executor = { $executeRawUnsafe(query: string): Promise<number>; $queryRawUnsafe<T = unknown>(query: string): Promise<T> }

const IDENTIFIER = /^[a-z][a-z0-9_]{2,62}$/
const PASSWORD = /^[A-Za-z0-9_-]{32,128}$/

/** Read and append. The run table has no UPDATE grant (and a trigger forbids it); nothing here has a DELETE grant. */
export const INGEST_OWN_TABLES = ['SupplierIngestRun', 'SupplierRateObservation', 'SupplierAllotmentObservation', 'SupplierCancellationObservation'] as const
/** The only columns the role may update: the observed values and their freshness. Tenant, supplier, supplier codes, stay date and creation time are not here. */
export const INGEST_UPDATE_COLUMNS = {
  SupplierRateObservation: ['run_id', 'board_code', 'currency', 'net_minor', 'taxes_included', 'min_stay', 'max_stay', 'closed_to_arrival', 'closed_to_departure', 'received_at', 'fresh_until', 'updated_at'],
  SupplierAllotmentObservation: ['run_id', 'mode', 'available', 'stop_sell', 'release_days', 'received_at', 'fresh_until', 'updated_at'],
  SupplierCancellationObservation: ['run_id', 'non_refundable', 'windows', 'received_at', 'fresh_until', 'updated_at'],
} as const
/** Column-level SELECT on tables the role reads but must not read whole. `tenant_id` must be readable for the row-level policy. Transport metadata and credentials stay unreadable. */
export const INGEST_READ_COLUMNS = {
  ConnectorDefinition: ['id', 'tenant_id', 'supplier_id', 'status'],
} as const
/** INSERT-only: the audit trail. Not readable by the role. */
export const INGEST_INSERT_ONLY_TABLES = ['AuditEvent'] as const
/** Must stay unreadable and unwritable. Checked by the verifier. */
export const INGEST_FORBIDDEN_TABLES = ['users', 'sessions', 'memberships', 'ConnectorCredentialReference', 'Supplier', 'SupplierHotelMapping', 'SupplierRoomMapping', 'DailyRate', 'DailyAvailability', 'CancellationPolicy', 'RatePlan', 'Contract', 'Booking', 'BookingGuest', 'InventoryHold', 'LedgerEntry', 'Wallet', 'AuditEvent'] as const

export function assertIngestInput(loginRole: string, password: string): void {
  if (!IDENTIFIER.test(loginRole)) throw new Error('Login role must match [a-z][a-z0-9_]{2,62}')
  if (loginRole === INGEST_GROUP_ROLE || loginRole === 'postgres') throw new Error('Login role must be dedicated to supplier ingestion')
  if (!PASSWORD.test(password)) throw new Error('Password must be 32-128 URL-safe characters [A-Za-z0-9_-]')
}

const cols = (columns: readonly string[]) => columns.map((c) => `"${c}"`).join(', ')

/** The one place the role's privileges are stated. */
export function ingestGrantStatements(group = INGEST_GROUP_ROLE): string[] {
  return [
    `GRANT USAGE ON SCHEMA public TO "${group}"`,
    ...INGEST_OWN_TABLES.map((table) => `GRANT SELECT, INSERT ON "${table}" TO "${group}"`),
    ...Object.entries(INGEST_UPDATE_COLUMNS).map(([table, columns]) => `GRANT UPDATE (${cols(columns)}) ON "${table}" TO "${group}"`),
    ...Object.entries(INGEST_READ_COLUMNS).map(([table, columns]) => `GRANT SELECT (${cols(columns)}) ON "${table}" TO "${group}"`),
    ...INGEST_INSERT_ONLY_TABLES.map((table) => `GRANT INSERT ON "${table}" TO "${group}"`),
  ]
}

/** Idempotent, owner-run. Never creates SUPERUSER, BYPASSRLS, CREATEROLE, CREATEDB or REPLICATION. Revokes everything first so a stale grant cannot survive. Never log the password. */
export async function provisionIngestRole(db: Executor, input: { loginRole?: string; password: string }): Promise<void> {
  const loginRole = input.loginRole ?? INGEST_LOGIN_ROLE
  assertIngestInput(loginRole, input.password)
  const attributes = 'NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'
  await db.$executeRawUnsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${INGEST_GROUP_ROLE}') THEN CREATE ROLE "${INGEST_GROUP_ROLE}" NOLOGIN ${attributes}; END IF; END $$`)
  await db.$executeRawUnsafe(upsertLoginRoleSql(loginRole, input.password, attributes, 5))
  await db.$executeRawUnsafe(`GRANT "${INGEST_GROUP_ROLE}" TO "${loginRole}"`)
  await db.$executeRawUnsafe(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM "${INGEST_GROUP_ROLE}"`)
  await db.$executeRawUnsafe(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM "${INGEST_GROUP_ROLE}"`)
  // Column ACLs survive a table-level REVOKE, so clear them on every column-granted table explicitly (ADR 0037).
  for (const [table, columns] of [...Object.entries(INGEST_UPDATE_COLUMNS), ...Object.entries(INGEST_READ_COLUMNS)]) await db.$executeRawUnsafe(`REVOKE ALL (${cols(columns)}) ON "${table}" FROM "${INGEST_GROUP_ROLE}"`)
  for (const statement of ingestGrantStatements()) await db.$executeRawUnsafe(statement)
}

export async function deprovisionIngestRole(db: Executor, loginRole = INGEST_LOGIN_ROLE, options: { dropGroup?: boolean } = {}): Promise<void> {
  if (!IDENTIFIER.test(loginRole) || loginRole === INGEST_GROUP_ROLE || loginRole === 'postgres') throw new Error('Invalid login role')
  const drop = (role: string) => `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
    IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN EXECUTE 'GRANT "${role}" TO CURRENT_USER WITH INHERIT TRUE, SET TRUE'; END IF;
    DROP OWNED BY "${role}"; DROP ROLE "${role}"; END IF; END $$`
  await db.$executeRawUnsafe(drop(loginRole))
  if (options.dropGroup) await db.$executeRawUnsafe(drop(INGEST_GROUP_ROLE))
}

export interface IngestRoleReport { ok: boolean; failures: string[] }

/** Run while connected AS the login role. Read-only catalogue checks; returns no secret. */
export async function verifyIngestRole(db: Pick<Executor, '$queryRawUnsafe'>): Promise<IngestRoleReport> {
  const failures: string[] = []
  const [attrs] = await db.$queryRawUnsafe<Array<{ rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolreplication: boolean; member: boolean; owned: bigint }>>(
    `SELECT r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolreplication,
            pg_has_role(current_user, '${INGEST_GROUP_ROLE}', 'MEMBER') AS member,
            (SELECT count(*) FROM pg_tables WHERE tableowner = current_user) AS owned
       FROM pg_roles r WHERE r.rolname = current_user`)
  if (!attrs) return { ok: false, failures: ['role not found'] }
  if (attrs.rolsuper) failures.push('role is SUPERUSER')
  if (attrs.rolbypassrls) failures.push('role has BYPASSRLS')
  if (attrs.rolcreaterole) failures.push('role has CREATEROLE')
  if (attrs.rolcreatedb) failures.push('role has CREATEDB')
  if (attrs.rolreplication) failures.push('role has REPLICATION')
  if (!attrs.member) failures.push(`role is not a member of ${INGEST_GROUP_ROLE}`)
  if (Number(attrs.owned) > 0) failures.push('role owns tables')

  const list = (items: readonly string[]) => items.map((t) => `'${t}'`).join(',')
  const count = async (sql: string) => Number((await db.$queryRawUnsafe<Array<{ n: bigint }>>(sql))[0]?.n ?? 0)
  if (await count(`SELECT count(*) AS n FROM unnest(ARRAY[${list(INGEST_OWN_TABLES)}]) t WHERE NOT has_table_privilege(current_user, format('%I', t), 'SELECT,INSERT')`) > 0) failures.push('role cannot read and append every ingestion table')
  // No table-wide UPDATE, DELETE, TRUNCATE, REFERENCES or TRIGGER anywhere; INSERT only on its own tables and the audit log.
  if (await count(`SELECT count(*) AS n FROM pg_tables t WHERE t.schemaname = 'public'
      AND has_table_privilege(current_user, format('%I.%I', t.schemaname, t.tablename), 'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')`) > 0) failures.push('role holds a table-wide UPDATE, DELETE, TRUNCATE, REFERENCES or TRIGGER privilege')
  if (await count(`SELECT count(*) AS n FROM pg_tables t WHERE t.schemaname = 'public' AND t.tablename <> ALL(ARRAY[${list([...INGEST_OWN_TABLES, ...INGEST_INSERT_ONLY_TABLES])}])
      AND has_table_privilege(current_user, format('%I.%I', t.schemaname, t.tablename), 'INSERT')`) > 0) failures.push('role can insert outside the ingestion tables and the audit log')
  for (const [table, columns] of Object.entries(INGEST_UPDATE_COLUMNS)) {
    const extra = await count(`SELECT count(*) AS n FROM pg_attribute a WHERE a.attrelid = '"${table}"'::regclass AND a.attnum > 0 AND NOT a.attisdropped AND has_column_privilege(current_user, '"${table}"', a.attname, 'UPDATE') AND a.attname <> ALL(ARRAY[${list(columns)}])`)
    const missing = await count(`SELECT count(*) AS n FROM unnest(ARRAY[${list(columns)}]) c WHERE NOT has_column_privilege(current_user, '"${table}"', c, 'UPDATE')`)
    if (extra > 0) failures.push(`role can update a ${table} column outside its allowed set`)
    if (missing > 0) failures.push(`role cannot update every ${table} column it needs`)
  }
  // The run table is evidence: no column of it is updatable.
  if (await count(`SELECT count(*) AS n FROM pg_attribute a WHERE a.attrelid = '"SupplierIngestRun"'::regclass AND a.attnum > 0 AND NOT a.attisdropped AND has_column_privilege(current_user, '"SupplierIngestRun"', a.attname, 'UPDATE')`) > 0) failures.push('role can update an ingestion run column')
  for (const [table, columns] of Object.entries(INGEST_READ_COLUMNS)) {
    const extra = await count(`SELECT count(*) AS n FROM pg_attribute a WHERE a.attrelid = '"${table}"'::regclass AND a.attnum > 0 AND NOT a.attisdropped AND has_column_privilege(current_user, '"${table}"', a.attname, 'SELECT') AND a.attname <> ALL(ARRAY[${list(columns)}])`)
    const whole = await count(`SELECT CASE WHEN has_table_privilege(current_user, '"${table}"', 'SELECT') THEN 1 ELSE 0 END AS n`)
    if (extra > 0 || whole > 0) failures.push(`role can read ${table} columns beyond the connector status check`)
  }
  if (!(await count(`SELECT CASE WHEN has_table_privilege(current_user, '"AuditEvent"', 'INSERT') THEN 1 ELSE 0 END AS n`))) failures.push('role cannot append audit events')
  if (await count(`SELECT count(*) AS n FROM unnest(ARRAY[${list(INGEST_FORBIDDEN_TABLES)}]) t WHERE has_table_privilege(current_user, format('%I', t), 'SELECT')`) > 0) failures.push('role can read a table outside the ingestion scope')
  if (await count(`SELECT count(*) AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prosecdef AND has_function_privilege(current_user, p.oid, 'EXECUTE')`) > 0) failures.push('role can execute a SECURITY DEFINER function')
  return { ok: failures.length === 0, failures }
}

export interface IngestProbe { name: string; sql: string; expect: 'allowed' | 'denied' }
export interface IngestProbeResult { name: string; expect: 'allowed' | 'denied'; ok: boolean }

const denyInsert = (table: string): IngestProbe => ({ name: `INSERT ${table}`, sql: `INSERT INTO "${table}" ("id") SELECT 'x' WHERE false`, expect: 'denied' })
const denySelect = (table: string): IngestProbe => ({ name: `SELECT ${table}`, sql: `SELECT "id" FROM "${table}" WHERE false`, expect: 'denied' })

/**
 * Privilege probes. Denied probes on a table this role must not write are schema-qualified where the runtime-role contract spec would otherwise read them as application writes.
 * Every statement is `WHERE false`, so PostgreSQL decides on privilege at plan time and no row is read or written. */
export const INGEST_PROBES: readonly IngestProbe[] = [
  ...INGEST_OWN_TABLES.flatMap((table): IngestProbe[] => [
    { name: `SELECT ${table}`, sql: `SELECT "id" FROM "${table}" WHERE false`, expect: 'allowed' },
    { name: `INSERT ${table}`, sql: `INSERT INTO "${table}" ("id") SELECT 'x' WHERE false`, expect: 'allowed' },
    { name: `DELETE ${table}`, sql: `DELETE FROM "${table}" WHERE false`, expect: 'denied' },
  ]),
  { name: 'UPDATE SupplierRateObservation.net_minor', sql: `UPDATE "SupplierRateObservation" SET "net_minor" = "net_minor" WHERE false`, expect: 'allowed' },
  { name: 'UPDATE SupplierAllotmentObservation.available', sql: `UPDATE "SupplierAllotmentObservation" SET "available" = "available" WHERE false`, expect: 'allowed' },
  { name: 'UPDATE SupplierCancellationObservation.windows', sql: `UPDATE "SupplierCancellationObservation" SET "windows" = "windows" WHERE false`, expect: 'allowed' },
  { name: 'SELECT ConnectorDefinition status', sql: `SELECT "id", "tenant_id", "supplier_id", "status" FROM "ConnectorDefinition" WHERE false`, expect: 'allowed' },
  { name: 'INSERT AuditEvent', sql: `INSERT INTO "AuditEvent" ("id") SELECT 'x' WHERE false`, expect: 'allowed' },
  { name: 'UPDATE SupplierIngestRun.status', sql: `UPDATE "SupplierIngestRun" SET "status" = "status" WHERE false`, expect: 'denied' },
  { name: 'UPDATE SupplierRateObservation.tenant_id', sql: `UPDATE "SupplierRateObservation" SET "tenant_id" = "tenant_id" WHERE false`, expect: 'denied' },
  { name: 'UPDATE SupplierRateObservation.supplier_hotel_code', sql: `UPDATE "SupplierRateObservation" SET "supplier_hotel_code" = "supplier_hotel_code" WHERE false`, expect: 'denied' },
  { name: 'UPDATE SupplierRateObservation.stay_date', sql: `UPDATE "SupplierRateObservation" SET "stay_date" = "stay_date" WHERE false`, expect: 'denied' },
  { name: 'UPDATE SupplierAllotmentObservation.supplier_id', sql: `UPDATE "SupplierAllotmentObservation" SET "supplier_id" = "supplier_id" WHERE false`, expect: 'denied' },
  { name: 'UPDATE SupplierCancellationObservation.supplier_rate_plan_code', sql: `UPDATE "SupplierCancellationObservation" SET "supplier_rate_plan_code" = "supplier_rate_plan_code" WHERE false`, expect: 'denied' },
  { name: 'SELECT ConnectorDefinition.transport_metadata', sql: `SELECT "transport_metadata" FROM "ConnectorDefinition" WHERE false`, expect: 'denied' },
  { name: 'UPDATE ConnectorDefinition', sql: `UPDATE public."ConnectorDefinition" SET "status" = "status" WHERE false`, expect: 'denied' },
  { name: 'INSERT ConnectorDefinition', sql: `INSERT INTO public."ConnectorDefinition" ("id") SELECT 'x' WHERE false`, expect: 'denied' },
  ...['DailyRate', 'DailyAvailability', 'CancellationPolicy', 'RatePlan', 'Contract', 'Supplier', 'SupplierHotelMapping', 'SupplierRoomMapping', 'Booking', 'LedgerEntry', 'Wallet'].flatMap((t) => [denyInsert(t), denySelect(t)]),
  { name: 'UPDATE DailyRate', sql: `UPDATE "DailyRate" SET "id" = "id" WHERE false`, expect: 'denied' },
  { name: 'UPDATE DailyAvailability', sql: `UPDATE "DailyAvailability" SET "allotment" = "allotment" WHERE false`, expect: 'denied' },
  { name: 'SELECT ConnectorCredentialReference', sql: `SELECT "id" FROM "ConnectorCredentialReference" WHERE false`, expect: 'denied' },
  { name: 'SELECT AuditEvent', sql: `SELECT "id" FROM "AuditEvent" WHERE false`, expect: 'denied' },
  { name: 'SELECT users', sql: `SELECT "id" FROM "users" WHERE false`, expect: 'denied' },
]

/** A probe is ok when an `allowed` statement runs, or a `denied` statement fails with insufficient_privilege (any other failure is not a pass). */
export async function runIngestProbes(db: Executor): Promise<IngestProbeResult[]> {
  const results: IngestProbeResult[] = []
  for (const probe of INGEST_PROBES) {
    let outcome: 'allowed' | 'denied' | 'error' = 'allowed'
    try { await (probe.sql.startsWith('SELECT') ? db.$queryRawUnsafe(probe.sql) : db.$executeRawUnsafe(probe.sql)) } catch (error) {
      outcome = isDatabasePermissionDenied(error) ? 'denied' : 'error'
    }
    results.push({ name: probe.name, expect: probe.expect, ok: outcome === probe.expect })
  }
  return results
}

export interface IngestCertification { ok: boolean; role: IngestRoleReport; probes: IngestProbeResult[] }

/** Run while connected AS the ingestion login. Read-only. */
export async function certifyIngestRole(db: Executor): Promise<IngestCertification> {
  const role = await verifyIngestRole(db)
  const probes = await runIngestProbes(db)
  return { ok: role.ok && probes.every((p) => p.ok), role, probes }
}
