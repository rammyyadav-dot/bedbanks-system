-- ADR 0079: the supplier ingestion worker is a system actor, and the general AuditEvent insert policy refuses SYSTEM rows.
--
-- fbeds_is_supplier_ingest_role()                        true when the session user is a member of the NOLOGIN group `fbeds_ingest` (same shape as fbeds_is_finance_posting_role, ADR 0076).
-- Policy "AuditEvent_supplier_ingest_system_insert"      admits exactly: that role, the current tenant, actor SYSTEM, no user, entity_type 'supplier_ingest_run', and the three
--                                                        actions supplier.ingest.complete | partial | failed.
--
-- No table or role is created or granted here: the group and login are provisioned by the owner tool (apps/api/src/database/supplier-ingest-role.ts). Without that role the policy admits nothing.
--
-- Rollback (forward migration; reviewed before use; only while the ingestion worker is stopped; SYSTEM audit rows already written stay):
--   DROP POLICY "AuditEvent_supplier_ingest_system_insert" ON "AuditEvent"; DROP FUNCTION "fbeds_is_supplier_ingest_role"();

CREATE FUNCTION "fbeds_is_supplier_ingest_role"()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM pg_roles r
     WHERE r.rolname = 'fbeds_ingest'
       AND pg_has_role(current_user, r.oid, 'MEMBER')
  )
$$ LANGUAGE SQL STABLE;

CREATE POLICY "AuditEvent_supplier_ingest_system_insert" ON "AuditEvent"
  FOR INSERT WITH CHECK (
    "fbeds_is_supplier_ingest_role"()
    AND "tenant_id" = "fbeds_current_tenant_id"()
    AND "actor_type" = 'SYSTEM'
    AND "user_id" IS NULL
    AND "action" IN ('supplier.ingest.complete', 'supplier.ingest.partial', 'supplier.ingest.failed')
    AND "entity_type" = 'supplier_ingest_run'
  );
