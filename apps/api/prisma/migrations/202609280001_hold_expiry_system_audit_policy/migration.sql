-- Hold-expiry background role: SYSTEM audit policy (ADR 0005).
--
-- AuditEvent inserts with actor_type = 'SYSTEM' are rejected by every existing
-- policy for roles that respect RLS. Expiry of an InventoryHold is a SYSTEM
-- action, so the sweeper needs one narrowly scoped exception, and that role
-- must not gain the general audit-insert ability of ordinary tenant roles.
--
-- Members of the group role "fbeds_hold_expiry" (created out-of-band by the
-- database owner; this migration creates no role and stores no secret):
--   * MAY insert only: tenant = current tenant, actor_type SYSTEM, no user,
--     action 'inventory.hold.expired', entity_type 'inventory_hold';
--   * MAY NOT use the general tenant insert policy (no USER-type events).
-- The membership test reads pg_roles, so the migration is valid even when the
-- role does not exist; the policies then behave exactly as before.
--
-- Tenant-index review: no table, column or index is added or changed. Predicates
-- use tenant_id, already covered by AuditEvent(tenant_id, created_at).
--
-- Rollback (forward migration, reviewed before use):
--   DROP POLICY "AuditEvent_hold_expiry_system_insert" ON "AuditEvent";
--   DROP POLICY "AuditEvent_tenant_insert" ON "AuditEvent";
--   CREATE POLICY "AuditEvent_tenant_insert" ON "AuditEvent"
--     FOR INSERT WITH CHECK (("tenant_id" = "fbeds_current_tenant_id"() AND "actor_type" <> 'SYSTEM')
--       OR ("tenant_id" IS NULL AND "fbeds_platform_access_allowed"()));
--   DROP FUNCTION "fbeds_is_hold_expiry_role"();

CREATE FUNCTION "fbeds_is_hold_expiry_role"()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM pg_roles r
     WHERE r.rolname = 'fbeds_hold_expiry'
       AND pg_has_role(current_user, r.oid, 'MEMBER')
  )
$$ LANGUAGE SQL STABLE;

DROP POLICY "AuditEvent_tenant_insert" ON "AuditEvent";
CREATE POLICY "AuditEvent_tenant_insert" ON "AuditEvent"
  FOR INSERT WITH CHECK (
    NOT "fbeds_is_hold_expiry_role"()
    AND (
      ("tenant_id" = "fbeds_current_tenant_id"() AND "actor_type" <> 'SYSTEM')
      OR ("tenant_id" IS NULL AND "fbeds_platform_access_allowed"())
    )
  );

CREATE POLICY "AuditEvent_hold_expiry_system_insert" ON "AuditEvent"
  FOR INSERT WITH CHECK (
    "fbeds_is_hold_expiry_role"()
    AND "tenant_id" = "fbeds_current_tenant_id"()
    AND "actor_type" = 'SYSTEM'
    AND "user_id" IS NULL
    AND "action" = 'inventory.hold.expired'
    AND "entity_type" = 'inventory_hold'
  );
