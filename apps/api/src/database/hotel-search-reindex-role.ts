import { upsertLoginRoleSql } from './hold-expiry-role'
import { isDatabasePermissionDenied } from './db-errors'

/**
 * The narrow database role that keeps HotelSearchIndex current (ADR 0096, amends ADR 0095).
 *
 * The strict API role only reads the index. The reindex job needs to write it, and the only other credential it could use is the schema owner. This login
 * (`fbeds_search_reindex_ops`, member of the NOLOGIN group `fbeds_search_reindex`) may read the hotel identity columns, list tenant ids, and insert or update the derived
 * index. It can NEVER delete from the index, write a hotel, read rates, bookings, guests, ledgers, credentials or the audit log, or change a tenant. Row-level security still
 * applies: every use sets the tenant in its transaction. The index is derived data rebuilt from `Hotel`, so no audit event is written (CLAUDE.md invariant 8 covers privileged
 * and financial mutations). Only the reindex CLI connects with it (`HOTEL_SEARCH_REINDEX_DATABASE_URL`, which must differ from `DATABASE_URL`).
 */
export const SEARCH_REINDEX_GROUP_ROLE = 'fbeds_search_reindex'
export const SEARCH_REINDEX_LOGIN_ROLE = 'fbeds_search_reindex_ops'

type Executor = { $executeRawUnsafe(query: string): Promise<number>; $queryRawUnsafe<T = unknown>(query: string): Promise<T> }

const IDENTIFIER = /^[a-z][a-z0-9_]{2,62}$/
const PASSWORD = /^[A-Za-z0-9_-]{32,128}$/

/** SELECT and INSERT (the upsert needs both). The columns it may change on conflict are SEARCH_REINDEX_UPDATE_COLUMNS. */
export const SEARCH_REINDEX_TABLE = 'HotelSearchIndex'
/** Exactly the columns `upsertHotelSearchIndex` sets in its ON CONFLICT clause. `tenant_id`, `hotel_id` and `id` are immutable for the role. */
export const SEARCH_REINDEX_UPDATE_COLUMNS = ['normalized_name', 'normalized_address', 'normalized_city', 'normalized_country_code', 'latitude', 'longitude', 'embedding', 'embedding_model', 'updated_at'] as const
/** Column-level SELECT. `tenant_id` must be readable for the row-level policy. Nothing commercial, contractual or contact-related. */
export const SEARCH_REINDEX_READ_COLUMNS = {
  Hotel: ['id', 'tenant_id', 'name', 'address', 'city', 'country_code', 'latitude', 'longitude', 'updated_at'],
  tenants: ['id'],
} as const
/** Must stay unreadable and unwritable. Checked by the verifier. */
export const SEARCH_REINDEX_FORBIDDEN_TABLES = ['users', 'sessions', 'memberships', 'Booking', 'BookingGuest', 'LedgerEntry', 'Wallet', 'RatePlan', 'ConnectorCredentialReference', 'AuditEvent'] as const

export function assertSearchReindexInput(loginRole: string, password: string): void {
  if (!IDENTIFIER.test(loginRole)) throw new Error('Login role must match [a-z][a-z0-9_]{2,62}')
  if (loginRole === SEARCH_REINDEX_GROUP_ROLE || loginRole === 'postgres') throw new Error('Login role must be dedicated to the search reindex')
  if (!PASSWORD.test(password)) throw new Error('Password must be 32-128 URL-safe characters [A-Za-z0-9_-]')
}

const cols = (columns: readonly string[]) => columns.map((c) => `"${c}"`).join(', ')

/** The one place the role's privileges are stated. */
export function searchReindexGrantStatements(group = SEARCH_REINDEX_GROUP_ROLE): string[] {
  return [
    `GRANT USAGE ON SCHEMA public TO "${group}"`,
    `GRANT SELECT, INSERT ON "${SEARCH_REINDEX_TABLE}" TO "${group}"`,
    `GRANT UPDATE (${cols(SEARCH_REINDEX_UPDATE_COLUMNS)}) ON "${SEARCH_REINDEX_TABLE}" TO "${group}"`,
    ...Object.entries(SEARCH_REINDEX_READ_COLUMNS).map(([table, columns]) => `GRANT SELECT (${cols(columns)}) ON "${table}" TO "${group}"`),
  ]
}

/** Idempotent, owner-run. Never creates SUPERUSER, BYPASSRLS, CREATEROLE, CREATEDB or REPLICATION. Revokes everything first so a stale grant cannot survive. Never log the password. */
export async function provisionSearchReindexRole(db: Executor, input: { loginRole?: string; password: string }): Promise<void> {
  const loginRole = input.loginRole ?? SEARCH_REINDEX_LOGIN_ROLE
  assertSearchReindexInput(loginRole, input.password)
  const attributes = 'NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'
  await db.$executeRawUnsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${SEARCH_REINDEX_GROUP_ROLE}') THEN CREATE ROLE "${SEARCH_REINDEX_GROUP_ROLE}" NOLOGIN ${attributes}; END IF; END $$`)
  await db.$executeRawUnsafe(upsertLoginRoleSql(loginRole, input.password, attributes, 2))
  await db.$executeRawUnsafe(`GRANT "${SEARCH_REINDEX_GROUP_ROLE}" TO "${loginRole}"`)
  await db.$executeRawUnsafe(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM "${SEARCH_REINDEX_GROUP_ROLE}"`)
  await db.$executeRawUnsafe(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM "${SEARCH_REINDEX_GROUP_ROLE}"`)
  // Column ACLs survive a table-level REVOKE, so clear them on every column-granted table explicitly (ADR 0037).
  for (const [table, columns] of [[SEARCH_REINDEX_TABLE, SEARCH_REINDEX_UPDATE_COLUMNS] as const, ...Object.entries(SEARCH_REINDEX_READ_COLUMNS)]) await db.$executeRawUnsafe(`REVOKE ALL (${cols(columns)}) ON "${table}" FROM "${SEARCH_REINDEX_GROUP_ROLE}"`)
  for (const statement of searchReindexGrantStatements()) await db.$executeRawUnsafe(statement)
}

export async function deprovisionSearchReindexRole(db: Executor, loginRole = SEARCH_REINDEX_LOGIN_ROLE, options: { dropGroup?: boolean } = {}): Promise<void> {
  if (!IDENTIFIER.test(loginRole) || loginRole === SEARCH_REINDEX_GROUP_ROLE || loginRole === 'postgres') throw new Error('Invalid login role')
  const drop = (role: string) => `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
    IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN EXECUTE 'GRANT "${role}" TO CURRENT_USER WITH INHERIT TRUE, SET TRUE'; END IF;
    DROP OWNED BY "${role}"; DROP ROLE "${role}"; END IF; END $$`
  await db.$executeRawUnsafe(drop(loginRole))
  if (options.dropGroup) await db.$executeRawUnsafe(drop(SEARCH_REINDEX_GROUP_ROLE))
}

export interface SearchReindexRoleReport { ok: boolean; failures: string[] }

/** Run while connected AS the login role. Read-only catalogue checks; returns no secret. */
export async function verifySearchReindexRole(db: Pick<Executor, '$queryRawUnsafe'>): Promise<SearchReindexRoleReport> {
  const failures: string[] = []
  const [attrs] = await db.$queryRawUnsafe<Array<{ rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolreplication: boolean; member: boolean; owned: bigint }>>(
    `SELECT r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolreplication,
            pg_has_role(current_user, '${SEARCH_REINDEX_GROUP_ROLE}', 'MEMBER') AS member,
            (SELECT count(*) FROM pg_tables WHERE tableowner = current_user) AS owned
       FROM pg_roles r WHERE r.rolname = current_user`)
  if (!attrs) return { ok: false, failures: ['role not found'] }
  if (attrs.rolsuper) failures.push('role is SUPERUSER')
  if (attrs.rolbypassrls) failures.push('role has BYPASSRLS')
  if (attrs.rolcreaterole) failures.push('role has CREATEROLE')
  if (attrs.rolcreatedb) failures.push('role has CREATEDB')
  if (attrs.rolreplication) failures.push('role has REPLICATION')
  if (!attrs.member) failures.push(`role is not a member of ${SEARCH_REINDEX_GROUP_ROLE}`)
  if (Number(attrs.owned) > 0) failures.push('role owns tables')

  const list = (items: readonly string[]) => items.map((t) => `'${t}'`).join(',')
  const count = async (sql: string) => Number((await db.$queryRawUnsafe<Array<{ n: bigint }>>(sql))[0]?.n ?? 0)
  if (await count(`SELECT CASE WHEN has_table_privilege(current_user, '"${SEARCH_REINDEX_TABLE}"', 'SELECT,INSERT') THEN 1 ELSE 0 END AS n`) === 0) failures.push('role cannot read and insert into the search index')
  // No table-wide UPDATE, DELETE, TRUNCATE, REFERENCES or TRIGGER anywhere; INSERT only on the index.
  if (await count(`SELECT count(*) AS n FROM pg_tables t WHERE t.schemaname = 'public'
      AND has_table_privilege(current_user, format('%I.%I', t.schemaname, t.tablename), 'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')`) > 0) failures.push('role holds a table-wide UPDATE, DELETE, TRUNCATE, REFERENCES or TRIGGER privilege')
  if (await count(`SELECT count(*) AS n FROM pg_tables t WHERE t.schemaname = 'public' AND t.tablename <> '${SEARCH_REINDEX_TABLE}'
      AND has_table_privilege(current_user, format('%I.%I', t.schemaname, t.tablename), 'INSERT')`) > 0) failures.push('role can insert outside the search index')
  {
    const extra = await count(`SELECT count(*) AS n FROM pg_attribute a WHERE a.attrelid = '"${SEARCH_REINDEX_TABLE}"'::regclass AND a.attnum > 0 AND NOT a.attisdropped AND has_column_privilege(current_user, '"${SEARCH_REINDEX_TABLE}"', a.attname, 'UPDATE') AND a.attname <> ALL(ARRAY[${list(SEARCH_REINDEX_UPDATE_COLUMNS)}])`)
    const missing = await count(`SELECT count(*) AS n FROM unnest(ARRAY[${list(SEARCH_REINDEX_UPDATE_COLUMNS)}]) c WHERE NOT has_column_privilege(current_user, '"${SEARCH_REINDEX_TABLE}"', c, 'UPDATE')`)
    if (extra > 0) failures.push('role can update a search index column outside the upsert set')
    if (missing > 0) failures.push('role cannot update every search index column the upsert sets')
  }
  for (const [table, columns] of Object.entries(SEARCH_REINDEX_READ_COLUMNS)) {
    const extra = await count(`SELECT count(*) AS n FROM pg_attribute a WHERE a.attrelid = '"${table}"'::regclass AND a.attnum > 0 AND NOT a.attisdropped AND has_column_privilege(current_user, '"${table}"', a.attname, 'SELECT') AND a.attname <> ALL(ARRAY[${list(columns)}])`)
    const whole = await count(`SELECT CASE WHEN has_table_privilege(current_user, '"${table}"', 'SELECT') THEN 1 ELSE 0 END AS n`)
    const missing = await count(`SELECT count(*) AS n FROM unnest(ARRAY[${list(columns)}]) c WHERE NOT has_column_privilege(current_user, '"${table}"', c, 'SELECT')`)
    if (extra > 0 || whole > 0) failures.push(`role can read ${table} columns beyond the reindex set`)
    if (missing > 0) failures.push(`role cannot read every ${table} column the reindex needs`)
  }
  if (await count(`SELECT count(*) AS n FROM unnest(ARRAY[${list(SEARCH_REINDEX_FORBIDDEN_TABLES)}]) t WHERE has_table_privilege(current_user, format('%I', t), 'SELECT')`) > 0) failures.push('role can read a table outside the reindex scope')
  return { ok: failures.length === 0, failures }
}

export interface SearchReindexProbe { name: string; sql: string; expect: 'allowed' | 'denied' }
export interface SearchReindexProbeResult { name: string; expect: 'allowed' | 'denied'; ok: boolean }

/** Privilege probes. Every statement is `WHERE false`, so PostgreSQL decides on privilege at plan time and no row is read or written. */
export const SEARCH_REINDEX_PROBES: readonly SearchReindexProbe[] = [
  { name: 'SELECT Hotel identity columns', sql: `SELECT "id", "name", "address", "city", "country_code", "latitude", "longitude", "updated_at" FROM "Hotel" WHERE false`, expect: 'allowed' },
  { name: 'SELECT tenants.id', sql: `SELECT "id" FROM "tenants" WHERE false`, expect: 'allowed' },
  { name: 'SELECT HotelSearchIndex', sql: `SELECT "id", "hotel_id", "embedding_model", "updated_at" FROM "HotelSearchIndex" WHERE false`, expect: 'allowed' },
  { name: 'INSERT HotelSearchIndex', sql: `INSERT INTO "HotelSearchIndex" ("id") SELECT 'x' WHERE false`, expect: 'allowed' },
  { name: 'UPDATE HotelSearchIndex.embedding', sql: `UPDATE "HotelSearchIndex" SET "embedding" = "embedding" WHERE false`, expect: 'allowed' },
  { name: 'UPDATE HotelSearchIndex.embedding_model', sql: `UPDATE "HotelSearchIndex" SET "embedding_model" = "embedding_model" WHERE false`, expect: 'allowed' },
  { name: 'DELETE HotelSearchIndex', sql: `DELETE FROM "HotelSearchIndex" WHERE false`, expect: 'denied' },
  { name: 'UPDATE HotelSearchIndex.tenant_id', sql: `UPDATE "HotelSearchIndex" SET "tenant_id" = "tenant_id" WHERE false`, expect: 'denied' },
  { name: 'UPDATE HotelSearchIndex.hotel_id', sql: `UPDATE "HotelSearchIndex" SET "hotel_id" = "hotel_id" WHERE false`, expect: 'denied' },
  { name: 'SELECT Hotel.content_status', sql: `SELECT "content_status" FROM "Hotel" WHERE false`, expect: 'denied' },
  { name: 'INSERT Hotel', sql: `INSERT INTO "Hotel" ("id") SELECT 'x' WHERE false`, expect: 'denied' },
  { name: 'UPDATE Hotel', sql: `UPDATE "Hotel" SET "name" = "name" WHERE false`, expect: 'denied' },
  { name: 'DELETE Hotel', sql: `DELETE FROM "Hotel" WHERE false`, expect: 'denied' },
  { name: 'SELECT tenants.slug', sql: `SELECT "slug" FROM "tenants" WHERE false`, expect: 'denied' },
  { name: 'UPDATE tenants', sql: `UPDATE "tenants" SET "id" = "id" WHERE false`, expect: 'denied' },
  { name: 'SELECT RatePlan', sql: `SELECT "id" FROM "RatePlan" WHERE false`, expect: 'denied' },
  { name: 'SELECT Booking', sql: `SELECT "id" FROM "Booking" WHERE false`, expect: 'denied' },
  { name: 'SELECT BookingGuest', sql: `SELECT "id" FROM "BookingGuest" WHERE false`, expect: 'denied' },
  { name: 'SELECT LedgerEntry', sql: `SELECT "id" FROM "LedgerEntry" WHERE false`, expect: 'denied' },
  { name: 'INSERT AuditEvent', sql: `INSERT INTO "AuditEvent" ("id") SELECT 'x' WHERE false`, expect: 'denied' },
  { name: 'SELECT AuditEvent', sql: `SELECT "id" FROM "AuditEvent" WHERE false`, expect: 'denied' },
  { name: 'SELECT users', sql: `SELECT "id" FROM "users" WHERE false`, expect: 'denied' },
]

/** A probe is ok when an `allowed` statement runs, or a `denied` statement fails with insufficient_privilege (any other failure is not a pass). */
export async function runSearchReindexProbes(db: Executor): Promise<SearchReindexProbeResult[]> {
  const results: SearchReindexProbeResult[] = []
  for (const probe of SEARCH_REINDEX_PROBES) {
    let outcome: 'allowed' | 'denied' | 'error' = 'allowed'
    try { await (probe.sql.startsWith('SELECT') ? db.$queryRawUnsafe(probe.sql) : db.$executeRawUnsafe(probe.sql)) } catch (error) {
      outcome = isDatabasePermissionDenied(error) ? 'denied' : 'error'
    }
    results.push({ name: probe.name, expect: probe.expect, ok: outcome === probe.expect })
  }
  return results
}

export interface SearchReindexCertification { ok: boolean; role: SearchReindexRoleReport; probes: SearchReindexProbeResult[] }

/** Run while connected AS the reindex login. Read-only. */
export async function certifySearchReindexRole(db: Executor): Promise<SearchReindexCertification> {
  const role = await verifySearchReindexRole(db)
  const probes = await runSearchReindexProbes(db)
  return { ok: role.ok && probes.every((p) => p.ok), role, probes }
}
