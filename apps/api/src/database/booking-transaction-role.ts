import { upsertLoginRoleSql } from './hold-expiry-role'
import { isDatabasePermissionDenied } from './db-errors'

/**
 * The narrow database role of the Agent booking transaction (ADR 0113).
 *
 * `fbeds_api` deliberately cannot write bookings, holds, the ledger or wallets (ADR 0032, ADR 0101). `fbeds_booking_ops` writes the Admin
 * booking module and is forbidden the ledger. This login (`fbeds_booktx_ops`, member of the NOLOGIN group `fbeds_booktx`) is the only principal
 * the Agent hold, prebook, confirm, cancel, document and reconciliation services connect with. It may insert the booking it is creating, move
 * only the inventory counters a hold already took (`held` / `sold`), append the booking-shaped ledger keys, and open an agency wallet at a zero
 * credit line. Triggers refuse a house wallet, a non-zero line or balance, and any ledger entry that is not one of those keys. It never receives
 * the owner credential, and `BOOKING_TRANSACTION_DATABASE_URL` must differ from `DATABASE_URL`.
 */
export const BOOKTX_GROUP_ROLE = 'fbeds_booktx'
export const BOOKTX_LOGIN_ROLE = 'fbeds_booktx_ops'

type Executor = { $executeRawUnsafe(query: string): Promise<number>; $queryRawUnsafe<T = unknown>(query: string): Promise<T> }

const IDENTIFIER = /^[a-z][a-z0-9_]{2,62}$/
const PASSWORD = /^[A-Za-z0-9_-]{32,128}$/

/** Full-row reads the transaction needs in order to freeze terms, lock rows and return the booking it just wrote. No identity, funding or credential table. */
export const BOOKTX_READ_TABLES = [
  'Booking', 'BookingRoom', 'BookingGuest', 'BookingEvent', 'BookingEmail', 'BookingDocument', 'Cancellation',
  'InventoryHold', 'InventoryHoldNight', 'LedgerEntry', 'SupplierMutation', 'AuditEvent', 'Wallet',
  'RatePlan', 'Contract', 'CancellationPolicy', 'RoomType', 'Hotel', 'BoardBasis',
  'DailyAvailability', 'InventoryPool', 'InventoryPoolDay',
] as const

/** Insert-only or insert-and-narrow-update. No DELETE anywhere. */
export const BOOKTX_INSERT_TABLES = [
  'Booking', 'BookingRoom', 'BookingGuest', 'BookingEvent', 'BookingEmail', 'BookingDocument', 'Cancellation',
  'InventoryHold', 'InventoryHoldNight', 'LedgerEntry', 'SupplierMutation', 'AuditEvent', 'Wallet',
] as const

/**
 * Column-level UPDATE. Identity, price, credit line and stock authoring columns are absent on purpose.
 * `Wallet.updated_at` exists only so `SELECT … FOR UPDATE` can take the row lock (ADR 0110).
 */
export const BOOKTX_UPDATE_COLUMNS = {
  Booking: ['status', 'supplier', 'supplier_status', 'supplier_ref', 'hotel_confirmation_no', 'search_snapshot', 'version', 'closed_at', 'updated_at'],
  InventoryHold: ['status', 'released_at', 'updated_at'],
  SupplierMutation: ['status', 'attempted_at', 'acknowledged_at', 'resolved_at', 'supplier_reference', 'supplier_status', 'failure_category', 'failure_code', 'request_id', 'updated_at'],
  DailyAvailability: ['held', 'sold', 'updated_at'],
  InventoryPoolDay: ['held', 'sold', 'updated_at'],
  Cancellation: ['refund_minor'],
  Wallet: ['updated_at'],
} as const

/** Column-level SELECT. A table-level SELECT would expose hotel contacts, agency notes or the credit-limit approver. */
export const BOOKTX_READ_COLUMNS = {
  HotelProfile: ['id', 'tenant_id', 'hotel_id', 'check_in_time', 'check_out_time', 'local_charges'],
  tenants: ['id', 'name'],
  Agency: ['id', 'tenant_id', 'name'],
  AgencyMember: ['tenant_id', 'agency_id', 'user_id'],
  // `id` is included because Prisma selects the primary key even when the caller names other columns.
  AgencyCreditLimit: ['id', 'tenant_id', 'agency_id', 'currency', 'limit_minor'],
  FxRate: ['id', 'tenant_id', 'base_currency', 'quote_currency', 'rate_scaled', 'buffer_bp', 'status', 'activated_at'],
  // reserveNight reads the sales mode before it moves held stock. Reason, actor and batch stay hidden.
  RoomSalesRule: ['tenant_id', 'room_type_id', 'stay_date', 'pool_key', 'plan_key', 'channel_key', 'market_key', 'contract_key', 'mode', 'sales_cap', 'consumes_inventory', 'override_expires_at'],
} as const

/** Must stay unreadable and unwritable. Checked by the verifier. */
export const BOOKTX_FORBIDDEN_TABLES = [
  'users', 'sessions', 'memberships', 'password_reset_tokens', 'FundingReceipt', 'ConnectorCredentialReference',
  'BookingFinanceEvent', 'BookingFinancePosting', 'SupplierPayableEntry', 'LedgerAdjustment', 'GlAccount', 'FinancePeriodClose', 'LedgerChainLink',
] as const

/** Trigger functions. EXECUTE is required for the role that fires them; nobody else is granted it by this contract. */
export const BOOKTX_FUNCTIONS = ['"fbeds_is_booking_transaction_role"()', '"fbeds_booktx_wallet_guard"()', '"fbeds_booktx_ledger_guard"()'] as const

export function assertBooktxInput(loginRole: string, password: string): void {
  if (!IDENTIFIER.test(loginRole)) throw new Error('Login role must match [a-z][a-z0-9_]{2,62}')
  if (loginRole === BOOKTX_GROUP_ROLE || loginRole === 'postgres') throw new Error('Login role must be dedicated to the booking transaction')
  if (!PASSWORD.test(password)) throw new Error('Password must be 32-128 URL-safe characters [A-Za-z0-9_-]')
}

const cols = (columns: readonly string[]) => columns.map((c) => `"${c}"`).join(', ')

/** The one place this role's privileges are stated. */
export function booktxGrantStatements(group = BOOKTX_GROUP_ROLE): string[] {
  return [
    `GRANT USAGE ON SCHEMA public TO "${group}"`,
    ...BOOKTX_READ_TABLES.map((table) => `GRANT SELECT ON "${table}" TO "${group}"`),
    ...BOOKTX_INSERT_TABLES.map((table) => `GRANT INSERT ON "${table}" TO "${group}"`),
    ...Object.entries(BOOKTX_UPDATE_COLUMNS).map(([table, columns]) => `GRANT UPDATE (${cols(columns)}) ON "${table}" TO "${group}"`),
    ...Object.entries(BOOKTX_READ_COLUMNS).map(([table, columns]) => `GRANT SELECT (${cols(columns)}) ON "${table}" TO "${group}"`),
    ...BOOKTX_FUNCTIONS.map((fn) => `GRANT EXECUTE ON FUNCTION ${fn} TO "${group}"`),
  ]
}

/** Idempotent, owner-run. Never creates SUPERUSER, BYPASSRLS, CREATEROLE, CREATEDB or REPLICATION. Revokes everything first. Never log the password. */
export async function provisionBooktxRole(db: Executor, input: { loginRole?: string; password: string }): Promise<void> {
  const loginRole = input.loginRole ?? BOOKTX_LOGIN_ROLE
  assertBooktxInput(loginRole, input.password)
  const attributes = 'NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'
  await db.$executeRawUnsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${BOOKTX_GROUP_ROLE}') THEN CREATE ROLE "${BOOKTX_GROUP_ROLE}" NOLOGIN ${attributes}; END IF; END $$`)
  await db.$executeRawUnsafe(upsertLoginRoleSql(loginRole, input.password, attributes, 10))
  await db.$executeRawUnsafe(`GRANT "${BOOKTX_GROUP_ROLE}" TO "${loginRole}"`)
  await db.$executeRawUnsafe(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM "${BOOKTX_GROUP_ROLE}"`)
  await db.$executeRawUnsafe(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM "${BOOKTX_GROUP_ROLE}"`)
  // Column ACLs survive a table-level REVOKE (ADR 0037). Clear every column before the exact grants below.
  await db.$executeRawUnsafe(`DO $$ DECLARE r record; BEGIN FOR r IN SELECT c.relname, a.attname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_attribute a ON a.attrelid = c.oid WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND a.attnum > 0 AND NOT a.attisdropped LOOP EXECUTE format('REVOKE ALL (%I) ON %I FROM %I', r.attname, r.relname, '${BOOKTX_GROUP_ROLE}'); END LOOP; END $$`)
  for (const statement of booktxGrantStatements()) await db.$executeRawUnsafe(statement)
}

export async function deprovisionBooktxRole(db: Executor, loginRole = BOOKTX_LOGIN_ROLE, options: { dropGroup?: boolean } = {}): Promise<void> {
  if (!IDENTIFIER.test(loginRole) || loginRole === BOOKTX_GROUP_ROLE || loginRole === 'postgres') throw new Error('Invalid login role')
  const drop = (role: string) => `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
    IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN EXECUTE 'GRANT "${role}" TO CURRENT_USER WITH INHERIT TRUE, SET TRUE'; END IF;
    DROP OWNED BY "${role}"; DROP ROLE "${role}"; END IF; END $$`
  await db.$executeRawUnsafe(drop(loginRole))
  if (options.dropGroup) await db.$executeRawUnsafe(drop(BOOKTX_GROUP_ROLE))
}

export interface BooktxRoleReport { ok: boolean; failures: string[] }

/** Run while connected AS the login role. Read-only catalogue checks; returns no secret. */
export async function verifyBooktxRole(db: Pick<Executor, '$queryRawUnsafe'>): Promise<BooktxRoleReport> {
  const failures: string[] = []
  const [attrs] = await db.$queryRawUnsafe<Array<{ rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolreplication: boolean; member: boolean; owned: bigint }>>(
    `SELECT r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolreplication,
            pg_has_role(current_user, '${BOOKTX_GROUP_ROLE}', 'MEMBER') AS member,
            (SELECT count(*) FROM pg_tables WHERE tableowner = current_user) AS owned
       FROM pg_roles r WHERE r.rolname = current_user`)
  if (!attrs) return { ok: false, failures: ['role not found'] }
  if (attrs.rolsuper) failures.push('role is SUPERUSER')
  if (attrs.rolbypassrls) failures.push('role has BYPASSRLS')
  if (attrs.rolcreaterole) failures.push('role has CREATEROLE')
  if (attrs.rolcreatedb) failures.push('role has CREATEDB')
  if (attrs.rolreplication) failures.push('role has REPLICATION')
  if (!attrs.member) failures.push(`role is not a member of ${BOOKTX_GROUP_ROLE}`)
  if (Number(attrs.owned) > 0) failures.push('role owns tables')

  const list = (items: readonly string[]) => items.map((t) => `'${t}'`).join(',')
  const count = async (sql: string) => Number((await db.$queryRawUnsafe<Array<{ n: bigint }>>(sql))[0]?.n ?? 0)
  if (await count(`SELECT count(*) AS n FROM unnest(ARRAY[${list(BOOKTX_READ_TABLES)}]) t WHERE NOT has_table_privilege(current_user, format('%I', t), 'SELECT')`) > 0) failures.push('role cannot read a table the booking transaction needs')
  if (await count(`SELECT count(*) AS n FROM unnest(ARRAY[${list(BOOKTX_INSERT_TABLES)}]) t WHERE NOT has_table_privilege(current_user, format('%I', t), 'INSERT')`) > 0) failures.push('role cannot insert a booking transaction table')
  if (await count(`SELECT count(*) AS n FROM pg_tables t WHERE t.schemaname = 'public' AND t.tablename <> ALL(ARRAY[${list(BOOKTX_INSERT_TABLES)}])
      AND has_table_privilege(current_user, format('%I.%I', t.schemaname, t.tablename), 'INSERT')`) > 0) failures.push('role can insert outside the booking transaction tables')
  if (await count(`SELECT count(*) AS n FROM pg_tables t WHERE t.schemaname = 'public'
      AND has_table_privilege(current_user, format('%I.%I', t.schemaname, t.tablename), 'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')`) > 0) failures.push('role holds a table-wide UPDATE, DELETE, TRUNCATE, REFERENCES or TRIGGER privilege')
  for (const [table, columns] of Object.entries(BOOKTX_UPDATE_COLUMNS)) {
    const extra = await count(`SELECT count(*) AS n FROM pg_attribute a WHERE a.attrelid = '"${table}"'::regclass AND a.attnum > 0 AND NOT a.attisdropped AND has_column_privilege(current_user, '"${table}"', a.attname, 'UPDATE') AND a.attname <> ALL(ARRAY[${list(columns)}])`)
    const missing = await count(`SELECT count(*) AS n FROM unnest(ARRAY[${list(columns)}]) c WHERE NOT has_column_privilege(current_user, '"${table}"', c, 'UPDATE')`)
    if (extra > 0) failures.push(`role can update a ${table} column outside its allowed set`)
    if (missing > 0) failures.push(`role cannot update every ${table} column it needs`)
  }
  for (const [table, columns] of Object.entries(BOOKTX_READ_COLUMNS)) {
    const extra = await count(`SELECT count(*) AS n FROM pg_attribute a WHERE a.attrelid = '"${table}"'::regclass AND a.attnum > 0 AND NOT a.attisdropped AND has_column_privilege(current_user, '"${table}"', a.attname, 'SELECT') AND a.attname <> ALL(ARRAY[${list(columns)}])`)
    const whole = await count(`SELECT CASE WHEN has_table_privilege(current_user, '"${table}"', 'SELECT') THEN 1 ELSE 0 END AS n`)
    const missing = await count(`SELECT count(*) AS n FROM unnest(ARRAY[${list(columns)}]) c WHERE NOT has_column_privilege(current_user, '"${table}"', c, 'SELECT')`)
    if (extra > 0 || whole > 0 || missing > 0) failures.push(`role can read ${table} beyond the named columns, or cannot read one it needs`)
  }
  for (const fn of BOOKTX_FUNCTIONS) {
    if (!(await count(`SELECT CASE WHEN has_function_privilege(current_user, '${fn.replace(/'/g, "''")}', 'EXECUTE') THEN 1 ELSE 0 END AS n`))) failures.push(`role cannot execute ${fn}`)
  }
  if (await count(`SELECT count(*) AS n FROM unnest(ARRAY[${list(BOOKTX_FORBIDDEN_TABLES)}]) t WHERE has_table_privilege(current_user, format('%I', t), 'SELECT,INSERT,UPDATE,DELETE')`) > 0) failures.push('role can reach a table outside the booking transaction scope')
  return { ok: failures.length === 0, failures }
}

export interface BooktxProbe { name: string; sql: string; expect: 'allowed' | 'denied' }
export interface BooktxProbeResult { name: string; expect: 'allowed' | 'denied'; ok: boolean }

/** Privilege probes. Every statement is `WHERE false`, so PostgreSQL checks the privilege and no row is read or written. Triggers are certified separately, on real rows. */
export const BOOKTX_PROBES: readonly BooktxProbe[] = [
  { name: 'INSERT Booking', sql: `INSERT INTO "Booking" ("id") SELECT 'x' WHERE false`, expect: 'allowed' },
  { name: 'UPDATE Booking.status', sql: `UPDATE "Booking" SET "status" = "status" WHERE false`, expect: 'allowed' },
  { name: 'UPDATE Booking.search_snapshot', sql: `UPDATE "Booking" SET "search_snapshot" = "search_snapshot" WHERE false`, expect: 'allowed' },
  { name: 'UPDATE Booking.total_minor', sql: `UPDATE "Booking" SET "total_minor" = "total_minor" WHERE false`, expect: 'denied' },
  { name: 'UPDATE Booking.agency_id', sql: `UPDATE "Booking" SET "agency_id" = "agency_id" WHERE false`, expect: 'denied' },
  { name: 'UPDATE Booking.tenant_id', sql: `UPDATE "Booking" SET "tenant_id" = "tenant_id" WHERE false`, expect: 'denied' },
  { name: 'DELETE Booking', sql: `DELETE FROM "Booking" WHERE false`, expect: 'denied' },
  { name: 'INSERT LedgerEntry', sql: `INSERT INTO "LedgerEntry" ("id") SELECT 'x' WHERE false`, expect: 'allowed' },
  { name: 'UPDATE LedgerEntry', sql: `UPDATE "LedgerEntry" SET "amount_minor" = "amount_minor" WHERE false`, expect: 'denied' },
  { name: 'DELETE LedgerEntry', sql: `DELETE FROM "LedgerEntry" WHERE false`, expect: 'denied' },
  { name: 'INSERT Wallet', sql: `INSERT INTO "Wallet" ("id") SELECT 'x' WHERE false`, expect: 'allowed' },
  { name: 'LOCK Wallet (FOR UPDATE)', sql: `SELECT "id" FROM "Wallet" WHERE false FOR UPDATE`, expect: 'allowed' },
  { name: 'UPDATE Wallet.credit_limit', sql: `UPDATE "Wallet" SET "credit_limit" = "credit_limit" WHERE false`, expect: 'denied' },
  { name: 'UPDATE Wallet.cached_balance', sql: `UPDATE "Wallet" SET "cached_balance" = "cached_balance" WHERE false`, expect: 'denied' },
  { name: 'UPDATE DailyAvailability.held', sql: `UPDATE "DailyAvailability" SET "held" = "held" WHERE false`, expect: 'allowed' },
  { name: 'UPDATE DailyAvailability.sold', sql: `UPDATE "DailyAvailability" SET "sold" = "sold" WHERE false`, expect: 'allowed' },
  { name: 'UPDATE DailyAvailability.allotment', sql: `UPDATE "DailyAvailability" SET "allotment" = "allotment" WHERE false`, expect: 'denied' },
  { name: 'INSERT DailyAvailability', sql: `INSERT INTO "DailyAvailability" ("id") SELECT 'x' WHERE false`, expect: 'denied' },
  { name: 'UPDATE InventoryPoolDay.sold', sql: `UPDATE "InventoryPoolDay" SET "sold" = "sold", "held" = "held" WHERE false`, expect: 'allowed' },
  { name: 'UPDATE InventoryPoolDay.capacity', sql: `UPDATE "InventoryPoolDay" SET "capacity" = "capacity" WHERE false`, expect: 'denied' },
  { name: 'INSERT InventoryPoolDay', sql: `INSERT INTO "InventoryPoolDay" ("id") SELECT 'x' WHERE false`, expect: 'denied' },
  { name: 'INSERT AuditEvent', sql: `INSERT INTO "AuditEvent" ("id") SELECT 'x' WHERE false`, expect: 'allowed' },
  { name: 'UPDATE AuditEvent', sql: `UPDATE "AuditEvent" SET "action" = "action" WHERE false`, expect: 'denied' },
  { name: 'SELECT HotelProfile.check_in_time', sql: `SELECT "check_in_time", "local_charges" FROM "HotelProfile" WHERE false`, expect: 'allowed' },
  { name: 'SELECT HotelProfile.contacts', sql: `SELECT "contacts" FROM "HotelProfile" WHERE false`, expect: 'denied' },
  { name: 'SELECT AgencyCreditLimit.limit_minor', sql: `SELECT "limit_minor" FROM "AgencyCreditLimit" WHERE false`, expect: 'allowed' },
  { name: 'SELECT RoomSalesRule.mode', sql: `SELECT "mode", "sales_cap", "consumes_inventory" FROM "RoomSalesRule" WHERE false`, expect: 'allowed' },
  { name: 'SELECT RoomSalesRule.reason', sql: `SELECT "reason" FROM "RoomSalesRule" WHERE false`, expect: 'denied' },
  { name: 'UPDATE AgencyCreditLimit', sql: `UPDATE "AgencyCreditLimit" SET "limit_minor" = "limit_minor" WHERE false`, expect: 'denied' },
  { name: 'SELECT users', sql: `SELECT "id" FROM "users" WHERE false`, expect: 'denied' },
  { name: 'SELECT FundingReceipt', sql: `SELECT "id" FROM "FundingReceipt" WHERE false`, expect: 'denied' },
  { name: 'INSERT FundingReceipt', sql: `INSERT INTO "FundingReceipt" ("id") SELECT 'x' WHERE false`, expect: 'denied' },
  { name: 'SELECT ConnectorCredentialReference', sql: `SELECT "id" FROM "ConnectorCredentialReference" WHERE false`, expect: 'denied' },
  { name: 'INSERT BookingFinanceEvent', sql: `INSERT INTO "BookingFinanceEvent" ("id") SELECT 'x' WHERE false`, expect: 'denied' },
  { name: 'SELECT LedgerChainLink', sql: `SELECT "id" FROM "LedgerChainLink" WHERE false`, expect: 'denied' },
]

export async function runBooktxProbes(db: Executor): Promise<BooktxProbeResult[]> {
  const results: BooktxProbeResult[] = []
  for (const probe of BOOKTX_PROBES) {
    let outcome: 'allowed' | 'denied' | 'error' = 'allowed'
    try { await (probe.sql.startsWith('SELECT') ? db.$queryRawUnsafe(probe.sql) : db.$executeRawUnsafe(probe.sql)) } catch (error) {
      outcome = isDatabasePermissionDenied(error) ? 'denied' : 'error'
    }
    results.push({ name: probe.name, expect: probe.expect, ok: outcome === probe.expect })
  }
  return results
}

export interface BooktxCertification { ok: boolean; role: BooktxRoleReport; probes: BooktxProbeResult[] }

/** Run while connected AS the booking transaction login. The probes write nothing. */
export async function certifyBooktxRole(db: Executor): Promise<BooktxCertification> {
  const role = await verifyBooktxRole(db)
  const probes = await runBooktxProbes(db)
  return { ok: role.ok && probes.every((p) => p.ok), role, probes }
}
