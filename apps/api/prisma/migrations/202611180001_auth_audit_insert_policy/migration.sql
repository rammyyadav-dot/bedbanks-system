-- Authentication audit events under the restricted runtime role (CTO audit F01).
--
-- auth.login.success/failure, auth.logout and auth.session.expired_or_revoked are
-- written before a tenant is selected, so tenant_id is NULL. The existing insert
-- policy only admits tenantless rows for platform access, so these inserts were
-- rejected by RLS and silently dropped by the service.
--
-- This adds one narrow INSERT policy: tenantless, entity_type 'auth', one of four
-- fixed actions, and only inside a transaction that set the transaction-local
-- app.auth_audit flag (set solely by AuthService.recordAudit). entity_id must match
-- user_id (or be 'anonymous' when there is none). No SELECT, UPDATE or DELETE is
-- granted; existing policies are unchanged.
--
-- Tenant-index review: no table, column or index is added or changed.
--
-- Rollback (forward migration, reviewed before use):
--   DROP POLICY "AuditEvent_auth_insert" ON "AuditEvent";
--   DROP FUNCTION "fbeds_auth_audit_allowed"();

CREATE FUNCTION "fbeds_auth_audit_allowed"()
RETURNS BOOLEAN AS $$
  SELECT current_setting('app.auth_audit', true) = 'true'
$$ LANGUAGE SQL STABLE;

CREATE POLICY "AuditEvent_auth_insert" ON "AuditEvent"
  FOR INSERT WITH CHECK (
    "fbeds_auth_audit_allowed"()
    AND "tenant_id" IS NULL
    AND "entity_type" = 'auth'
    AND "action" IN ('auth.login.success', 'auth.login.failure', 'auth.logout', 'auth.session.expired_or_revoked')
    AND (
      ("actor_type" = 'USER' AND "user_id" IS NOT NULL AND "entity_id" = "user_id")
      OR ("actor_type" = 'SYSTEM' AND "user_id" IS NULL AND "entity_id" = 'anonymous')
    )
  );
