import { describePasswordProblems, upsertLoginRoleSql } from './hold-expiry-role'

/**
 * The dedicated limited database role of the Admin booking module (ADR 0039, owner answer 1).
 *
 * Why a separate principal: the strict API runtime role (`fbeds_api`) is deliberately denied the booking tables, because every HTTP request runs
 * as it and booking rows hold guest personal data. The booking module therefore reads through its own connection (`BOOKING_OPS_DATABASE_URL`)
 * as `fbeds_booking_ops`, a member of the NOLOGIN group `fbeds_booking`. Nothing else in the API uses it, and the API role gets no booking grant.
 *
 * Phase 1 is read-only and names exactly the tables the list and detail screens need. Row-level security stays forced and this role cannot
 * bypass it: every read still runs inside a transaction that sets the tenant. Write grants are added per phase, as narrow column grants for the
 * transition function only, in their own change to this file.
 * No grant on LedgerEntry, Wallet, BookingDocument or any hotel, agency, user or session table until a later phase needs it.
 */
export const BOOKING_OPS_GROUP_ROLE = 'fbeds_booking'
export const BOOKING_OPS_LOGIN_ROLE = 'fbeds_booking_ops'

type Executor = { $executeRawUnsafe(query: string): Promise<number>; $queryRawUnsafe<T = unknown>(query: string): Promise<T> }

const IDENTIFIER = /^[a-z][a-z0-9_]{2,62}$/
const PASSWORD = /^[A-Za-z0-9_-]{32,128}$/

/** Phase 1: SELECT only. `SupplierMutation` carries fingerprints, references and failure codes, never request or response payloads. */
export const BOOKING_OPS_READ_TABLES = ['Booking', 'BookingRoom', 'BookingGuest', 'BookingEvent', 'SupplierMutation'] as const
/** Tables the role must never be able to read or write. Checked by the verifier. */
export const BOOKING_OPS_FORBIDDEN_TABLES = ['LedgerEntry', 'Wallet', 'BookingDocument', 'Cancellation', 'InventoryHold', 'AuditEvent', 'users', 'sessions', 'memberships', 'Agency', 'AgencyMember', 'Hotel', 'Contract', 'DailyRate', 'ConnectorCredentialReference'] as const

export function assertBookingOpsInput(loginRole: string, password: string): void {
  if (!IDENTIFIER.test(loginRole)) throw new Error('Login role must match [a-z][a-z0-9_]{2,62}')
  if (loginRole === BOOKING_OPS_GROUP_ROLE || loginRole === 'postgres') throw new Error('Login role must be dedicated to the booking module')
  if (!PASSWORD.test(password)) throw new Error('Password must be 32-128 URL-safe characters [A-Za-z0-9_-]')
}

/** Phase 1 grant statements, in order. The one place the booking role's privileges are stated. */
export function bookingOpsGrantStatements(group = BOOKING_OPS_GROUP_ROLE): string[] {
  return [
    `GRANT USAGE ON SCHEMA public TO "${group}"`,
    ...BOOKING_OPS_READ_TABLES.map((table) => `GRANT SELECT ON "${table}" TO "${group}"`),
  ]
}

/**
 * Idempotently creates the group role and one LOGIN member, then (re)asserts exactly the Phase 1 grants.
 * Owner-only: it must run as the database owner or another role allowed to CREATE ROLE and GRANT. It never creates SUPERUSER, BYPASSRLS,
 * CREATEROLE, CREATEDB or REPLICATION roles, and it revokes everything first so a stale or broader grant cannot survive. Never log the password.
 */
export async function provisionBookingOpsRole(db: Executor, input: { loginRole?: string; password: string }): Promise<void> {
  const loginRole = input.loginRole ?? BOOKING_OPS_LOGIN_ROLE
  assertBookingOpsInput(loginRole, input.password)
  const attributes = 'NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'
  await db.$executeRawUnsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${BOOKING_OPS_GROUP_ROLE}') THEN CREATE ROLE "${BOOKING_OPS_GROUP_ROLE}" NOLOGIN ${attributes}; END IF; END $$`)
  await db.$executeRawUnsafe(upsertLoginRoleSql(loginRole, input.password, attributes, 10))
  await db.$executeRawUnsafe(`GRANT "${BOOKING_OPS_GROUP_ROLE}" TO "${loginRole}"`)
  await db.$executeRawUnsafe(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM "${BOOKING_OPS_GROUP_ROLE}"`)
  for (const statement of bookingOpsGrantStatements()) await db.$executeRawUnsafe(statement)
}

/** Removes the login role and, optionally, the group role. Used for rotation, rollback and tests. */
export async function deprovisionBookingOpsRole(db: Executor, loginRole = BOOKING_OPS_LOGIN_ROLE, options: { dropGroup?: boolean } = {}): Promise<void> {
  if (!IDENTIFIER.test(loginRole) || loginRole === BOOKING_OPS_GROUP_ROLE || loginRole === 'postgres') throw new Error('Invalid login role')
  const drop = (role: string) => `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
    IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN EXECUTE 'GRANT "${role}" TO CURRENT_USER WITH INHERIT TRUE, SET TRUE'; END IF;
    DROP OWNED BY "${role}"; DROP ROLE "${role}"; END IF; END $$`
  await db.$executeRawUnsafe(drop(loginRole))
  if (options.dropGroup) await db.$executeRawUnsafe(drop(BOOKING_OPS_GROUP_ROLE))
}

export interface BookingOpsRoleReport { ok: boolean; failures: string[] }

/** Run while connected AS the login role. Read-only catalogue checks; returns no secret. */
export async function verifyBookingOpsRole(db: Pick<Executor, '$queryRawUnsafe'>): Promise<BookingOpsRoleReport> {
  const failures: string[] = []
  const [attrs] = await db.$queryRawUnsafe<Array<{ rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolreplication: boolean; member: boolean; owned: bigint }>>(
    `SELECT r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolreplication,
            pg_has_role(current_user, '${BOOKING_OPS_GROUP_ROLE}', 'MEMBER') AS member,
            (SELECT count(*) FROM pg_tables WHERE tableowner = current_user) AS owned
       FROM pg_roles r WHERE r.rolname = current_user`)
  if (!attrs) return { ok: false, failures: ['role not found'] }
  if (attrs.rolsuper) failures.push('role is SUPERUSER')
  if (attrs.rolbypassrls) failures.push('role has BYPASSRLS')
  if (attrs.rolcreaterole) failures.push('role has CREATEROLE')
  if (attrs.rolcreatedb) failures.push('role has CREATEDB')
  if (attrs.rolreplication) failures.push('role has REPLICATION')
  if (!attrs.member) failures.push(`role is not a member of ${BOOKING_OPS_GROUP_ROLE}`)
  if (Number(attrs.owned) > 0) failures.push('role owns tables')
  const readList = BOOKING_OPS_READ_TABLES.map((t) => `'${t}'`).join(',')
  const [missing] = await db.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM unnest(ARRAY[${readList}]) t WHERE NOT has_table_privilege(current_user, format('%I', t), 'SELECT')`)
  if (Number(missing?.n ?? 0) > 0) failures.push('role cannot read every booking table it needs')
  const [writes] = await db.$queryRawUnsafe<Array<{ n: bigint }>>(
    `SELECT count(*) AS n FROM unnest(ARRAY[${readList}]) t WHERE has_table_privilege(current_user, format('%I', t), 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')`)
  if (Number(writes?.n ?? 0) > 0) failures.push('role holds a write privilege that Phase 1 does not grant')
  const forbiddenList = BOOKING_OPS_FORBIDDEN_TABLES.map((t) => `'${t}'`).join(',')
  const [forbidden] = await db.$queryRawUnsafe<Array<{ n: bigint }>>(
    `SELECT count(*) AS n FROM unnest(ARRAY[${forbiddenList}]) t WHERE has_table_privilege(current_user, format('%I', t), 'SELECT,INSERT,UPDATE,DELETE')`)
  if (Number(forbidden?.n ?? 0) > 0) failures.push('role can reach a table outside the booking module scope')
  return { ok: failures.length === 0, failures }
}

export { describePasswordProblems }
