import { upsertLoginRoleSql } from './hold-expiry-role'
export const TENANT_CONTROL_LOGIN = 'fbeds_tenant_control_login'
export const TENANT_CONTROL_GROUP = 'fbeds_tenant_control'
/** Owner-only provisioning; no invocation from HTTP handlers or automatic migrations. */
export async function provisionTenantControlRole(db: { $executeRawUnsafe(sql: string): Promise<number> }, password: string) {
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(password)) throw new Error('A generated URL-safe password is required')
  const attrs = 'NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION'
  await db.$executeRawUnsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${TENANT_CONTROL_GROUP}') THEN CREATE ROLE "${TENANT_CONTROL_GROUP}" NOLOGIN ${attrs}; END IF; END $$`)
  await db.$executeRawUnsafe(upsertLoginRoleSql(TENANT_CONTROL_LOGIN, password, attrs, 10))
  await db.$executeRawUnsafe(`GRANT "${TENANT_CONTROL_GROUP}" TO "${TENANT_CONTROL_LOGIN}"`)
  const g = `"${TENANT_CONTROL_GROUP}"`
  await db.$executeRawUnsafe(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${g}`)
  await db.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${g}`)
  for (const table of ['tenants','tenant_settings','tenant_control_profiles','memberships','Role','UserRole','RolePermission','Permission','PlatformRoleAssignment','PlatformRole','PlatformRolePermission','PlatformPermission','Agency','Supplier','Hotel','Contract','RatePlan','DistributionRestriction','CommercialMarkupRule','SupplierHotelMapping','ApprovalRequest','AuditEvent']) await db.$executeRawUnsafe(`GRANT SELECT ON "${table}" TO ${g}`)
  await db.$executeRawUnsafe(`GRANT SELECT (id, email, name, status, last_login_at) ON users TO ${g}`)
  for (const table of ['tenants','tenant_settings','tenant_control_profiles','memberships','AuditEvent']) await db.$executeRawUnsafe(`GRANT INSERT ON "${table}" TO ${g}`)
  await db.$executeRawUnsafe(`GRANT UPDATE (name, status, updated_at) ON tenants TO ${g}`)
  await db.$executeRawUnsafe(`GRANT UPDATE (business, registration_key, classification, country, stage, compliance_status, compliance_approved_by, updated_by, version, updated_at) ON tenant_control_profiles TO ${g}`)
  await db.$executeRawUnsafe(`GRANT UPDATE (role, revoked_at, updated_at) ON memberships TO ${g}`)
  await db.$executeRawUnsafe(`GRANT UPDATE (support_email, default_language, time_zone, default_currency, low_balance_threshold_minor, low_balance_currency, last_idempotency_key, last_mutation_fingerprint, updated_at) ON tenant_settings TO ${g}`)
  // tenants is the canonical auth directory. The authoring role is additionally scoped by a restrictive write policy.
  await db.$executeRawUnsafe('ALTER TABLE tenants ENABLE ROW LEVEL SECURITY')
  await db.$executeRawUnsafe('ALTER TABLE tenants FORCE ROW LEVEL SECURITY')
  await db.$executeRawUnsafe('DROP POLICY IF EXISTS tenants_auth_read ON tenants')
  await db.$executeRawUnsafe('CREATE POLICY tenants_auth_read ON tenants FOR SELECT USING (true)')
  await db.$executeRawUnsafe('DROP POLICY IF EXISTS tenants_control_insert ON tenants')
  await db.$executeRawUnsafe(`CREATE POLICY tenants_control_insert ON tenants FOR INSERT TO ${g} WITH CHECK ("fbeds_platform_access_allowed"() AND status = 'SUSPENDED')`)
  await db.$executeRawUnsafe('DROP POLICY IF EXISTS tenants_control_update ON tenants')
  await db.$executeRawUnsafe(`CREATE POLICY tenants_control_update ON tenants FOR UPDATE TO ${g} USING (id = "fbeds_current_tenant_id"()) WITH CHECK (id = "fbeds_current_tenant_id"())`)
}
