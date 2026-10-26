import { upsertLoginRoleSql } from './hold-expiry-role'
import { isDatabasePermissionDenied } from './db-errors'

/**
 * The narrow database role of supplier statement reconciliation (ADR 0070, ADR 0054 "dedicated restricted role").
 *
 * ADR 0032 keeps finance tables away from the strict API runtime role (`fbeds_api`). This login (`fbeds_recon_ops`, member of the NOLOGIN group `fbeds_recon`)
 * closes that gap without widening the runtime role: it may read and append the reconciliation and bank statement tables, update only the workflow columns of runs and
 * findings, read exactly the booking columns the matcher needs, and append audit events. It can NEVER touch LedgerEntry, Wallet, a booking, a statement
 * after import (statements, lines and decisions have no UPDATE or DELETE), guest data, credentials or the audit log's contents. Row-level security still applies
 * (every use sets the tenant in its transaction). Only `ReconciliationStore` connects with it (`FINANCE_RECONCILIATION_DATABASE_URL`, which must differ from `DATABASE_URL`).
 */
export const RECON_GROUP_ROLE = 'fbeds_recon'
export const RECON_LOGIN_ROLE = 'fbeds_recon_ops'

type Executor = { $executeRawUnsafe(query: string): Promise<number>; $queryRawUnsafe<T = unknown>(query: string): Promise<T> }

const IDENTIFIER = /^[a-z][a-z0-9_]{2,62}$/
const PASSWORD = /^[A-Za-z0-9_-]{32,128}$/

/** Read and append. */
export const RECON_OWN_TABLES = ['SupplierStatement', 'SupplierStatementLine', 'ReconciliationRun', 'ReconciliationFinding', 'ReconciliationDecision', 'BankStatement', 'BankStatementEntry', 'BankMatchFinding'] as const
/** The only columns the role may update. Statements, lines, bank statements, bank entries and decisions are not here: they are immutable. */
export const RECON_UPDATE_COLUMNS = {
  ReconciliationRun: ['status', 'claimed_at', 'started_at', 'finished_at', 'attempts', 'error_code', 'matched_count', 'exception_count'],
  BankMatchFinding: ['status', 'resolution', 'resolution_reason', 'resolved_by_id', 'resolved_at'],
  ReconciliationFinding: ['type', 'rule', 'is_exception', 'booking_id', 'currency', 'statement_minor', 'ledger_minor', 'variance_minor', 'status', 'proposed_action', 'proposed_by_id', 'proposed_reason', 'second_approval_required', 'resolution', 'resolved_by_id', 'resolved_at', 'last_run_id', 'updated_at'],
} as const
/** Column-level SELECT on tables the role reads but must not read whole. `tenant_id` must be readable for the row-level policy. */
export const RECON_READ_COLUMNS = {
  Supplier: ['id', 'tenant_id', 'display_name'],
  Booking: ['id', 'tenant_id', 'reference', 'supplier_ref', 'supplier_id', 'currency', 'net_minor', 'status', 'check_out', 'created_at'],
  BookingFinanceEvent: ['id', 'tenant_id', 'booking_id', 'type', 'penalty_minor', 'created_at'],
  /** The payments bank statements are matched against (ADR 0093). References, amounts and dates only: no payer name, notes or compliance data. */
  SupplierSettlement: ['id', 'tenant_id', 'currency', 'amount_minor', 'paid_on', 'payment_reference', 'status'],
} as const
/** INSERT-only: the audit trail. Not readable by the role. */
export const RECON_INSERT_ONLY_TABLES = ['AuditEvent'] as const
/** Must stay unreadable and unwritable. Checked by the verifier. */
export const RECON_FORBIDDEN_TABLES = ['users', 'sessions', 'memberships', 'LedgerEntry', 'Wallet', 'BookingGuest', 'InventoryHold', 'ConnectorCredentialReference', 'FundingReceipt', 'AuditEvent'] as const
export const RECON_DUE_FUNCTION = 'fbeds_reconciliation_due_tenants()'
/** Funding receipts for bank matching, through a tenant-filtered SECURITY DEFINER function: the role holds no grant on FundingReceipt itself (ADR 0093). */
export const RECON_BANK_RECEIPTS_FUNCTION = 'fbeds_bank_expected_receipts(date, date, integer)'

export function assertReconInput(loginRole: string, password: string): void {
  if (!IDENTIFIER.test(loginRole)) throw new Error('Login role must match [a-z][a-z0-9_]{2,62}')
  if (loginRole === RECON_GROUP_ROLE || loginRole === 'postgres') throw new Error('Login role must be dedicated to reconciliation')
  if (!PASSWORD.test(password)) throw new Error('Password must be 32-128 URL-safe characters [A-Za-z0-9_-]')
}

const cols = (columns: readonly string[]) => columns.map((c) => `"${c}"`).join(', ')

/** The one place the role's privileges are stated. */
export function reconGrantStatements(group = RECON_GROUP_ROLE): string[] {
  return [
    `GRANT USAGE ON SCHEMA public TO "${group}"`,
    ...RECON_OWN_TABLES.map((table) => `GRANT SELECT, INSERT ON "${table}" TO "${group}"`),
    ...Object.entries(RECON_UPDATE_COLUMNS).map(([table, columns]) => `GRANT UPDATE (${cols(columns)}) ON "${table}" TO "${group}"`),
    ...Object.entries(RECON_READ_COLUMNS).map(([table, columns]) => `GRANT SELECT (${cols(columns)}) ON "${table}" TO "${group}"`),
    ...RECON_INSERT_ONLY_TABLES.map((table) => `GRANT INSERT ON "${table}" TO "${group}"`),
    `GRANT EXECUTE ON FUNCTION ${RECON_DUE_FUNCTION} TO "${group}"`,
    `GRANT EXECUTE ON FUNCTION ${RECON_BANK_RECEIPTS_FUNCTION} TO "${group}"`,
  ]
}

/** Idempotent, owner-run. Never creates SUPERUSER, BYPASSRLS, CREATEROLE, CREATEDB or REPLICATION. Revokes everything first so a stale grant cannot survive. Never log the password. */
export async function provisionReconRole(db: Executor, input: { loginRole?: string; password: string }): Promise<void> {
  const loginRole = input.loginRole ?? RECON_LOGIN_ROLE
  assertReconInput(loginRole, input.password)
  const attributes = 'NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'
  await db.$executeRawUnsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RECON_GROUP_ROLE}') THEN CREATE ROLE "${RECON_GROUP_ROLE}" NOLOGIN ${attributes}; END IF; END $$`)
  await db.$executeRawUnsafe(upsertLoginRoleSql(loginRole, input.password, attributes, 5))
  await db.$executeRawUnsafe(`GRANT "${RECON_GROUP_ROLE}" TO "${loginRole}"`)
  await db.$executeRawUnsafe(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM "${RECON_GROUP_ROLE}"`)
  await db.$executeRawUnsafe(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM "${RECON_GROUP_ROLE}"`)
  // Column ACLs survive a table-level REVOKE, so clear them on every column-granted table explicitly (ADR 0037).
  for (const [table, columns] of [...Object.entries(RECON_UPDATE_COLUMNS), ...Object.entries(RECON_READ_COLUMNS)]) await db.$executeRawUnsafe(`REVOKE ALL (${cols(columns)}) ON "${table}" FROM "${RECON_GROUP_ROLE}"`)
  for (const statement of reconGrantStatements()) await db.$executeRawUnsafe(statement)
}

export async function deprovisionReconRole(db: Executor, loginRole = RECON_LOGIN_ROLE, options: { dropGroup?: boolean } = {}): Promise<void> {
  if (!IDENTIFIER.test(loginRole) || loginRole === RECON_GROUP_ROLE || loginRole === 'postgres') throw new Error('Invalid login role')
  const drop = (role: string) => `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
    IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN EXECUTE 'GRANT "${role}" TO CURRENT_USER WITH INHERIT TRUE, SET TRUE'; END IF;
    DROP OWNED BY "${role}"; DROP ROLE "${role}"; END IF; END $$`
  await db.$executeRawUnsafe(drop(loginRole))
  if (options.dropGroup) await db.$executeRawUnsafe(drop(RECON_GROUP_ROLE))
}

export interface ReconRoleReport { ok: boolean; failures: string[] }

/** Run while connected AS the login role. Read-only catalogue checks; returns no secret. */
export async function verifyReconRole(db: Pick<Executor, '$queryRawUnsafe'>): Promise<ReconRoleReport> {
  const failures: string[] = []
  const [attrs] = await db.$queryRawUnsafe<Array<{ rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolreplication: boolean; member: boolean; owned: bigint }>>(
    `SELECT r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolreplication,
            pg_has_role(current_user, '${RECON_GROUP_ROLE}', 'MEMBER') AS member,
            (SELECT count(*) FROM pg_tables WHERE tableowner = current_user) AS owned
       FROM pg_roles r WHERE r.rolname = current_user`)
  if (!attrs) return { ok: false, failures: ['role not found'] }
  if (attrs.rolsuper) failures.push('role is SUPERUSER')
  if (attrs.rolbypassrls) failures.push('role has BYPASSRLS')
  if (attrs.rolcreaterole) failures.push('role has CREATEROLE')
  if (attrs.rolcreatedb) failures.push('role has CREATEDB')
  if (attrs.rolreplication) failures.push('role has REPLICATION')
  if (!attrs.member) failures.push(`role is not a member of ${RECON_GROUP_ROLE}`)
  if (Number(attrs.owned) > 0) failures.push('role owns tables')

  const list = (items: readonly string[]) => items.map((t) => `'${t}'`).join(',')
  const count = async (sql: string) => Number((await db.$queryRawUnsafe<Array<{ n: bigint }>>(sql))[0]?.n ?? 0)
  if (await count(`SELECT count(*) AS n FROM unnest(ARRAY[${list(RECON_OWN_TABLES)}]) t WHERE NOT has_table_privilege(current_user, format('%I', t), 'SELECT,INSERT')`) > 0) failures.push('role cannot read and append every reconciliation table')
  // No table-wide UPDATE, DELETE, TRUNCATE, REFERENCES or TRIGGER anywhere; INSERT only on the five tables and the audit log.
  if (await count(`SELECT count(*) AS n FROM pg_tables t WHERE t.schemaname = 'public'
      AND has_table_privilege(current_user, format('%I.%I', t.schemaname, t.tablename), 'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')`) > 0) failures.push('role holds a table-wide UPDATE, DELETE, TRUNCATE, REFERENCES or TRIGGER privilege')
  if (await count(`SELECT count(*) AS n FROM pg_tables t WHERE t.schemaname = 'public' AND t.tablename <> ALL(ARRAY[${list([...RECON_OWN_TABLES, ...RECON_INSERT_ONLY_TABLES])}])
      AND has_table_privilege(current_user, format('%I.%I', t.schemaname, t.tablename), 'INSERT')`) > 0) failures.push('role can insert outside the reconciliation tables and the audit log')
  for (const [table, columns] of Object.entries(RECON_UPDATE_COLUMNS)) {
    const extra = await count(`SELECT count(*) AS n FROM pg_attribute a WHERE a.attrelid = '"${table}"'::regclass AND a.attnum > 0 AND NOT a.attisdropped AND has_column_privilege(current_user, '"${table}"', a.attname, 'UPDATE') AND a.attname <> ALL(ARRAY[${list(columns)}])`)
    const missing = await count(`SELECT count(*) AS n FROM unnest(ARRAY[${list(columns)}]) c WHERE NOT has_column_privilege(current_user, '"${table}"', c, 'UPDATE')`)
    if (extra > 0) failures.push(`role can update a ${table} column outside its workflow set`)
    if (missing > 0) failures.push(`role cannot update every ${table} column it needs`)
  }
  for (const [table, columns] of Object.entries(RECON_READ_COLUMNS)) {
    const extra = await count(`SELECT count(*) AS n FROM pg_attribute a WHERE a.attrelid = '"${table}"'::regclass AND a.attnum > 0 AND NOT a.attisdropped AND has_column_privilege(current_user, '"${table}"', a.attname, 'SELECT') AND a.attname <> ALL(ARRAY[${list(columns)}])`)
    const whole = await count(`SELECT CASE WHEN has_table_privilege(current_user, '"${table}"', 'SELECT') THEN 1 ELSE 0 END AS n`)
    if (extra > 0 || whole > 0) failures.push(`role can read ${table} columns beyond the matcher's set`)
  }
  if (!(await count(`SELECT CASE WHEN has_table_privilege(current_user, '"AuditEvent"', 'INSERT') THEN 1 ELSE 0 END AS n`))) failures.push('role cannot append audit events')
  if (!(await count(`SELECT CASE WHEN has_function_privilege(current_user, '${RECON_DUE_FUNCTION}', 'EXECUTE') THEN 1 ELSE 0 END AS n`))) failures.push('role cannot list tenants with queued runs')
  if (!(await count(`SELECT CASE WHEN has_function_privilege(current_user, '${RECON_BANK_RECEIPTS_FUNCTION}', 'EXECUTE') THEN 1 ELSE 0 END AS n`))) failures.push('role cannot read funding receipts for bank matching')
  if (await count(`SELECT count(*) AS n FROM unnest(ARRAY[${list(RECON_FORBIDDEN_TABLES)}]) t WHERE has_table_privilege(current_user, format('%I', t), 'SELECT')`) > 0) failures.push('role can read a table outside the reconciliation scope')
  return { ok: failures.length === 0, failures }
}

export interface ReconProbe { name: string; sql: string; expect: 'allowed' | 'denied' }
export interface ReconProbeResult { name: string; expect: 'allowed' | 'denied'; ok: boolean }

/** Privilege probes. Every statement is `WHERE false`, so PostgreSQL decides on privilege at plan time and no row is read or written. */
export const RECON_PROBES: readonly ReconProbe[] = [
  { name: 'SELECT SupplierStatement', sql: `SELECT "id", "statement_ref" FROM "SupplierStatement" WHERE false`, expect: 'allowed' },
  { name: 'INSERT SupplierStatement', sql: `INSERT INTO "SupplierStatement" ("id") SELECT 'x' WHERE false`, expect: 'allowed' },
  { name: 'INSERT SupplierStatementLine', sql: `INSERT INTO "SupplierStatementLine" ("id") SELECT 'x' WHERE false`, expect: 'allowed' },
  { name: 'INSERT ReconciliationRun', sql: `INSERT INTO "ReconciliationRun" ("id") SELECT 'x' WHERE false`, expect: 'allowed' },
  { name: 'UPDATE ReconciliationRun.status', sql: `UPDATE "ReconciliationRun" SET "status" = "status" WHERE false`, expect: 'allowed' },
  { name: 'UPDATE ReconciliationFinding.status', sql: `UPDATE "ReconciliationFinding" SET "status" = "status" WHERE false`, expect: 'allowed' },
  { name: 'INSERT ReconciliationDecision', sql: `INSERT INTO "ReconciliationDecision" ("id") SELECT 'x' WHERE false`, expect: 'allowed' },
  { name: 'SELECT Booking net and reference', sql: `SELECT "id", "reference", "net_minor", "supplier_id", "check_out" FROM "Booking" WHERE false`, expect: 'allowed' },
  { name: 'SELECT BookingFinanceEvent penalty', sql: `SELECT "booking_id", "penalty_minor" FROM "BookingFinanceEvent" WHERE false`, expect: 'allowed' },
  { name: 'SELECT Supplier name', sql: `SELECT "id", "display_name" FROM "Supplier" WHERE false`, expect: 'allowed' },
  { name: 'INSERT AuditEvent', sql: `INSERT INTO "AuditEvent" ("id") SELECT 'x' WHERE false`, expect: 'allowed' },
  { name: 'INSERT BankStatement', sql: `INSERT INTO "BankStatement" ("id") SELECT 'x' WHERE false`, expect: 'allowed' },
  { name: 'INSERT BankStatementEntry', sql: `INSERT INTO "BankStatementEntry" ("id") SELECT 'x' WHERE false`, expect: 'allowed' },
  { name: 'INSERT BankMatchFinding', sql: `INSERT INTO "BankMatchFinding" ("id") SELECT 'x' WHERE false`, expect: 'allowed' },
  { name: 'UPDATE BankMatchFinding.status', sql: `UPDATE "BankMatchFinding" SET "status" = "status" WHERE false`, expect: 'allowed' },
  { name: 'SELECT SupplierSettlement reference and amount', sql: `SELECT "id", "payment_reference", "amount_minor", "paid_on", "status" FROM "SupplierSettlement" WHERE false`, expect: 'allowed' },
  { name: 'EXECUTE fbeds_bank_expected_receipts', sql: `SELECT "id", "bank_reference" FROM fbeds_bank_expected_receipts('2000-01-01', '2000-01-01', 0)`, expect: 'allowed' },
  { name: 'SELECT FundingReceipt', sql: `SELECT "id" FROM "FundingReceipt" WHERE false`, expect: 'denied' },
  { name: 'UPDATE BankStatement', sql: `UPDATE "BankStatement" SET "statement_ref" = "statement_ref" WHERE false`, expect: 'denied' },
  { name: 'UPDATE BankStatementEntry', sql: `UPDATE "BankStatementEntry" SET "amount_minor" = "amount_minor" WHERE false`, expect: 'denied' },
  { name: 'DELETE BankMatchFinding', sql: `DELETE FROM "BankMatchFinding" WHERE false`, expect: 'denied' },
  { name: 'UPDATE BankMatchFinding.bank_minor', sql: `UPDATE "BankMatchFinding" SET "bank_minor" = "bank_minor" WHERE false`, expect: 'denied' },
  { name: 'SELECT FundingReceipt.payer_name', sql: `SELECT "payer_name" FROM "FundingReceipt" WHERE false`, expect: 'denied' },
  { name: 'UPDATE FundingReceipt', sql: `UPDATE "FundingReceipt" SET "status" = "status" WHERE false`, expect: 'denied' },
  { name: 'UPDATE SupplierSettlement', sql: `UPDATE "SupplierSettlement" SET "status" = "status" WHERE false`, expect: 'denied' },
  { name: 'UPDATE SupplierStatement', sql: `UPDATE "SupplierStatement" SET "statement_ref" = "statement_ref" WHERE false`, expect: 'denied' },
  { name: 'UPDATE SupplierStatementLine', sql: `UPDATE "SupplierStatementLine" SET "amount_minor" = "amount_minor" WHERE false`, expect: 'denied' },
  { name: 'UPDATE ReconciliationDecision', sql: `UPDATE "ReconciliationDecision" SET "reason" = "reason" WHERE false`, expect: 'denied' },
  { name: 'DELETE SupplierStatement', sql: `DELETE FROM "SupplierStatement" WHERE false`, expect: 'denied' },
  { name: 'DELETE ReconciliationFinding', sql: `DELETE FROM "ReconciliationFinding" WHERE false`, expect: 'denied' },
  { name: 'UPDATE ReconciliationFinding.finding_key', sql: `UPDATE "ReconciliationFinding" SET "finding_key" = "finding_key" WHERE false`, expect: 'denied' },
  { name: 'UPDATE ReconciliationFinding.tenant_id', sql: `UPDATE "ReconciliationFinding" SET "tenant_id" = "tenant_id" WHERE false`, expect: 'denied' },
  { name: 'SELECT Booking.total_minor', sql: `SELECT "total_minor" FROM "Booking" WHERE false`, expect: 'denied' },
  { name: 'SELECT Booking.search_snapshot', sql: `SELECT "search_snapshot" FROM "Booking" WHERE false`, expect: 'denied' },
  { name: 'INSERT Booking', sql: `INSERT INTO "Booking" ("id") SELECT 'x' WHERE false`, expect: 'denied' },
  { name: 'UPDATE Booking', sql: `UPDATE "Booking" SET "net_minor" = "net_minor" WHERE false`, expect: 'denied' },
  { name: 'SELECT BookingGuest', sql: `SELECT "id" FROM "BookingGuest" WHERE false`, expect: 'denied' },
  { name: 'SELECT LedgerEntry', sql: `SELECT "id" FROM "LedgerEntry" WHERE false`, expect: 'denied' },
  { name: 'INSERT LedgerEntry', sql: `INSERT INTO "LedgerEntry" ("id") SELECT 'x' WHERE false`, expect: 'denied' },
  { name: 'SELECT Wallet', sql: `SELECT "id" FROM "Wallet" WHERE false`, expect: 'denied' },
  { name: 'UPDATE Wallet', sql: `UPDATE "Wallet" SET "cached_balance" = "cached_balance" WHERE false`, expect: 'denied' },
  { name: 'SELECT AuditEvent', sql: `SELECT "id" FROM "AuditEvent" WHERE false`, expect: 'denied' },
  { name: 'SELECT users', sql: `SELECT "id" FROM "users" WHERE false`, expect: 'denied' },
]

/** A probe is ok when an `allowed` statement runs, or a `denied` statement fails with insufficient_privilege (any other failure is not a pass). */
export async function runReconProbes(db: Executor): Promise<ReconProbeResult[]> {
  const results: ReconProbeResult[] = []
  for (const probe of RECON_PROBES) {
    let outcome: 'allowed' | 'denied' | 'error' = 'allowed'
    try { await (probe.sql.startsWith('SELECT') ? db.$queryRawUnsafe(probe.sql) : db.$executeRawUnsafe(probe.sql)) } catch (error) {
      outcome = isDatabasePermissionDenied(error) ? 'denied' : 'error'
    }
    results.push({ name: probe.name, expect: probe.expect, ok: outcome === probe.expect })
  }
  return results
}

export interface ReconCertification { ok: boolean; role: ReconRoleReport; probes: ReconProbeResult[] }

/** Run while connected AS the reconciliation login. Read-only. */
export async function certifyReconRole(db: Executor): Promise<ReconCertification> {
  const role = await verifyReconRole(db)
  const probes = await runReconProbes(db)
  return { ok: role.ok && probes.every((p) => p.ok), role, probes }
}
