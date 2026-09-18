-- Release controls: ordinary tenant application roles may read and insert
-- ledger/audit records within RLS scope, but cannot update or delete them.
-- Migration/retention work must use a separately governed owner role.

DROP POLICY "LedgerEntry_tenant_isolation" ON "LedgerEntry";
CREATE POLICY "LedgerEntry_tenant_select" ON "LedgerEntry"
  FOR SELECT USING ("tenant_id" = "fbeds_current_tenant_id"());
CREATE POLICY "LedgerEntry_tenant_insert" ON "LedgerEntry"
  FOR INSERT WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());

DROP POLICY "AuditEvent_tenant_isolation" ON "AuditEvent";
CREATE POLICY "AuditEvent_tenant_select" ON "AuditEvent"
  FOR SELECT USING ("tenant_id" = "fbeds_current_tenant_id"());
CREATE POLICY "AuditEvent_tenant_insert" ON "AuditEvent"
  FOR INSERT WITH CHECK (
    "tenant_id" = "fbeds_current_tenant_id"()
    AND "actor_type" <> 'SYSTEM'
  );
