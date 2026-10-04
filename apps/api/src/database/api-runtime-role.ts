import { describePasswordProblems } from './hold-expiry-role'

export const API_RUNTIME_GROUP_ROLE = 'fbeds_api'
export const API_RUNTIME_LOGIN_ROLE = 'fbeds_api_login'

type Executor = { $executeRawUnsafe(query: string): Promise<number>; $queryRawUnsafe<T = unknown>(query: string): Promise<T> }

const IDENTIFIER = /^[a-z][a-z0-9_]{2,62}$/
const RESERVED = new Set(['postgres', API_RUNTIME_GROUP_ROLE, 'fbeds_hold_expiry', 'fbeds_hold_expiry_login', 'fbeds_rls_test'])

const SELECT_TABLES = [
  'tenants', 'memberships', 'Permission', 'Role', 'UserRole', 'RolePermission',
  'Hotel', 'HotelSearchIndex', 'RoomType', 'BoardBasis', 'Supplier', 'SupplierHotelMapping', 'SupplierRoomMapping',
  'supplier_memberships',
  'Contract', 'RatePlan', 'DailyRate', 'DailyAvailability', 'InventoryPool', 'InventoryPoolDay',
] as const

/**
 * Statements the owner runs to grant the API group role. Search and recheck are
 * SELECT. Sessions, audit events, and supplier room-note drafts are the writes.
 * Wallet, booking, ledger, hotel, and credential tables stay read-only or absent.
 */
export function apiRuntimeGrantStatements(groupRole = API_RUNTIME_GROUP_ROLE): string[] {
  const group = `"${groupRole}"`
  return [
    `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${group}`,
    `GRANT USAGE ON SCHEMA public TO ${group}`,
    `GRANT SELECT ON "users" TO ${group}`,
    `GRANT UPDATE ("last_login_at", "updated_at") ON "users" TO ${group}`,
    `GRANT SELECT, INSERT ON "sessions" TO ${group}`,
    `GRANT UPDATE ("last_seen_at", "revoked_at") ON "sessions" TO ${group}`,
    `GRANT SELECT, INSERT ON "AuditEvent" TO ${group}`,
    `GRANT SELECT, INSERT, UPDATE ON "supplier_room_drafts" TO ${group}`,
    ...SELECT_TABLES.map((table) => `GRANT SELECT ON "${table}" TO ${group}`),
  ]
}

export function assertApiRuntimeInput(loginRole: string, password: string): void {
  if (!IDENTIFIER.test(loginRole) || RESERVED.has(loginRole)) throw new Error('Login role must be a dedicated API runtime role')
  const problems = describePasswordProblems(password)
  if (problems.length) throw new Error('Password must be 32-128 URL-safe characters [A-Za-z0-9_-]')
}

/**
 * Idempotently creates the least-privilege API group role and one LOGIN member.
 * Must run as the database owner. It never creates SUPERUSER, BYPASSRLS,
 * CREATEROLE, CREATEDB, or REPLICATION. Never log the password.
 */
export async function provisionApiRuntimeRole(db: Executor, input: { loginRole?: string; password: string }): Promise<void> {
  const loginRole = input.loginRole ?? API_RUNTIME_LOGIN_ROLE
  assertApiRuntimeInput(loginRole, input.password)
  const login = `"${loginRole}"`
  const group = `"${API_RUNTIME_GROUP_ROLE}"`
  const attributes = 'NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'
  await db.$executeRawUnsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${API_RUNTIME_GROUP_ROLE}') THEN CREATE ROLE ${group} NOLOGIN ${attributes}; END IF; END $$`)
  await db.$executeRawUnsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${loginRole}') THEN CREATE ROLE ${login} LOGIN PASSWORD '${input.password}' ${attributes} INHERIT CONNECTION LIMIT 20; ELSE ALTER ROLE ${login} LOGIN PASSWORD '${input.password}' ${attributes} INHERIT CONNECTION LIMIT 20; END IF; END $$`)
  await db.$executeRawUnsafe(`GRANT ${group} TO ${login}`)
  for (const statement of apiRuntimeGrantStatements()) await db.$executeRawUnsafe(statement)
}

export interface ApiRuntimeRoleReport { ok: boolean; failures: string[] }

/** Run while connected AS the API login role. Read-only catalog checks; no secrets returned. */
export async function verifyApiRuntimeRole(db: Pick<Executor, '$queryRawUnsafe'>): Promise<ApiRuntimeRoleReport> {
  const failures: string[] = []
  const [attrs] = await db.$queryRawUnsafe<Array<{ rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolreplication: boolean; rolcanlogin: boolean; member: boolean; owned: bigint }>>(
    `SELECT r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolreplication, r.rolcanlogin,
            pg_has_role(current_user, '${API_RUNTIME_GROUP_ROLE}', 'MEMBER') AS member,
            (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relkind = 'r' AND pg_get_userbyid(c.relowner) = current_user) AS owned
       FROM pg_roles r WHERE r.rolname = current_user`)
  if (!attrs) return { ok: false, failures: ['role not found'] }
  if (attrs.rolsuper) failures.push('role is SUPERUSER')
  if (attrs.rolbypassrls) failures.push('role has BYPASSRLS')
  if (attrs.rolcreaterole) failures.push('role has CREATEROLE')
  if (attrs.rolcreatedb) failures.push('role has CREATEDB')
  if (attrs.rolreplication) failures.push('role has REPLICATION')
  if (!attrs.rolcanlogin) failures.push('role cannot login')
  if (!attrs.member) failures.push(`role is not a member of ${API_RUNTIME_GROUP_ROLE}`)
  if (Number(attrs.owned) > 0) failures.push('role owns tables')
  const [forbidden] = await db.$queryRawUnsafe<Array<{ n: bigint }>>(
    `SELECT count(*) AS n FROM unnest(ARRAY['Wallet','LedgerEntry','Booking','ConnectorCredentialReference']) t
      WHERE has_table_privilege(current_user, format('%I', t), 'SELECT')`)
  if (Number(forbidden?.n ?? 0) > 0) failures.push('role can read finance or credential tables')
  const [hotelUpdate] = await db.$queryRawUnsafe<Array<{ allowed: boolean }>>(
    `SELECT has_table_privilege(current_user, '"Hotel"', 'UPDATE') AS allowed`)
  if (hotelUpdate?.allowed) failures.push('role can update Hotel')
  return { ok: failures.length === 0, failures }
}
