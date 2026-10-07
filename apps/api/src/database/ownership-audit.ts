// P0-01 (ADR 0040): the owner-side, machine-readable audit of who owns every application table, whether row-level security is enabled AND forced, and exactly
// which privileges the runtime group holds. Read-only catalog queries; run as the migration owner (ops:strict-role-rollout audit) or in certification.
import { API_RUNTIME_GROUP_ROLE } from './api-runtime-role'
import { RUNTIME_ROLE_GRANTS } from './runtime-role-contract'

type Reader = { $queryRawUnsafe<T = unknown>(query: string): Promise<T> }

/**
 * Tables without forced row-level security, each with the reason. Anything else without FORCE is a certification failure. Platform and migration tables are not tenant data
 * and the runtime group holds NO privilege on them (asserted below); the four others are the identity/catalog tables the contract already declares `rls: 'none'`.
 */
export const RLS_EXEMPT_TABLES: Readonly<Record<string, { reason: string; runtimePrivileges: 'none' | 'per-contract' }>> = {
  tenants: { reason: 'the tenant root: its own id is the tenant, there is no tenant_id column; the runtime resolves a tenant by id and never writes it', runtimePrivileges: 'per-contract' },
  Permission: { reason: 'global catalogue of permission keys, not tenant data; read-only for the runtime', runtimePrivileges: 'per-contract' },
  users: { reason: 'global identity; a person belongs to tenants through memberships. Looked up before a tenant is known (login); writes limited by column in the contract', runtimePrivileges: 'per-contract' },
  sessions: { reason: 'authentication sessions are found by token hash before any tenant context exists; writes limited by column in the contract', runtimePrivileges: 'per-contract' },
  PlatformPermission: { reason: 'platform-operator catalogue, not tenant data; no runtime privilege', runtimePrivileges: 'none' },
  PlatformRole: { reason: 'platform-operator roles, not tenant data; no runtime privilege', runtimePrivileges: 'none' },
  PlatformRoleAssignment: { reason: 'platform-operator assignments, not tenant data; no runtime privilege', runtimePrivileges: 'none' },
  PlatformRolePermission: { reason: 'platform-operator grants, not tenant data; no runtime privilege', runtimePrivileges: 'none' },
  _prisma_migrations: { reason: 'migration bookkeeping owned by the migration tool; no runtime privilege', runtimePrivileges: 'none' },
}

export interface OwnershipRow {
  schema: string; table: string; owner: string; rlsEnabled: boolean; rlsForced: boolean
  runtimeGrants: string[] // table-level privileges held by the runtime group, e.g. ['SELECT','INSERT']
  exempt: string | null // the documented reason when RLS is not forced
}
export interface OwnershipAudit {
  rows: OwnershipRow[]
  tables: number; forcedTables: number; exemptTables: number
  owners: string[]
  runtimeSchemaCreate: boolean; runtimeDatabaseCreate: boolean
  failures: string[]
}

const TABLE_PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] as const

/** `runtimeLogins` are the login roles that must never own anything; `group` is the runtime group whose grants are listed. */
export async function runtimeOwnershipAudit(db: Reader, opts: { group?: string; runtimeLogins?: readonly string[]; migrationOwner?: string } = {}): Promise<OwnershipAudit> {
  const group = (opts.group ?? API_RUNTIME_GROUP_ROLE).replace(/'/g, "''")
  const privSelect = TABLE_PRIVS.map((p) => `CASE WHEN has_table_privilege('${group}', c.oid, '${p}') THEN '${p}' END`).join(', ')
  const raw = await db.$queryRawUnsafe<Array<{ schema: string; tbl: string; owner: string; rls: boolean; forced: boolean; privs: Array<string | null> }>>(
    `SELECT n.nspname AS schema, c.relname AS tbl, pg_get_userbyid(c.relowner) AS owner, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced, ARRAY[${privSelect}] AS privs
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p') ORDER BY c.relname`)
  const [caps] = await db.$queryRawUnsafe<Array<{ schema_create: boolean; db_create: boolean }>>(
    `SELECT has_schema_privilege('${group}', 'public', 'CREATE') AS schema_create, has_database_privilege('${group}', current_database(), 'CREATE') AS db_create`)
  const rows: OwnershipRow[] = raw.map((r) => ({ schema: r.schema, table: r.tbl, owner: r.owner, rlsEnabled: r.rls, rlsForced: r.forced, runtimeGrants: (r.privs ?? []).filter((p): p is string => Boolean(p)), exempt: !r.forced ? RLS_EXEMPT_TABLES[r.tbl]?.reason ?? null : null }))
  const failures: string[] = []
  const logins = new Set([...(opts.runtimeLogins ?? []), group])
  const contractTables = new Set(RUNTIME_ROLE_GRANTS.map((g) => g.table))
  for (const row of rows) {
    if (logins.has(row.owner) || /^fbeds_(api|booking|hold)/.test(row.owner)) failures.push(`${row.table} is owned by runtime role ${row.owner}`)
    if (opts.migrationOwner && row.owner !== opts.migrationOwner) failures.push(`${row.table} is owned by ${row.owner}, not the migration owner`)
    const exemption = RLS_EXEMPT_TABLES[row.table]
    if (!row.rlsForced) {
      if (!exemption) failures.push(`${row.table} has no FORCE ROW LEVEL SECURITY and no documented exemption`)
      else if (exemption.runtimePrivileges === 'none' && row.runtimeGrants.length) failures.push(`${row.table} is exempt from RLS as a non-tenant table but the runtime group holds ${row.runtimeGrants.join(', ')}`)
      else if (exemption.runtimePrivileges === 'per-contract' && !contractTables.has(row.table)) failures.push(`${row.table} is exempt from RLS but is not in the runtime grant contract`)
    } else if (!row.rlsEnabled) failures.push(`${row.table} has FORCE without ENABLE ROW LEVEL SECURITY`)
    if (exemption && row.rlsForced) failures.push(`${row.table} is listed as RLS-exempt but has forced RLS: update the exemption list`)
    if (row.runtimeGrants.some((p) => p === 'TRUNCATE' || p === 'REFERENCES' || p === 'TRIGGER')) failures.push(`${row.table}: the runtime group holds ${row.runtimeGrants.filter((p) => ['TRUNCATE', 'REFERENCES', 'TRIGGER'].includes(p)).join(', ')}`)
  }
  if (caps?.schema_create) failures.push('the runtime group can CREATE in schema public')
  if (caps?.db_create) failures.push('the runtime group can CREATE schemas in the database')
  const forcedTables = rows.filter((r) => r.rlsForced).length
  return { rows, tables: rows.length, forcedTables, exemptTables: rows.filter((r) => !r.rlsForced && r.exempt).length, owners: [...new Set(rows.map((r) => r.owner))].sort(), runtimeSchemaCreate: Boolean(caps?.schema_create), runtimeDatabaseCreate: Boolean(caps?.db_create), failures }
}
