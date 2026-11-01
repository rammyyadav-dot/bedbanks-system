-- Password-reset audit events under the restricted runtime role (follow-up to 202611180001, ADR 0091).
--
-- AuthService.recordAudit also writes auth.password_reset.requested, .failed and .completed. The
-- AuditEvent_auth_insert policy from 202611180001 admitted only four actions, so these three were
-- rejected by RLS and dropped (logged as auth_audit_persist_failed, never stored).
--
-- This replaces that one INSERT policy with the same conditions and an action list extended by exactly
-- those three actions. Still tenantless, entity_type 'auth', only under the transaction-local
-- app.auth_audit flag, entity_id tied to user_id (or 'anonymous' for SYSTEM). No SELECT, UPDATE or
-- DELETE is granted; no other policy, table, column or index changes.
--
-- Tenant-index review: no table, column or index is added or changed; the rows stay tenantless (tenant_id NULL).
--
-- Rollback (forward migration, reviewed before use): recreate the policy with the original four-action list
-- from 202611180001_auth_audit_insert_policy. Stored password-reset audit rows are immutable and remain.

DROP POLICY "AuditEvent_auth_insert" ON "AuditEvent";

CREATE POLICY "AuditEvent_auth_insert" ON "AuditEvent"
  FOR INSERT WITH CHECK (
    "fbeds_auth_audit_allowed"()
    AND "tenant_id" IS NULL
    AND "entity_type" = 'auth'
    AND "action" IN (
      'auth.login.success', 'auth.login.failure', 'auth.logout', 'auth.session.expired_or_revoked',
      'auth.password_reset.requested', 'auth.password_reset.failed', 'auth.password_reset.completed'
    )
    AND (
      ("actor_type" = 'USER' AND "user_id" IS NOT NULL AND "entity_id" = "user_id")
      OR ("actor_type" = 'SYSTEM' AND "user_id" IS NULL AND "entity_id" = 'anonymous')
    )
  );
