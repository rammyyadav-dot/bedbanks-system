/**
 * Catalog-wide tenant and database security certification (docs/tenant-database-security-certification.md).
 *
 * Read-only. Runs on any connection, including a restricted login: every query reads the system catalogs only.
 * It complements the per-role verifiers (verifyApiRuntimeRole and friends), which compare one role with its own
 * contract. This one proves properties of the whole database that no single contract states:
 *
 *   - every table carrying tenant_id has enabled AND forced row-level security and at least one policy;
 *   - every table without tenant_id is explicitly classified below (a new unclassified table fails);
 *   - every policy is scoped by a tenant, user, platform or compliance predicate (no USING (true) on tenant data);
 *   - no restricted role (fbeds_*) is privileged, owns anything, or inherits a predefined bypass role;
 *   - no restricted role holds TRUNCATE (bypasses RLS), REFERENCES or TRIGGER, or rewrites an append-only table;
 *   - credential hashes are readable only by the API runtime role that authenticates;
 *   - PUBLIC holds no table privilege and cannot create in the schema; SECURITY DEFINER functions pin search_path.
 */
type Catalog = { $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T> }

/** Tables without a tenant_id column, with why that is safe. A table missing here fails certification. */
export const NON_TENANT_TABLES: Readonly<Record<string, { rls: 'forced' | 'none'; reason: string }>> = {
  _prisma_migrations: { rls: 'none', reason: 'migration history; no restricted role has a grant' },
  users: { rls: 'none', reason: 'authentication directory; read by the session guard before a tenant exists' },
  sessions: { rls: 'none', reason: 'opaque session store (ADR 0001); token is stored as a SHA-256 hash only' },
  tenants: { rls: 'none', reason: 'tenant directory; the tenant-control provisioning adds forced RLS with its own policies' },
  Permission: { rls: 'none', reason: 'global permission catalogue; no tenant data' },
  PlatformPermission: { rls: 'none', reason: 'platform permission catalogue; no tenant data' },
  PlatformRole: { rls: 'none', reason: 'platform administration; no runtime grant' },
  PlatformRoleAssignment: { rls: 'none', reason: 'platform administration; no runtime grant' },
  PlatformRolePermission: { rls: 'none', reason: 'platform administration; no runtime grant' },
  BookingLeadTimeRule: { rls: 'forced', reason: 'child of Contract; policy joins to the parent tenant' },
  Cancellation: { rls: 'forced', reason: 'child of Booking; policy joins to the parent tenant' },
  CancellationPolicy: { rls: 'forced', reason: 'child of Contract; policy joins to the parent tenant' },
  ChildPolicy: { rls: 'forced', reason: 'child of Contract; policy joins to the parent tenant' },
  ContractSupplement: { rls: 'forced', reason: 'child of Contract; policy joins to the parent tenant' },
  ConnectorCredentialReference: { rls: 'forced', reason: 'child of ConnectorDefinition; secret references only, never values' },
  RolePermission: { rls: 'forced', reason: 'child of Role; policy joins to the parent tenant' },
  RoomType: { rls: 'forced', reason: 'child of Hotel; policy joins to the parent tenant' },
}

/** Rows that record what happened. No restricted role may UPDATE, DELETE or TRUNCATE them. */
export const APPEND_ONLY_TABLES = [
  'AuditEvent', 'ComplianceRecord', 'ComplianceExportBatchRecord', 'LedgerEntry',
  'BookingEvent', 'BookingFinanceEvent', 'BookingSupplierCall', 'BookingDocument', 'ServiceCaseNote',
] as const

/** Credential hashes: readable only by the API runtime (it authenticates every request). */
export const CREDENTIAL_COLUMNS = [
  { table: 'users', column: 'password_hash' },
  { table: 'sessions', column: 'token_hash' },
  /** ADR 0075 amendment 3: compared only inside the SECURITY DEFINER authentication functions; no restricted role reads them, not even the API runtime. */
  { table: 'distribution_credentials', column: 'secret_hash' },
  { table: 'distribution_access_tokens', column: 'token_hash' },
] as const
export const CREDENTIAL_READERS = ['fbeds_api', 'fbeds_api_login'] as const

/** Predicates that make a policy tenant-, user-, platform- or compliance-scoped. */
const SCOPING_FUNCTIONS = /fbeds_(current_tenant_id|current_user_id|platform_access_allowed|auth_audit_allowed|compliance_scope_visible|compliance_capture_active)\(/

/** Predefined roles that read or write past RLS-relevant privileges. */
const BYPASS_PREDEFINED_ROLES = ['pg_read_all_data', 'pg_write_all_data', 'pg_execute_server_program', 'pg_read_server_files', 'pg_write_server_files', 'pg_database_owner']

export interface DatabaseSecurityReport {
  ok: boolean
  failures: string[]
  summary: { tenantTables: number; classifiedNonTenantTables: number; policies: number; restrictedRoles: string[]; appendOnlyTables: number }
}

/**
 * `testFixtureRoles` names roles that disposable-database suites create on purpose (for example `fbeds_rls_test`, a NOLOGIN probe
 * given broad DML so RLS itself can be exercised). Only the e2e certification passes it; on any real database such a role is a failure.
 */
export async function certifyDatabaseSecurity(db: Catalog, options: { testFixtureRoles?: readonly string[] } = {}): Promise<DatabaseSecurityReport> {
  const failures: string[] = []
  const fixtures = [...(options.testFixtureRoles ?? [])]

  const tables = await db.$queryRawUnsafe<Array<{ name: string; enabled: boolean; forced: boolean; tenant: boolean; policies: number }>>(
    `SELECT c.relname AS name, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
            EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped) AS tenant,
            (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY c.relname`)
  let tenantTables = 0
  for (const t of tables) {
    if (t.tenant) {
      tenantTables++
      if (!t.enabled || !t.forced) failures.push(`${t.name}: tenant table without enabled and forced RLS`)
      if (t.policies === 0) failures.push(`${t.name}: tenant table with RLS but no policy`)
      continue
    }
    const classified = NON_TENANT_TABLES[t.name]
    if (!classified) { failures.push(`${t.name}: table without tenant_id is not classified in NON_TENANT_TABLES`); continue }
    // tenants may gain forced RLS from the tenant-control provisioning; 'none' is a floor for it, not a ceiling.
    if (classified.rls === 'forced' && (!t.enabled || !t.forced || t.policies === 0)) failures.push(`${t.name}: classified as forced RLS but is not`)
  }

  const policies = await db.$queryRawUnsafe<Array<{ table: string; name: string; expr: string }>>(
    `SELECT c.relname AS table, p.polname AS name,
            coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') AS expr
       FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname <> 'tenants'`)
  for (const p of policies) if (!SCOPING_FUNCTIONS.test(p.expr)) failures.push(`${p.table}.${p.name}: policy has no tenant, user, platform or compliance predicate`)

  const roles = await db.$queryRawUnsafe<Array<{ name: string; superuser: boolean; bypassrls: boolean; createrole: boolean; createdb: boolean; replication: boolean; owned: number; functions: number; bypass: string[] }>>(
    `SELECT r.rolname AS name, r.rolsuper AS superuser, r.rolbypassrls AS bypassrls, r.rolcreaterole AS createrole,
            r.rolcreatedb AS createdb, r.rolreplication AS replication,
            (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relowner = r.oid) AS owned,
            (SELECT count(*)::int FROM pg_proc f JOIN pg_namespace n ON n.oid = f.pronamespace WHERE n.nspname = 'public' AND f.proowner = r.oid) AS functions,
            ARRAY(SELECT b.rolname::text FROM pg_roles b WHERE b.rolname = ANY($1::text[]) AND pg_has_role(r.oid, b.oid, 'MEMBER')) AS bypass
       FROM pg_roles r WHERE r.rolname LIKE 'fbeds\\_%' AND r.rolname <> ALL($2::text[]) ORDER BY r.rolname`, BYPASS_PREDEFINED_ROLES, fixtures)
  for (const r of roles) {
    for (const flag of ['superuser', 'bypassrls', 'createrole', 'createdb', 'replication'] as const) if (r[flag]) failures.push(`${r.name}: restricted role has ${flag.toUpperCase()}`)
    if (r.owned > 0) failures.push(`${r.name}: restricted role owns ${r.owned} relation(s)`)
    if (r.functions > 0) failures.push(`${r.name}: restricted role owns ${r.functions} function(s)`)
    if (r.bypass.length) failures.push(`${r.name}: restricted role inherits ${r.bypass.join(', ')}`)
  }
  const strays = await db.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT rolname AS name FROM pg_roles WHERE (rolsuper OR rolbypassrls) AND rolname <> session_user AND rolname NOT LIKE 'pg\\_%' AND rolname <> 'postgres' ORDER BY 1`)
  for (const s of strays) failures.push(`${s.name}: unexpected SUPERUSER or BYPASSRLS role`)

  const names = roles.map((r) => r.name)
  if (names.length) {
    const risky = await db.$queryRawUnsafe<Array<{ role: string; table: string; privilege: string }>>(
      `SELECT r.role, c.relname AS table, pr.privilege
         FROM unnest($1::text[]) AS r(role)
        CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        CROSS JOIN unnest(ARRAY['TRUNCATE', 'REFERENCES', 'TRIGGER']) AS pr(privilege)
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND has_table_privilege(r.role, c.oid, pr.privilege)
        ORDER BY 1, 2, 3`, names)
    for (const x of risky) failures.push(`${x.role}: holds ${x.privilege} on ${x.table}`)

    const rewrites = await db.$queryRawUnsafe<Array<{ role: string; table: string; privilege: string }>>(
      `SELECT r.role, t.table, pr.privilege
         FROM unnest($1::text[]) AS r(role) CROSS JOIN unnest($2::text[]) AS t("table")
        CROSS JOIN unnest(ARRAY['UPDATE', 'DELETE']) AS pr(privilege)
        WHERE to_regclass(format('public.%I', t.table)) IS NOT NULL
          AND CASE pr.privilege WHEN 'UPDATE' THEN has_any_column_privilege(r.role, format('public.%I', t.table), 'UPDATE')
                                ELSE has_table_privilege(r.role, format('public.%I', t.table), 'DELETE') END
        ORDER BY 1, 2, 3`, names, [...APPEND_ONLY_TABLES])
    for (const x of rewrites) failures.push(`${x.role}: may ${x.privilege} append-only ${x.table}`)

    for (const { table, column } of CREDENTIAL_COLUMNS) {
      const readers = await db.$queryRawUnsafe<Array<{ role: string }>>(
        `SELECT r.role FROM unnest($1::text[]) AS r(role) WHERE has_column_privilege(r.role, format('public.%I', $2::text), $3::text, 'SELECT') ORDER BY 1`, names, table, column)
      for (const x of readers) if (!(CREDENTIAL_READERS as readonly string[]).includes(x.role)) failures.push(`${x.role}: may read ${table}.${column}`)
    }
  }

  const publicGrants = await db.$queryRawUnsafe<Array<{ table: string; privilege: string }>>(
    `SELECT table_name AS table, privilege_type AS privilege FROM information_schema.role_table_grants WHERE grantee = 'PUBLIC' AND table_schema = 'public' ORDER BY 1, 2`)
  for (const g of publicGrants) failures.push(`PUBLIC holds ${g.privilege} on ${g.table}`)
  const [schema] = await db.$queryRawUnsafe<Array<{ create: boolean }>>(`SELECT has_schema_privilege('public', 'public', 'CREATE') AS create`)
  if (schema?.create) failures.push('PUBLIC may CREATE in schema public')
  const definers = await db.$queryRawUnsafe<Array<{ name: string; pinned: boolean; publicExecute: boolean }>>(
    `SELECT p.proname AS name,
            coalesce(EXISTS (SELECT 1 FROM unnest(p.proconfig) cfg WHERE cfg LIKE 'search_path=%'), false) AS pinned,
            has_function_privilege('public', p.oid, 'EXECUTE') AS "publicExecute"
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prosecdef ORDER BY 1`)
  for (const d of definers) {
    if (!d.pinned) failures.push(`${d.name}: SECURITY DEFINER without a pinned search_path`)
    if (d.publicExecute) failures.push(`${d.name}: SECURITY DEFINER executable by PUBLIC`)
  }

  return {
    ok: failures.length === 0,
    failures,
    summary: { tenantTables, classifiedNonTenantTables: tables.length - tenantTables, policies: policies.length, restrictedRoles: names, appendOnlyTables: APPEND_ONLY_TABLES.length },
  }
}
