import { upsertLoginRoleSql } from './hold-expiry-role'

/**
 * The restricted database role of the nightly ledger integrity run (ADR 0064).
 *
 * Why a separate principal: the strict API runtime role is denied the ledger and wallet tables, and the HTTP role must never be widened. The
 * nightly run needs to READ the ledger and WRITE exactly two kinds of row: its own immutable result, and one SYSTEM audit event. Nothing else.
 * It cannot post, change or delete any ledger, wallet, booking, agency or user row, and it cannot read guest data or sessions.
 */
export const LEDGER_AUDIT_GROUP_ROLE = 'fbeds_ledger_audit'
export const LEDGER_AUDIT_LOGIN_ROLE = 'fbeds_ledger_audit_login'

type Executor = { $executeRawUnsafe(query: string): Promise<number>; $queryRawUnsafe<T = unknown>(query: string): Promise<T> }

const IDENTIFIER = /^[a-z][a-z0-9_]{2,62}$/
const PASSWORD = /^[A-Za-z0-9_-]{32,128}$/

/** Tables the role must never be able to read. Checked by the verifier. */
export const LEDGER_AUDIT_FORBIDDEN_TABLES = ['Booking', 'BookingGuest', 'BookingRoom', 'users', 'sessions', 'memberships', 'Agency', 'AgencyMember', 'Hotel', 'Contract', 'DailyRate', 'InventoryHold', 'FundingReceipt', 'ConnectorCredentialReference'] as const

export function assertLedgerAuditInput(loginRole: string, password: string): void {
  if (!IDENTIFIER.test(loginRole)) throw new Error('Login role must match [a-z][a-z0-9_]{2,62}')
  if (loginRole === LEDGER_AUDIT_GROUP_ROLE || loginRole === 'postgres') throw new Error('Login role must be dedicated to the ledger audit run')
  if (!PASSWORD.test(password)) throw new Error('Password must be 32-128 URL-safe characters [A-Za-z0-9_-]')
}

/** Grant statements, in order. The one place this role's privileges are stated. */
export function ledgerAuditGrantStatements(group = LEDGER_AUDIT_GROUP_ROLE): string[] {
  const g = `"${group}"`
  return [
    `GRANT USAGE ON SCHEMA public TO ${g}`,
    // Which tenants exist and are active. Nothing else about a tenant.
    `GRANT SELECT ("id", "status") ON "tenants" TO ${g}`,
    // The things the report reads. Read-only: no INSERT, UPDATE or DELETE on money, ever.
    `GRANT SELECT ON "Wallet" TO ${g}`,
    `GRANT SELECT ON "LedgerEntry" TO ${g}`,
    // The credit line of an agency account: the agency, its currency and its limit (and the row id the query layer always reads). Not who approved it or why.
    `GRANT SELECT ("id", "tenant_id", "agency_id", "currency", "limit_minor") ON "AgencyCreditLimit" TO ${g}`,
    // Its own result: append and read back. No UPDATE, no DELETE (a trigger also refuses both).
    `GRANT SELECT, INSERT ON "LedgerIntegrityRun" TO ${g}`,
    // The run's SYSTEM audit event (one narrow RLS policy allows only that action). INSERT ... RETURNING needs SELECT.
    `GRANT SELECT, INSERT ON "AuditEvent" TO ${g}`,
  ]
}

/**
 * Idempotently creates the least-privilege group role and one LOGIN member. Must run as the database owner (or another role allowed to
 * CREATE ROLE and GRANT). Never creates SUPERUSER, BYPASSRLS, CREATEROLE, CREATEDB or REPLICATION roles. Never log the password.
 */
export async function provisionLedgerAuditRole(db: Executor, input: { loginRole: string; password: string }): Promise<void> {
  assertLedgerAuditInput(input.loginRole, input.password)
  const login = `"${input.loginRole}"`
  const group = `"${LEDGER_AUDIT_GROUP_ROLE}"`
  const attributes = 'NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'
  await db.$executeRawUnsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${LEDGER_AUDIT_GROUP_ROLE}') THEN CREATE ROLE ${group} NOLOGIN ${attributes}; END IF; END $$`)
  await db.$executeRawUnsafe(upsertLoginRoleSql(input.loginRole, input.password, attributes, 5))
  await db.$executeRawUnsafe(`GRANT ${group} TO ${login}`)
  await db.$executeRawUnsafe(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${group}`)
  for (const statement of ledgerAuditGrantStatements()) await db.$executeRawUnsafe(statement)
}

/** Removes the login role and, optionally, the group role. Used for rotation, rollback and tests. */
export async function deprovisionLedgerAuditRole(db: Executor, loginRole: string, options: { dropGroup?: boolean } = {}): Promise<void> {
  if (!IDENTIFIER.test(loginRole) || loginRole === LEDGER_AUDIT_GROUP_ROLE || loginRole === 'postgres') throw new Error('Invalid login role')
  await db.$executeRawUnsafe(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${loginRole}') THEN
    IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN EXECUTE 'GRANT "${loginRole}" TO CURRENT_USER WITH INHERIT TRUE, SET TRUE'; END IF;
    DROP OWNED BY "${loginRole}"; DROP ROLE "${loginRole}"; END IF; END $$`)
  if (options.dropGroup) {
    await db.$executeRawUnsafe(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${LEDGER_AUDIT_GROUP_ROLE}') THEN
      IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN EXECUTE 'GRANT "${LEDGER_AUDIT_GROUP_ROLE}" TO CURRENT_USER WITH INHERIT TRUE, SET TRUE'; END IF;
      DROP OWNED BY "${LEDGER_AUDIT_GROUP_ROLE}"; DROP ROLE "${LEDGER_AUDIT_GROUP_ROLE}"; END IF; END $$`)
  }
}

export interface LedgerAuditRoleReport { ok: boolean; failures: string[] }

/** Run while connected AS the restricted login role. Read-only catalog checks in both directions; no secrets returned. */
export async function verifyLedgerAuditRole(db: Pick<Executor, '$queryRawUnsafe'>): Promise<LedgerAuditRoleReport> {
  const failures: string[] = []
  const [attrs] = await db.$queryRawUnsafe<Array<{ rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolreplication: boolean; member: boolean; owned: bigint }>>(
    `SELECT r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolreplication,
            pg_has_role(current_user, '${LEDGER_AUDIT_GROUP_ROLE}', 'MEMBER') AS member,
            (SELECT count(*) FROM pg_tables WHERE tableowner = current_user) AS owned
       FROM pg_roles r WHERE r.rolname = current_user`)
  if (!attrs) return { ok: false, failures: ['role not found'] }
  if (attrs.rolsuper) failures.push('role is SUPERUSER')
  if (attrs.rolbypassrls) failures.push('role has BYPASSRLS')
  if (attrs.rolcreaterole) failures.push('role has CREATEROLE')
  if (attrs.rolcreatedb) failures.push('role has CREATEDB')
  if (attrs.rolreplication) failures.push('role has REPLICATION')
  if (!attrs.member) failures.push(`role is not a member of ${LEDGER_AUDIT_GROUP_ROLE}`)
  if (Number(attrs.owned) > 0) failures.push('role owns tables')
  const [forbidden] = await db.$queryRawUnsafe<Array<{ n: bigint }>>(
    `SELECT count(*) AS n FROM unnest(ARRAY[${LEDGER_AUDIT_FORBIDDEN_TABLES.map(t => `'${t}'`).join(',')}]) t WHERE has_table_privilege(current_user, format('%I', t), 'SELECT')`)
  if (Number(forbidden?.n ?? 0) > 0) failures.push('role can read tables outside the ledger-audit scope')
  // Money tables are read-only for this role: any write privilege at all is a failure.
  const [writes] = await db.$queryRawUnsafe<Array<{ n: bigint }>>(
    `SELECT count(*) AS n FROM unnest(ARRAY['Wallet','LedgerEntry','tenants','AgencyCreditLimit']) t
      WHERE has_table_privilege(current_user, format('%I', t), 'INSERT,UPDATE,DELETE,TRUNCATE')`)
  if (Number(writes?.n ?? 0) > 0) failures.push('role can write a money or tenant table')
  const [results] = await db.$queryRawUnsafe<Array<{ upd: boolean; del: boolean; ins: boolean }>>(
    `SELECT has_table_privilege(current_user, '"LedgerIntegrityRun"', 'UPDATE') OR has_table_privilege(current_user, '"LedgerIntegrityRun"', 'TRUNCATE') AS upd,
            has_table_privilege(current_user, '"LedgerIntegrityRun"', 'DELETE') AS del,
            has_table_privilege(current_user, '"LedgerIntegrityRun"', 'INSERT') AS ins`)
  if (results?.upd) failures.push('role can update or truncate stored runs')
  if (results?.del) failures.push('role can delete stored runs')
  if (!results?.ins) failures.push('role cannot append stored runs')
  const [audit] = await db.$queryRawUnsafe<Array<{ upd: boolean; del: boolean }>>(
    `SELECT has_table_privilege(current_user, '"AuditEvent"', 'UPDATE') OR has_table_privilege(current_user, '"AuditEvent"', 'TRUNCATE') AS upd, has_table_privilege(current_user, '"AuditEvent"', 'DELETE') AS del`)
  if (audit?.upd || audit?.del) failures.push('role can alter or delete audit events')
  return { ok: failures.length === 0, failures }
}
