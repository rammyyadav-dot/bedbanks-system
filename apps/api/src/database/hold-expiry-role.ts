export const HOLD_EXPIRY_GROUP_ROLE = 'fbeds_hold_expiry'

type Executor = { $executeRawUnsafe(query: string): Promise<number>; $queryRawUnsafe<T = unknown>(query: string): Promise<T> }

const IDENTIFIER = /^[a-z][a-z0-9_]{2,62}$/
// URL-safe so the credential can be embedded in a connection string unchanged.
const PASSWORD = /^[A-Za-z0-9_-]{32,128}$/

/**
 * Explains why a password is rejected without revealing any of it: only its length and how many
 * characters fall outside the allowed set are reported.
 */
export function describePasswordProblems(password: string): string[] {
  const problems: string[] = []
  if (password.length < 32) problems.push(`it is ${password.length} characters long; at least 32 are needed`)
  if (password.length > 128) problems.push(`it is ${password.length} characters long; at most 128 are allowed`)
  const invalid = [...password].filter(character => !/[A-Za-z0-9_-]/.test(character)).length
  if (invalid > 0) problems.push(`${invalid} character${invalid === 1 ? ' is' : 's are'} not a letter, digit, hyphen or underscore (spaces, symbols, quotes and line breaks are not allowed)`)
  return problems
}

export function assertProvisioningInput(loginRole: string, password: string): void {
  if (!IDENTIFIER.test(loginRole)) throw new Error('Login role must match [a-z][a-z0-9_]{2,62}')
  if (loginRole === HOLD_EXPIRY_GROUP_ROLE || loginRole === 'postgres') throw new Error('Login role must be dedicated to the sweeper')
  if (!PASSWORD.test(password)) throw new Error('Password must be 32-128 URL-safe characters [A-Za-z0-9_-]')
}

/**
 * SQL that creates a restricted login role, or updates an existing one. A superuser owner re-asserts every restricting attribute.
 * A non-superuser owner (PostgreSQL 16 CREATEROLE, as on managed services) is not allowed to name SUPERUSER, REPLICATION or
 * BYPASSRLS in ALTER ROLE, so it only changes login, password, inheritance and the connection limit, and fails closed if the
 * existing role already carries an elevated attribute that a superuser must reset.
 */
export function upsertLoginRoleSql(loginRole: string, password: string, attributes: string, connectionLimit: number): string {
  const who = `'${loginRole}'`
  return `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${who}) THEN
      CREATE ROLE "${loginRole}" LOGIN PASSWORD '${password}' ${attributes} INHERIT CONNECTION LIMIT ${connectionLimit};
    ELSIF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
      ALTER ROLE "${loginRole}" LOGIN PASSWORD '${password}' ${attributes} INHERIT CONNECTION LIMIT ${connectionLimit};
    ELSE
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${who} AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication)) THEN
        RAISE EXCEPTION 'existing login role has an elevated attribute; a superuser must reset it before it can be provisioned';
      END IF;
      ALTER ROLE "${loginRole}" LOGIN PASSWORD '${password}' INHERIT CONNECTION LIMIT ${connectionLimit};
    END IF;
  END $$`
}

/**
 * Idempotently creates the least-privilege group role and one LOGIN member.
 * Must run as the database owner (or another role allowed to CREATE ROLE and
 * GRANT). It never creates SUPERUSER, BYPASSRLS, CREATEROLE, CREATEDB or
 * REPLICATION roles. Never log the password.
 */
export async function provisionHoldExpiryRole(db: Executor, input: { loginRole: string; password: string }): Promise<void> {
  assertProvisioningInput(input.loginRole, input.password)
  const login = `"${input.loginRole}"`
  const group = `"${HOLD_EXPIRY_GROUP_ROLE}"`
  const attributes = 'NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'
  await db.$executeRawUnsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${HOLD_EXPIRY_GROUP_ROLE}') THEN CREATE ROLE ${group} NOLOGIN ${attributes}; END IF; END $$`)
  await db.$executeRawUnsafe(upsertLoginRoleSql(input.loginRole, input.password, attributes, 5))
  await db.$executeRawUnsafe(`GRANT ${group} TO ${login}`)
  await db.$executeRawUnsafe(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${group}`)
  const grants = [
    `GRANT USAGE ON SCHEMA public TO ${group}`,
    `GRANT SELECT ("id", "status") ON "tenants" TO ${group}`,
    `GRANT SELECT ON "InventoryHold" TO ${group}`,
    `GRANT UPDATE ("status", "released_at", "updated_at") ON "InventoryHold" TO ${group}`,
    `GRANT SELECT ON "InventoryHoldNight" TO ${group}`,
    `GRANT SELECT ON "DailyAvailability" TO ${group}`,
    `GRANT UPDATE ("held", "updated_at") ON "DailyAvailability" TO ${group}`,
    `GRANT SELECT ON "InventoryPoolDay" TO ${group}`,
    `GRANT UPDATE ("held", "updated_at") ON "InventoryPoolDay" TO ${group}`,
    `GRANT SELECT, INSERT ON "AuditEvent" TO ${group}`,
  ]
  for (const statement of grants) await db.$executeRawUnsafe(statement)
}

/** Removes the login role and, optionally, the group role. Used for rotation, rollback and tests. */
export async function deprovisionHoldExpiryRole(db: Executor, loginRole: string, options: { dropGroup?: boolean } = {}): Promise<void> {
  if (!IDENTIFIER.test(loginRole) || loginRole === HOLD_EXPIRY_GROUP_ROLE || loginRole === 'postgres') throw new Error('Invalid login role')
  await db.$executeRawUnsafe(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${loginRole}') THEN DROP OWNED BY "${loginRole}"; DROP ROLE "${loginRole}"; END IF; END $$`)
  if (options.dropGroup) {
    await db.$executeRawUnsafe(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${HOLD_EXPIRY_GROUP_ROLE}') THEN DROP OWNED BY "${HOLD_EXPIRY_GROUP_ROLE}"; DROP ROLE "${HOLD_EXPIRY_GROUP_ROLE}"; END IF; END $$`)
  }
}

export interface HoldExpiryRoleReport { ok: boolean; failures: string[] }

/** Run while connected AS the restricted login role. Read-only catalog checks; no secrets returned. */
export async function verifyHoldExpiryRole(db: Pick<Executor, '$queryRawUnsafe'>): Promise<HoldExpiryRoleReport> {
  const failures: string[] = []
  const [attrs] = await db.$queryRawUnsafe<Array<{ rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolreplication: boolean; member: boolean; owned: bigint }>>(
    `SELECT r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolreplication,
            pg_has_role(current_user, '${HOLD_EXPIRY_GROUP_ROLE}', 'MEMBER') AS member,
            (SELECT count(*) FROM pg_tables WHERE tableowner = current_user) AS owned
       FROM pg_roles r WHERE r.rolname = current_user`)
  if (!attrs) return { ok: false, failures: ['role not found'] }
  if (attrs.rolsuper) failures.push('role is SUPERUSER')
  if (attrs.rolbypassrls) failures.push('role has BYPASSRLS')
  if (attrs.rolcreaterole) failures.push('role has CREATEROLE')
  if (attrs.rolcreatedb) failures.push('role has CREATEDB')
  if (attrs.rolreplication) failures.push('role has REPLICATION')
  if (!attrs.member) failures.push(`role is not a member of ${HOLD_EXPIRY_GROUP_ROLE}`)
  if (Number(attrs.owned) > 0) failures.push('role owns tables')
  const [forbidden] = await db.$queryRawUnsafe<Array<{ n: bigint }>>(
    `SELECT count(*) AS n FROM unnest(ARRAY['users','sessions','memberships','LedgerEntry','Wallet','Booking','Contract','DailyRate']) t
      WHERE has_table_privilege(current_user, format('%I', t), 'SELECT')`)
  if (Number(forbidden?.n ?? 0) > 0) failures.push('role can read tables outside the hold-expiry scope')
  return { ok: failures.length === 0, failures }
}
