import { upsertLoginRoleSql } from './hold-expiry-role'
import { isDatabasePermissionDenied } from './db-errors'

/**
 * The narrow database role of an agent booking (ADR 0113).
 *
 * The strict API runtime role never writes a booking, a hold, a ledger entry or a wallet. The Admin booking role never writes the ledger.
 * This login (`fbeds_booking_exec_ops`, member of the NOLOGIN group `fbeds_booking_exec`) is the one principal that may complete the agent
 * transaction: hold, prebook, confirm, cancel, documents and the ledger entries those steps post. Grants are the columns and tables that
 * transaction touches. It cannot change a price, a credit limit, a cached balance, allotment, pool capacity, a ledger row, a credential,
 * or an identity table, and it holds no DELETE. Row-level security still applies. Only `BookingExecutionDatabase` connects with it
 * (`BOOKING_EXECUTION_DATABASE_URL`, which must differ from `DATABASE_URL`).
 */
export const BOOKING_EXECUTION_GROUP_ROLE = 'fbeds_booking_exec'
export const BOOKING_EXECUTION_LOGIN_ROLE = 'fbeds_booking_exec_ops'

type Executor = { $executeRawUnsafe(query: string): Promise<number>; $queryRawUnsafe<T = unknown>(query: string): Promise<T> }

const IDENTIFIER = /^[a-z][a-z0-9_]{2,62}$/
const PASSWORD = /^[A-Za-z0-9_-]{32,128}$/

/** Whole-table SELECT. Catalogue tables the transaction joins, and the booking and finance rows it owns. */
export const BOOKING_EXECUTION_READ_TABLES = [
  'Booking', 'BookingRoom', 'BookingGuest', 'BookingEvent', 'BookingDocument', 'BookingEmail', 'SupplierMutation', 'Cancellation',
  'InventoryHold', 'InventoryHoldNight', 'LedgerEntry', 'Wallet', 'DailyAvailability', 'InventoryPool', 'InventoryPoolDay',
  'RatePlan', 'Contract', 'CancellationPolicy', 'RoomType', 'BoardBasis', 'Hotel', 'FxRate', 'Agency', 'AgencyMember', 'AgencyCreditLimit',
  'AuditEvent', 'Supplier',
] as const

/** Append-only or created inside the transaction. No catalogue table is in this list. */
export const BOOKING_EXECUTION_INSERT_TABLES = [
  'Booking', 'BookingRoom', 'BookingGuest', 'BookingEvent', 'BookingDocument', 'BookingEmail', 'SupplierMutation', 'Cancellation',
  'InventoryHold', 'InventoryHoldNight', 'LedgerEntry', 'Wallet', 'AuditEvent',
] as const

/** The only columns the role may change. Identity, price, credit and stock-authoring columns are absent on purpose. */
export const BOOKING_EXECUTION_UPDATE_COLUMNS = {
  Booking: ['status', 'supplier', 'search_snapshot', 'supplier_status', 'supplier_ref', 'hotel_confirmation_no', 'version', 'closed_at', 'updated_at'],
  InventoryHold: ['status', 'released_at', 'updated_at'],
  DailyAvailability: ['held', 'sold', 'updated_at'],
  InventoryPoolDay: ['held', 'sold', 'updated_at'],
  /** `SELECT … FOR UPDATE` needs an UPDATE privilege. The balance and the limit are not writable. */
  Wallet: ['updated_at'],
  SupplierMutation: ['status', 'attempted_at', 'request_id', 'supplier_reference', 'supplier_status', 'acknowledged_at', 'failure_category', 'failure_code', 'resolved_at', 'updated_at'],
  Cancellation: ['refund_minor'],
} as const

/** Column SELECT where a whole-table read would expose a secret or a payload the transaction does not use. `tenant_id` stays readable for the row policy. */
export const BOOKING_EXECUTION_COLUMN_READS = {
  tenants: ['id', 'name'],
  HotelProfile: ['id', 'tenant_id', 'hotel_id', 'check_in_time', 'check_out_time', 'local_charges'],
  BookingFinanceEvent: ['id', 'tenant_id', 'booking_id', 'type', 'penalty_minor', 'created_at'],
} as const

/** Must stay unreadable. Checked by the verifier. */
export const BOOKING_EXECUTION_FORBIDDEN_TABLES = [
  'users', 'sessions', 'memberships', 'password_reset_tokens', 'ConnectorCredentialReference', 'FundingReceipt',
  'BookingFinancePosting', 'SupplierPayableEntry', 'GlAccount', 'LedgerChainLink', 'DailyRate', 'HotelSearchIndex',
] as const

export function assertBookingExecutionInput(loginRole: string, password: string): void {
  if (!IDENTIFIER.test(loginRole)) throw new Error('Login role must match [a-z][a-z0-9_]{2,62}')
  if (loginRole === BOOKING_EXECUTION_GROUP_ROLE || loginRole === 'postgres' || loginRole === 'fbeds_api' || loginRole === 'fbeds_booking') throw new Error('Login role must be dedicated to booking execution')
  if (!PASSWORD.test(password)) throw new Error('Password must be 32-128 URL-safe characters [A-Za-z0-9_-]')
}

const cols = (columns: readonly string[]) => columns.map((c) => `"${c}"`).join(', ')

/** The one place the role's privileges are stated. No DELETE, no GRANT ALL. */
export function bookingExecutionGrantStatements(group = BOOKING_EXECUTION_GROUP_ROLE): string[] {
  return [
    `GRANT USAGE ON SCHEMA public TO "${group}"`,
    ...BOOKING_EXECUTION_READ_TABLES.map((table) => `GRANT SELECT ON "${table}" TO "${group}"`),
    ...Object.entries(BOOKING_EXECUTION_COLUMN_READS).map(([table, columns]) => `GRANT SELECT (${cols(columns)}) ON "${table}" TO "${group}"`),
    ...BOOKING_EXECUTION_INSERT_TABLES.map((table) => `GRANT INSERT ON "${table}" TO "${group}"`),
    ...Object.entries(BOOKING_EXECUTION_UPDATE_COLUMNS).map(([table, columns]) => `GRANT UPDATE (${cols(columns)}) ON "${table}" TO "${group}"`),
  ]
}

/** Idempotent, owner-run. Revokes everything first so a stale or broader grant cannot survive. Never log the password. */
export async function provisionBookingExecutionRole(db: Executor, input: { loginRole?: string; password: string }): Promise<void> {
  const loginRole = input.loginRole ?? BOOKING_EXECUTION_LOGIN_ROLE
  assertBookingExecutionInput(loginRole, input.password)
  const attributes = 'NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'
  // eslint-disable-next-line no-restricted-syntax -- raw-sql: role DDL; the group name is a constant identifier
  await db.$executeRawUnsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${BOOKING_EXECUTION_GROUP_ROLE}') THEN CREATE ROLE "${BOOKING_EXECUTION_GROUP_ROLE}" NOLOGIN ${attributes}; END IF; END $$`)
  // eslint-disable-next-line no-restricted-syntax -- raw-sql: CREATE/ALTER ROLE password cannot be a bind parameter
  await db.$executeRawUnsafe(upsertLoginRoleSql(loginRole, input.password, attributes, 10))
  // eslint-disable-next-line no-restricted-syntax -- raw-sql: GRANT role membership; both names are validated identifiers
  await db.$executeRawUnsafe(`GRANT "${BOOKING_EXECUTION_GROUP_ROLE}" TO "${loginRole}"`)
  // eslint-disable-next-line no-restricted-syntax -- raw-sql: REVOKE before grant so a stale privilege cannot survive
  await db.$executeRawUnsafe(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM "${BOOKING_EXECUTION_GROUP_ROLE}"`)
  // eslint-disable-next-line no-restricted-syntax -- raw-sql: function privileges are not covered by the table revoke
  await db.$executeRawUnsafe(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM "${BOOKING_EXECUTION_GROUP_ROLE}"`)
  // eslint-disable-next-line no-restricted-syntax -- raw-sql: column ACLs survive a table revoke; the group name is a constant
  await db.$executeRawUnsafe(`DO $$ DECLARE r record; BEGIN FOR r IN SELECT c.relname, a.attname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_attribute a ON a.attrelid = c.oid WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped LOOP EXECUTE format('REVOKE ALL (%I) ON %I FROM %I', r.attname, r.relname, '${BOOKING_EXECUTION_GROUP_ROLE}'); END LOOP; END $$`)
  for (const statement of bookingExecutionGrantStatements()) {
    // eslint-disable-next-line no-restricted-syntax -- raw-sql: GRANT statements are built only from the constant table and column lists
    await db.$executeRawUnsafe(statement)
  }
}

export async function deprovisionBookingExecutionRole(db: Executor, loginRole = BOOKING_EXECUTION_LOGIN_ROLE, options: { dropGroup?: boolean } = {}): Promise<void> {
  if (!IDENTIFIER.test(loginRole) || loginRole === BOOKING_EXECUTION_GROUP_ROLE || loginRole === 'postgres') throw new Error('Invalid login role')
  const drop = (role: string) => `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
    IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN EXECUTE 'GRANT "${role}" TO CURRENT_USER WITH INHERIT TRUE, SET TRUE'; END IF;
    DROP OWNED BY "${role}"; DROP ROLE "${role}"; END IF; END $$`
  // eslint-disable-next-line no-restricted-syntax -- raw-sql: DROP ROLE; the login name was validated as an identifier
  await db.$executeRawUnsafe(drop(loginRole))
  if (options.dropGroup) {
    // eslint-disable-next-line no-restricted-syntax -- raw-sql: DROP ROLE of the constant NOLOGIN group
    await db.$executeRawUnsafe(drop(BOOKING_EXECUTION_GROUP_ROLE))
  }
}

export interface BookingExecutionRoleReport { ok: boolean; failures: string[] }

/** Run while connected AS the login role. Read-only catalogue checks; returns no secret. */
export async function verifyBookingExecutionRole(db: Pick<Executor, '$queryRawUnsafe'>): Promise<BookingExecutionRoleReport> {
  const failures: string[] = []
  // eslint-disable-next-line no-restricted-syntax -- raw-sql: catalogue read of the current login; the group name is a constant
  const [attrs] = await db.$queryRawUnsafe<Array<{ rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolreplication: boolean; member: boolean; owned: bigint }>>(
    `SELECT r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolreplication,
            pg_has_role(current_user, '${BOOKING_EXECUTION_GROUP_ROLE}', 'MEMBER') AS member,
            (SELECT count(*) FROM pg_tables WHERE tableowner = current_user) AS owned
       FROM pg_roles r WHERE r.rolname = current_user`)
  if (!attrs) return { ok: false, failures: ['role not found'] }
  if (attrs.rolsuper) failures.push('role is SUPERUSER')
  if (attrs.rolbypassrls) failures.push('role has BYPASSRLS')
  if (attrs.rolcreaterole) failures.push('role has CREATEROLE')
  if (attrs.rolcreatedb) failures.push('role has CREATEDB')
  if (attrs.rolreplication) failures.push('role has REPLICATION')
  if (!attrs.member) failures.push(`role is not a member of ${BOOKING_EXECUTION_GROUP_ROLE}`)
  if (Number(attrs.owned) > 0) failures.push('role owns tables')

  const list = (items: readonly string[]) => items.map((t) => `'${t}'`).join(',')
  const count = async (sql: string) => {
    // eslint-disable-next-line no-restricted-syntax -- raw-sql: privilege catalogue queries; table and column names come from the constant lists
    return Number((await db.$queryRawUnsafe<Array<{ n: bigint }>>(sql))[0]?.n ?? 0)
  }
  if (await count(`SELECT count(*) AS n FROM unnest(ARRAY[${list(BOOKING_EXECUTION_READ_TABLES)}]) t WHERE NOT has_table_privilege(current_user, format('%I', t), 'SELECT')`) > 0) failures.push('role cannot read every booking execution table')
  if (await count(`SELECT count(*) AS n FROM unnest(ARRAY[${list(BOOKING_EXECUTION_INSERT_TABLES)}]) t WHERE NOT has_table_privilege(current_user, format('%I', t), 'INSERT')`) > 0) failures.push('role cannot insert every booking execution table')
  if (await count(`SELECT count(*) AS n FROM pg_tables t WHERE t.schemaname = 'public' AND t.tablename <> ALL(ARRAY[${list(BOOKING_EXECUTION_INSERT_TABLES)}]) AND has_table_privilege(current_user, format('%I.%I', t.schemaname, t.tablename), 'INSERT')`) > 0) failures.push('role can insert outside the booking execution tables')
  if (await count(`SELECT count(*) AS n FROM pg_tables t WHERE t.schemaname = 'public' AND has_table_privilege(current_user, format('%I.%I', t.schemaname, t.tablename), 'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')`) > 0) failures.push('role holds a table-wide UPDATE, DELETE, TRUNCATE, REFERENCES or TRIGGER privilege')
  for (const [table, columns] of Object.entries(BOOKING_EXECUTION_UPDATE_COLUMNS)) {
    const extra = await count(`SELECT count(*) AS n FROM pg_attribute a WHERE a.attrelid = '"${table}"'::regclass AND a.attnum > 0 AND NOT a.attisdropped AND has_column_privilege(current_user, '"${table}"', a.attname, 'UPDATE') AND a.attname <> ALL(ARRAY[${list(columns)}])`)
    const missing = await count(`SELECT count(*) AS n FROM unnest(ARRAY[${list(columns)}]) c WHERE NOT has_column_privilege(current_user, '"${table}"', c, 'UPDATE')`)
    if (extra > 0) failures.push(`role can update a ${table} column outside its allowed set`)
    if (missing > 0) failures.push(`role cannot update every ${table} column it needs`)
  }
  for (const [table, columns] of Object.entries(BOOKING_EXECUTION_COLUMN_READS)) {
    const quoted = table === 'tenants' ? 'tenants' : `"${table}"`
    const extra = await count(`SELECT count(*) AS n FROM pg_attribute a WHERE a.attrelid = '${quoted}'::regclass AND a.attnum > 0 AND NOT a.attisdropped AND has_column_privilege(current_user, '${quoted}', a.attname, 'SELECT') AND a.attname <> ALL(ARRAY[${list(columns)}])`)
    const whole = await count(`SELECT CASE WHEN has_table_privilege(current_user, '${quoted}', 'SELECT') THEN 1 ELSE 0 END AS n`)
    const missing = await count(`SELECT count(*) AS n FROM unnest(ARRAY[${list(columns)}]) c WHERE NOT has_column_privilege(current_user, '${quoted}', c, 'SELECT')`)
    if (extra > 0 || whole > 0) failures.push(`role can read ${table} beyond the columns the transaction uses`)
    if (missing > 0) failures.push(`role cannot read every ${table} column it needs`)
  }
  if (await count(`SELECT count(*) AS n FROM unnest(ARRAY[${list(BOOKING_EXECUTION_FORBIDDEN_TABLES)}]) t WHERE has_table_privilege(current_user, format('%I', t), 'SELECT') OR has_table_privilege(current_user, format('%I', t), 'INSERT')`) > 0) failures.push('role can read or write a table outside the booking execution scope')
  return { ok: failures.length === 0, failures }
}

export interface BookingExecutionProbe { name: string; sql: string; expect: 'allowed' | 'denied' }
export interface BookingExecutionProbeResult { name: string; expect: 'allowed' | 'denied'; ok: boolean }

/** Privilege probes. Every statement is `WHERE false`, so PostgreSQL decides on privilege at plan time and no row is read or written. */
export const BOOKING_EXECUTION_PROBES: readonly BookingExecutionProbe[] = [
  { name: 'INSERT Booking', sql: `INSERT INTO "Booking" ("id") SELECT 'x' WHERE false`, expect: 'allowed' },
  { name: 'SELECT Booking', sql: `SELECT "id", "status", "total_minor" FROM "Booking" WHERE false`, expect: 'allowed' },
  { name: 'UPDATE Booking.status', sql: `UPDATE "Booking" SET "status" = "status" WHERE false`, expect: 'allowed' },
  { name: 'UPDATE Booking.supplier', sql: `UPDATE "Booking" SET "supplier" = "supplier" WHERE false`, expect: 'allowed' },
  { name: 'UPDATE Booking.search_snapshot', sql: `UPDATE "Booking" SET "search_snapshot" = "search_snapshot" WHERE false`, expect: 'allowed' },
  { name: 'LOCK Booking', sql: `SELECT "id" FROM "Booking" WHERE false FOR UPDATE`, expect: 'allowed' },
  { name: 'UPDATE Booking.total_minor', sql: `UPDATE "Booking" SET "total_minor" = "total_minor" WHERE false`, expect: 'denied' },
  { name: 'UPDATE Booking.tenant_id', sql: `UPDATE "Booking" SET "tenant_id" = "tenant_id" WHERE false`, expect: 'denied' },
  { name: 'DELETE Booking', sql: `DELETE FROM "Booking" WHERE false`, expect: 'denied' },
  { name: 'INSERT LedgerEntry', sql: `INSERT INTO "LedgerEntry" ("id") SELECT 'x' WHERE false`, expect: 'allowed' },
  { name: 'SELECT LedgerEntry', sql: `SELECT "id", "type", "amount_minor" FROM "LedgerEntry" WHERE false`, expect: 'allowed' },
  { name: 'UPDATE LedgerEntry', sql: `UPDATE "LedgerEntry" SET "amount_minor" = "amount_minor" WHERE false`, expect: 'denied' },
  { name: 'DELETE LedgerEntry', sql: `DELETE FROM "LedgerEntry" WHERE false`, expect: 'denied' },
  { name: 'INSERT Wallet', sql: `INSERT INTO "Wallet" ("id") SELECT 'x' WHERE false`, expect: 'allowed' },
  { name: 'SELECT Wallet', sql: `SELECT "id", "agency_id", "currency", "credit_limit" FROM "Wallet" WHERE false`, expect: 'allowed' },
  { name: 'LOCK Wallet', sql: `SELECT "id" FROM "Wallet" WHERE false FOR UPDATE`, expect: 'allowed' },
  { name: 'UPDATE Wallet.updated_at', sql: `UPDATE "Wallet" SET "updated_at" = "updated_at" WHERE false`, expect: 'allowed' },
  { name: 'UPDATE Wallet.credit_limit', sql: `UPDATE "Wallet" SET "credit_limit" = "credit_limit" WHERE false`, expect: 'denied' },
  { name: 'UPDATE Wallet.cached_balance', sql: `UPDATE "Wallet" SET "cached_balance" = "cached_balance" WHERE false`, expect: 'denied' },
  { name: 'INSERT InventoryHold', sql: `INSERT INTO "InventoryHold" ("id") SELECT 'x' WHERE false`, expect: 'allowed' },
  { name: 'UPDATE InventoryHold.status', sql: `UPDATE "InventoryHold" SET "status" = "status" WHERE false`, expect: 'allowed' },
  { name: 'UPDATE InventoryHold.sell_amount_minor', sql: `UPDATE "InventoryHold" SET "sell_amount_minor" = "sell_amount_minor" WHERE false`, expect: 'denied' },
  { name: 'UPDATE DailyAvailability.held', sql: `UPDATE "DailyAvailability" SET "held" = "held", "sold" = "sold" WHERE false`, expect: 'allowed' },
  { name: 'UPDATE DailyAvailability.allotment', sql: `UPDATE "DailyAvailability" SET "allotment" = "allotment" WHERE false`, expect: 'denied' },
  { name: 'INSERT DailyAvailability', sql: `INSERT INTO "DailyAvailability" ("id") SELECT 'x' WHERE false`, expect: 'denied' },
  { name: 'UPDATE InventoryPoolDay.sold', sql: `UPDATE "InventoryPoolDay" SET "sold" = "sold", "held" = "held" WHERE false`, expect: 'allowed' },
  { name: 'UPDATE InventoryPoolDay.capacity', sql: `UPDATE "InventoryPoolDay" SET "capacity" = "capacity" WHERE false`, expect: 'denied' },
  { name: 'INSERT AuditEvent', sql: `INSERT INTO "AuditEvent" ("id") SELECT 'x' WHERE false`, expect: 'allowed' },
  { name: 'SELECT AuditEvent', sql: `SELECT "id", "action" FROM "AuditEvent" WHERE false`, expect: 'allowed' },
  { name: 'UPDATE AuditEvent', sql: `UPDATE "AuditEvent" SET "action" = "action" WHERE false`, expect: 'denied' },
  { name: 'DELETE AuditEvent', sql: `DELETE FROM "AuditEvent" WHERE false`, expect: 'denied' },
  { name: 'INSERT BookingDocument', sql: `INSERT INTO "BookingDocument" ("id") SELECT 'x' WHERE false`, expect: 'allowed' },
  { name: 'UPDATE BookingDocument', sql: `UPDATE "BookingDocument" SET "number" = "number" WHERE false`, expect: 'denied' },
  { name: 'INSERT Cancellation', sql: `INSERT INTO "Cancellation" ("id") SELECT 'x' WHERE false`, expect: 'allowed' },
  { name: 'UPDATE Cancellation.refund_minor', sql: `UPDATE "Cancellation" SET "refund_minor" = "refund_minor" WHERE false`, expect: 'allowed' },
  { name: 'DELETE Cancellation', sql: `DELETE FROM "Cancellation" WHERE false`, expect: 'denied' },
  { name: 'UPDATE SupplierMutation.status', sql: `UPDATE "SupplierMutation" SET "status" = "status" WHERE false`, expect: 'allowed' },
  { name: 'UPDATE SupplierMutation.request_fingerprint', sql: `UPDATE "SupplierMutation" SET "request_fingerprint" = "request_fingerprint" WHERE false`, expect: 'denied' },
  { name: 'SELECT HotelProfile times and local charges', sql: `SELECT "check_in_time", "check_out_time", "local_charges" FROM "HotelProfile" WHERE false`, expect: 'allowed' },
  { name: 'SELECT HotelProfile.contacts', sql: `SELECT "contacts" FROM "HotelProfile" WHERE false`, expect: 'denied' },
  { name: 'SELECT tenants.name', sql: `SELECT "id", "name" FROM tenants WHERE false`, expect: 'allowed' },
  { name: 'SELECT BookingFinanceEvent.type', sql: `SELECT "id", "type", "penalty_minor" FROM "BookingFinanceEvent" WHERE false`, expect: 'allowed' },
  { name: 'SELECT BookingFinanceEvent.payload', sql: `SELECT "payload" FROM "BookingFinanceEvent" WHERE false`, expect: 'denied' },
  { name: 'INSERT BookingFinanceEvent', sql: `INSERT INTO "BookingFinanceEvent" ("id") SELECT 'x' WHERE false`, expect: 'denied' },
  { name: 'INSERT BookingFinancePosting', sql: `INSERT INTO "BookingFinancePosting" ("id") SELECT 'x' WHERE false`, expect: 'denied' },
  { name: 'SELECT users', sql: `SELECT "id" FROM users WHERE false`, expect: 'denied' },
  { name: 'SELECT sessions', sql: `SELECT "id" FROM sessions WHERE false`, expect: 'denied' },
  { name: 'SELECT ConnectorCredentialReference', sql: `SELECT "id" FROM "ConnectorCredentialReference" WHERE false`, expect: 'denied' },
  { name: 'SELECT FundingReceipt', sql: `SELECT "id" FROM "FundingReceipt" WHERE false`, expect: 'denied' },
  { name: 'INSERT RatePlan', sql: `INSERT INTO "RatePlan" ("id") SELECT 'x' WHERE false`, expect: 'denied' },
  { name: 'UPDATE Hotel', sql: `UPDATE "Hotel" SET "name" = "name" WHERE false`, expect: 'denied' },
  { name: 'INSERT DailyRate', sql: `INSERT INTO "DailyRate" ("id") SELECT 'x' WHERE false`, expect: 'denied' },
  { name: 'SELECT DailyRate', sql: `SELECT "id" FROM "DailyRate" WHERE false`, expect: 'denied' },
]

export async function runBookingExecutionProbes(db: Executor): Promise<BookingExecutionProbeResult[]> {
  const results: BookingExecutionProbeResult[] = []
  for (const probe of BOOKING_EXECUTION_PROBES) {
    let outcome: 'allowed' | 'denied' | 'error' = 'allowed'
    try {
      // eslint-disable-next-line no-restricted-syntax -- raw-sql: fixed WHERE false privilege probes, not caller input
      await (probe.sql.startsWith('SELECT') ? db.$queryRawUnsafe(probe.sql) : db.$executeRawUnsafe(probe.sql))
    } catch (error) {
      outcome = isDatabasePermissionDenied(error) ? 'denied' : 'error'
    }
    results.push({ name: probe.name, expect: probe.expect, ok: outcome === probe.expect })
  }
  return results
}

export interface BookingExecutionCertification { ok: boolean; role: BookingExecutionRoleReport; probes: BookingExecutionProbeResult[] }

/** Run while connected AS the booking execution login. The probes write nothing. */
export async function certifyBookingExecutionRole(db: Executor): Promise<BookingExecutionCertification> {
  const role = await verifyBookingExecutionRole(db)
  const probes = await runBookingExecutionProbes(db)
  return { ok: role.ok && probes.every((p) => p.ok), role, probes }
}
