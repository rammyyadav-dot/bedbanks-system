-- Operator group is created out-of-band. No role creation, grants or persistent provisioning.
-- Existing USER/platform/hold-expiry audit policies are unchanged.
CREATE FUNCTION "fbeds_is_sandbox_staging_role"()
RETURNS BOOLEAN AS $$
 SELECT EXISTS (
   SELECT 1 FROM pg_roles r WHERE r.rolname = 'fbeds_sandbox_staging'
   AND pg_has_role(current_user, r.oid, 'MEMBER')
 )
$$ LANGUAGE SQL STABLE;

CREATE POLICY "AuditEvent_sandbox_content_system_insert" ON "AuditEvent"
 FOR INSERT WITH CHECK (
  "fbeds_is_sandbox_staging_role"()
  AND "tenant_id" = "fbeds_current_tenant_id"()
  AND "actor_type" = 'SYSTEM' AND "user_id" IS NULL
  AND "entity_type" = 'sandbox_content_run'
  AND "action" IN ('sandbox.content.attempted', 'sandbox.content.page_staged',
                  'sandbox.content.completed', 'sandbox.content.paused', 'sandbox.content.failed')
 );
-- Reviewed forward rollback: DROP POLICY above, then DROP FUNCTION above.
