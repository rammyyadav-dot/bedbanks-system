import { upsertLoginRoleSql } from './hold-expiry-role'
import { isDatabasePermissionDenied } from './db-errors'

/**
 * The narrow database role of the booking Finance consumer (ADR 0076).
 *
 * ADR 0032 keeps finance tables away from the strict API runtime role, and ADR 0039 keeps the ledger away from the booking role. This login (`fbeds_finpost_ops`, member of
 * the NOLOGIN group `fbeds_finpost`) is the one principal that turns a `BookingFinanceEvent` into ledger entries and supplier payable entries. It may read exactly the event,
 * booking and wallet columns the posting rules need, read and append the ledger, read and append its own two tables (and update the workflow columns of a posting that is
 * still under review), lock a wallet row, and append audit events. It can NEVER create or change a booking, a booking event, a wallet balance or limit, an agency, a funding
 * receipt, a guest record or a credential, and it can never update or delete a ledger entry. Row-level security still applies (every use sets the tenant in its transaction).
 * Only `BookingFinancePostingDatabase` connects with it (`BOOKING_FINANCE_POSTING_DATABASE_URL`, which must differ from `DATABASE_URL`).
 */
export const FINPOST_GROUP_ROLE = 'fbeds_finpost'
export const FINPOST_LOGIN_ROLE = 'fbeds_finpost_ops'

type Executor = { $executeRawUnsafe(query: string): Promise<number>; $queryRawUnsafe<T = unknown>(query: string): Promise<T> }

const IDENTIFIER = /^[a-z][a-z0-9_]{2,62}$/
const PASSWORD = /^[A-Za-z0-9_-]{32,128}$/

/** Read and append. LedgerEntry has no UPDATE or DELETE grant and a trigger forbids both besides. `Cancellation` is the record the ledger integrity monitor ties a cancelled, charged booking to (ADR 0068). */
export const FINPOST_OWN_TABLES = ['BookingFinancePosting', 'SupplierPayableEntry', 'LedgerEntry', 'Cancellation'] as const
/** The only columns the role may update: a posting that is under review is retried and finally closed. Identity columns are not here. */
export const FINPOST_UPDATE_COLUMNS = {
  BookingFinancePosting: ['status', 'reason', 'attempts', 'wallet_id', 'agency_effect_minor', 'payable_effect_minor', 'updated_at'],
  /** The refund a cancellation record fixed, when a later decision or waiver changes it. The booking it belongs to is not writable. */
  Cancellation: ['refund_minor'],
  /** Lock only (`SELECT … FOR UPDATE` needs an UPDATE privilege). The balance, the limit and the identity of an account are not writable. */
  Wallet: ['updated_at'],
} as const
/** Column-level SELECT on tables the role reads but must not read whole. `tenant_id` must be readable for the row-level policy. */
export const FINPOST_READ_COLUMNS = {
  BookingFinanceEvent: ['id', 'tenant_id', 'booking_id', 'type', 'seq', 'currency', 'sell_minor', 'net_minor', 'penalty_minor', 'refund_minor', 'adjustment_minor', 'payment_mode', 'created_at'],
  Booking: ['id', 'tenant_id', 'status', 'currency', 'agency_id', 'supplier_id', 'payment_mode', 'net_minor'],
  Wallet: ['id', 'tenant_id', 'agency_id', 'currency', 'credit_limit'],
} as const
/** INSERT-only: the audit trail. Not readable by the role. */
export const FINPOST_INSERT_ONLY_TABLES = ['AuditEvent'] as const
/** Must stay unreadable and unwritable. Checked by the verifier. */
export const FINPOST_FORBIDDEN_TABLES = ['users', 'sessions', 'memberships', 'BookingGuest', 'BookingEvent', 'BookingDocument', 'InventoryHold', 'ConnectorCredentialReference', 'FundingReceipt', 'AuditEvent', 'SupplierStatement', 'ReconciliationFinding'] as const
export const FINPOST_DUE_FUNCTION = 'fbeds_finance_posting_due_tenants()'

export function assertFinpostInput(loginRole: string, password: string): void {
  if (!IDENTIFIER.test(loginRole)) throw new Error('Login role must match [a-z][a-z0-9_]{2,62}')
  if (loginRole === FINPOST_GROUP_ROLE || loginRole === 'postgres') throw new Error('Login role must be dedicated to finance posting')
  if (!PASSWORD.test(password)) throw new Error('Password must be 32-128 URL-safe characters [A-Za-z0-9_-]')
}

const cols = (columns: readonly string[]) => columns.map((c) => `"${c}"`).join(', ')

/** The one place the role's privileges are stated. */
export function finpostGrantStatements(group = FINPOST_GROUP_ROLE): string[] {
  return [
    `GRANT USAGE ON SCHEMA public TO "${group}"`,
    ...FINPOST_OWN_TABLES.map((table) => `GRANT SELECT, INSERT ON "${table}" TO "${group}"`),
    ...Object.entries(FINPOST_UPDATE_COLUMNS).map(([table, columns]) => `GRANT UPDATE (${cols(columns)}) ON "${table}" TO "${group}"`),
    ...Object.entries(FINPOST_READ_COLUMNS).map(([table, columns]) => `GRANT SELECT (${cols(columns)}) ON "${table}" TO "${group}"`),
    ...FINPOST_INSERT_ONLY_TABLES.map((table) => `GRANT INSERT ON "${table}" TO "${group}"`),
    `GRANT EXECUTE ON FUNCTION ${FINPOST_DUE_FUNCTION} TO "${group}"`,
  ]
}

/** Idempotent, owner-run. Never creates SUPERUSER, BYPASSRLS, CREATEROLE, CREATEDB or REPLICATION. Revokes everything first so a stale grant cannot survive. Never log the password. */
export async function provisionFinpostRole(db: Executor, input: { loginRole?: string; password: string }): Promise<void> {
  const loginRole = input.loginRole ?? FINPOST_LOGIN_ROLE
  assertFinpostInput(loginRole, input.password)
  const attributes = 'NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'
  await db.$executeRawUnsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${FINPOST_GROUP_ROLE}') THEN CREATE ROLE "${FINPOST_GROUP_ROLE}" NOLOGIN ${attributes}; END IF; END $$`)
  await db.$executeRawUnsafe(upsertLoginRoleSql(loginRole, input.password, attributes, 5))
  await db.$executeRawUnsafe(`GRANT "${FINPOST_GROUP_ROLE}" TO "${loginRole}"`)
  await db.$executeRawUnsafe(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM "${FINPOST_GROUP_ROLE}"`)
  await db.$executeRawUnsafe(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM "${FINPOST_GROUP_ROLE}"`)
  // Column ACLs survive a table-level REVOKE, so clear them on every column-granted table explicitly (ADR 0037).
  for (const [table, columns] of [...Object.entries(FINPOST_UPDATE_COLUMNS), ...Object.entries(FINPOST_READ_COLUMNS)]) await db.$executeRawUnsafe(`REVOKE ALL (${cols(columns)}) ON "${table}" FROM "${FINPOST_GROUP_ROLE}"`)
  for (const statement of finpostGrantStatements()) await db.$executeRawUnsafe(statement)
}

export async function deprovisionFinpostRole(db: Executor, loginRole = FINPOST_LOGIN_ROLE, options: { dropGroup?: boolean } = {}): Promise<void> {
  if (!IDENTIFIER.test(loginRole) || loginRole === FINPOST_GROUP_ROLE || loginRole === 'postgres') throw new Error('Invalid login role')
  const drop = (role: string) => `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
    IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN EXECUTE 'GRANT "${role}" TO CURRENT_USER WITH INHERIT TRUE, SET TRUE'; END IF;
    DROP OWNED BY "${role}"; DROP ROLE "${role}"; END IF; END $$`
  await db.$executeRawUnsafe(drop(loginRole))
  if (options.dropGroup) await db.$executeRawUnsafe(drop(FINPOST_GROUP_ROLE))
}

export interface FinpostRoleReport { ok: boolean; failures: string[] }

/** Run while connected AS the login role. Read-only catalogue checks; returns no secret. */
export async function verifyFinpostRole(db: Pick<Executor, '$queryRawUnsafe'>): Promise<FinpostRoleReport> {
  const failures: string[] = []
  const [attrs] = await db.$queryRawUnsafe<Array<{ rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolreplication: boolean; member: boolean; owned: bigint }>>(
    `SELECT r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolreplication,
            pg_has_role(current_user, '${FINPOST_GROUP_ROLE}', 'MEMBER') AS member,
            (SELECT count(*) FROM pg_tables WHERE tableowner = current_user) AS owned
       FROM pg_roles r WHERE r.rolname = current_user`)
  if (!attrs) return { ok: false, failures: ['role not found'] }
  if (attrs.rolsuper) failures.push('role is SUPERUSER')
  if (attrs.rolbypassrls) failures.push('role has BYPASSRLS')
  if (attrs.rolcreaterole) failures.push('role has CREATEROLE')
  if (attrs.rolcreatedb) failures.push('role has CREATEDB')
  if (attrs.rolreplication) failures.push('role has REPLICATION')
  if (!attrs.member) failures.push(`role is not a member of ${FINPOST_GROUP_ROLE}`)
  if (Number(attrs.owned) > 0) failures.push('role owns tables')

  const list = (items: readonly string[]) => items.map((t) => `'${t}'`).join(',')
  const count = async (sql: string) => Number((await db.$queryRawUnsafe<Array<{ n: bigint }>>(sql))[0]?.n ?? 0)
  if (await count(`SELECT count(*) AS n FROM unnest(ARRAY[${list(FINPOST_OWN_TABLES)}]) t WHERE NOT has_table_privilege(current_user, format('%I', t), 'SELECT,INSERT')`) > 0) failures.push('role cannot read and append every finance posting table')
  // No table-wide UPDATE, DELETE, TRUNCATE, REFERENCES or TRIGGER anywhere; INSERT only on its own tables and the audit log.
  if (await count(`SELECT count(*) AS n FROM pg_tables t WHERE t.schemaname = 'public'
      AND has_table_privilege(current_user, format('%I.%I', t.schemaname, t.tablename), 'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')`) > 0) failures.push('role holds a table-wide UPDATE, DELETE, TRUNCATE, REFERENCES or TRIGGER privilege')
  if (await count(`SELECT count(*) AS n FROM pg_tables t WHERE t.schemaname = 'public' AND t.tablename <> ALL(ARRAY[${list([...FINPOST_OWN_TABLES, ...FINPOST_INSERT_ONLY_TABLES])}])
      AND has_table_privilege(current_user, format('%I.%I', t.schemaname, t.tablename), 'INSERT')`) > 0) failures.push('role can insert outside the finance posting tables and the audit log')
  for (const [table, columns] of Object.entries(FINPOST_UPDATE_COLUMNS)) {
    const extra = await count(`SELECT count(*) AS n FROM pg_attribute a WHERE a.attrelid = '"${table}"'::regclass AND a.attnum > 0 AND NOT a.attisdropped AND has_column_privilege(current_user, '"${table}"', a.attname, 'UPDATE') AND a.attname <> ALL(ARRAY[${list(columns)}])`)
    const missing = await count(`SELECT count(*) AS n FROM unnest(ARRAY[${list(columns)}]) c WHERE NOT has_column_privilege(current_user, '"${table}"', c, 'UPDATE')`)
    if (extra > 0) failures.push(`role can update a ${table} column outside its allowed set`)
    if (missing > 0) failures.push(`role cannot update every ${table} column it needs`)
  }
  for (const [table, columns] of Object.entries(FINPOST_READ_COLUMNS)) {
    const extra = await count(`SELECT count(*) AS n FROM pg_attribute a WHERE a.attrelid = '"${table}"'::regclass AND a.attnum > 0 AND NOT a.attisdropped AND has_column_privilege(current_user, '"${table}"', a.attname, 'SELECT') AND a.attname <> ALL(ARRAY[${list(columns)}])`)
    const whole = await count(`SELECT CASE WHEN has_table_privilege(current_user, '"${table}"', 'SELECT') THEN 1 ELSE 0 END AS n`)
    if (extra > 0 || whole > 0) failures.push(`role can read ${table} columns beyond the posting rules' set`)
  }
  if (!(await count(`SELECT CASE WHEN has_table_privilege(current_user, '"AuditEvent"', 'INSERT') THEN 1 ELSE 0 END AS n`))) failures.push('role cannot append audit events')
  if (!(await count(`SELECT CASE WHEN has_function_privilege(current_user, '${FINPOST_DUE_FUNCTION}', 'EXECUTE') THEN 1 ELSE 0 END AS n`))) failures.push('role cannot list tenants with unposted events')
  if (await count(`SELECT count(*) AS n FROM unnest(ARRAY[${list(FINPOST_FORBIDDEN_TABLES)}]) t WHERE has_table_privilege(current_user, format('%I', t), 'SELECT')`) > 0) failures.push('role can read a table outside the finance posting scope')
  return { ok: failures.length === 0, failures }
}

export interface FinpostProbe { name: string; sql: string; expect: 'allowed' | 'denied' }
export interface FinpostProbeResult { name: string; expect: 'allowed' | 'denied'; ok: boolean }

/** Privilege probes. Every statement is `WHERE false`, so PostgreSQL decides on privilege at plan time and no row is read or written. */
export const FINPOST_PROBES: readonly FinpostProbe[] = [
  { name: 'SELECT BookingFinanceEvent amounts', sql: `SELECT "id", "type", "sell_minor", "net_minor", "penalty_minor", "refund_minor", "adjustment_minor", "payment_mode" FROM "BookingFinanceEvent" WHERE false`, expect: 'allowed' },
  { name: 'SELECT Booking agency and supplier', sql: `SELECT "id", "agency_id", "supplier_id", "currency", "status", "payment_mode", "net_minor" FROM "Booking" WHERE false`, expect: 'allowed' },
  { name: 'SELECT Wallet identity and limit', sql: `SELECT "id", "agency_id", "currency", "credit_limit" FROM "Wallet" WHERE false`, expect: 'allowed' },
  { name: 'LOCK Wallet row (FOR UPDATE)', sql: `SELECT "id" FROM "Wallet" WHERE false FOR UPDATE`, expect: 'allowed' },
  { name: 'SELECT LedgerEntry', sql: `SELECT "id", "wallet_id", "type", "amount_minor", "idempotency_key" FROM "LedgerEntry" WHERE false`, expect: 'allowed' },
  { name: 'INSERT LedgerEntry', sql: `INSERT INTO "LedgerEntry" ("id") SELECT 'x' WHERE false`, expect: 'allowed' },
  { name: 'SELECT BookingFinancePosting', sql: `SELECT "id", "status" FROM "BookingFinancePosting" WHERE false`, expect: 'allowed' },
  { name: 'INSERT BookingFinancePosting', sql: `INSERT INTO "BookingFinancePosting" ("id") SELECT 'x' WHERE false`, expect: 'allowed' },
  { name: 'UPDATE BookingFinancePosting.status', sql: `UPDATE "BookingFinancePosting" SET "status" = "status" WHERE false`, expect: 'allowed' },
  { name: 'SELECT SupplierPayableEntry', sql: `SELECT "id", "amount_minor" FROM "SupplierPayableEntry" WHERE false`, expect: 'allowed' },
  { name: 'INSERT SupplierPayableEntry', sql: `INSERT INTO "SupplierPayableEntry" ("id") SELECT 'x' WHERE false`, expect: 'allowed' },
  { name: 'SELECT Cancellation', sql: `SELECT "id", "booking_id", "refund_minor" FROM "Cancellation" WHERE false`, expect: 'allowed' },
  { name: 'INSERT Cancellation', sql: `INSERT INTO "Cancellation" ("id") SELECT 'x' WHERE false`, expect: 'allowed' },
  { name: 'UPDATE Cancellation.refund_minor', sql: `UPDATE "Cancellation" SET "refund_minor" = "refund_minor" WHERE false`, expect: 'allowed' },
  { name: 'INSERT AuditEvent', sql: `INSERT INTO "AuditEvent" ("id") SELECT 'x' WHERE false`, expect: 'allowed' },
  { name: 'UPDATE Cancellation.booking_id', sql: `UPDATE "Cancellation" SET "booking_id" = "booking_id" WHERE false`, expect: 'denied' },
  { name: 'DELETE Cancellation', sql: `DELETE FROM "Cancellation" WHERE false`, expect: 'denied' },
  { name: 'UPDATE LedgerEntry', sql: `UPDATE "LedgerEntry" SET "amount_minor" = "amount_minor" WHERE false`, expect: 'denied' },
  { name: 'DELETE LedgerEntry', sql: `DELETE FROM "LedgerEntry" WHERE false`, expect: 'denied' },
  { name: 'UPDATE Wallet.cached_balance', sql: `UPDATE "Wallet" SET "cached_balance" = "cached_balance" WHERE false`, expect: 'denied' },
  { name: 'UPDATE Wallet.credit_limit', sql: `UPDATE "Wallet" SET "credit_limit" = "credit_limit" WHERE false`, expect: 'denied' },
  { name: 'INSERT Wallet', sql: `INSERT INTO "Wallet" ("id") SELECT 'x' WHERE false`, expect: 'denied' },
  { name: 'SELECT Wallet.cached_balance', sql: `SELECT "cached_balance" FROM "Wallet" WHERE false`, expect: 'denied' },
  { name: 'UPDATE SupplierPayableEntry', sql: `UPDATE "SupplierPayableEntry" SET "amount_minor" = "amount_minor" WHERE false`, expect: 'denied' },
  { name: 'DELETE SupplierPayableEntry', sql: `DELETE FROM "SupplierPayableEntry" WHERE false`, expect: 'denied' },
  { name: 'DELETE BookingFinancePosting', sql: `DELETE FROM "BookingFinancePosting" WHERE false`, expect: 'denied' },
  { name: 'UPDATE BookingFinancePosting.event_id', sql: `UPDATE "BookingFinancePosting" SET "event_id" = "event_id" WHERE false`, expect: 'denied' },
  { name: 'UPDATE BookingFinancePosting.tenant_id', sql: `UPDATE "BookingFinancePosting" SET "tenant_id" = "tenant_id" WHERE false`, expect: 'denied' },
  { name: 'INSERT BookingFinanceEvent', sql: `INSERT INTO "BookingFinanceEvent" ("id") SELECT 'x' WHERE false`, expect: 'denied' },
  { name: 'UPDATE BookingFinanceEvent', sql: `UPDATE "BookingFinanceEvent" SET "sell_minor" = "sell_minor" WHERE false`, expect: 'denied' },
  { name: 'SELECT BookingFinanceEvent.payload', sql: `SELECT "payload" FROM "BookingFinanceEvent" WHERE false`, expect: 'denied' },
  { name: 'SELECT Booking.total_minor', sql: `SELECT "total_minor" FROM "Booking" WHERE false`, expect: 'denied' },
  { name: 'SELECT Booking.search_snapshot', sql: `SELECT "search_snapshot" FROM "Booking" WHERE false`, expect: 'denied' },
  { name: 'INSERT Booking', sql: `INSERT INTO "Booking" ("id") SELECT 'x' WHERE false`, expect: 'denied' },
  { name: 'UPDATE Booking', sql: `UPDATE "Booking" SET "net_minor" = "net_minor" WHERE false`, expect: 'denied' },
  { name: 'SELECT BookingGuest', sql: `SELECT "id" FROM "BookingGuest" WHERE false`, expect: 'denied' },
  { name: 'SELECT BookingEvent', sql: `SELECT "id" FROM "BookingEvent" WHERE false`, expect: 'denied' },
  { name: 'SELECT FundingReceipt', sql: `SELECT "id" FROM "FundingReceipt" WHERE false`, expect: 'denied' },
  { name: 'INSERT FundingReceipt', sql: `INSERT INTO "FundingReceipt" ("id") SELECT 'x' WHERE false`, expect: 'denied' },
  { name: 'SELECT AuditEvent', sql: `SELECT "id" FROM "AuditEvent" WHERE false`, expect: 'denied' },
  { name: 'SELECT users', sql: `SELECT "id" FROM "users" WHERE false`, expect: 'denied' },
]

/** A probe is ok when an `allowed` statement runs, or a `denied` statement fails with insufficient_privilege (any other failure is not a pass). */
export async function runFinpostProbes(db: Executor): Promise<FinpostProbeResult[]> {
  const results: FinpostProbeResult[] = []
  for (const probe of FINPOST_PROBES) {
    let outcome: 'allowed' | 'denied' | 'error' = 'allowed'
    try { await (probe.sql.startsWith('SELECT') ? db.$queryRawUnsafe(probe.sql) : db.$executeRawUnsafe(probe.sql)) } catch (error) {
      outcome = isDatabasePermissionDenied(error) ? 'denied' : 'error'
    }
    results.push({ name: probe.name, expect: probe.expect, ok: outcome === probe.expect })
  }
  return results
}

export interface FinpostCertification { ok: boolean; role: FinpostRoleReport; probes: FinpostProbeResult[] }

/** Run while connected AS the finance posting login. Read-only. */
export async function certifyFinpostRole(db: Executor): Promise<FinpostCertification> {
  const role = await verifyFinpostRole(db)
  const probes = await runFinpostProbes(db)
  return { ok: role.ok && probes.every((p) => p.ok), role, probes }
}
