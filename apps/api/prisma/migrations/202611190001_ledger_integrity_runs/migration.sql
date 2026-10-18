-- Nightly ledger integrity runs (ADR 0064).
--
-- Adds LedgerIntegrityRun: one immutable snapshot of the ledger integrity report per tenant per UTC date, written by the restricted
-- background role "fbeds_ledger_audit" (created out-of-band by the database owner; this migration creates no role and stores no secret).
--
-- Tenant isolation: forced row-level security on tenant_id. SELECT is tenant-scoped for any role granted the table. INSERT is allowed
-- only to members of fbeds_ledger_audit, only for the current tenant. There is no UPDATE or DELETE policy, and a trigger rejects both
-- (the one exception is the foreign-key cascade when a tenant is erased, as for BookingEvent).
-- Audit: members of fbeds_ledger_audit may insert exactly one kind of AuditEvent: SYSTEM, no user, action 'finance.integrity.run',
-- entity 'ledger_integrity_run', current tenant. They are excluded from the general tenant insert policy (no USER-type events).
-- Money: nothing here stores an amount as a number. Amounts inside "report" are integer strings in minor units.
--
-- Tenant-index review: UNIQUE (tenant_id, run_date) leads with tenant_id; it serves the idempotency check, the history list (newest first
-- by scanning backwards) and the "has tonight's run happened" lookup. No other index is needed at one row per tenant per day.
--
-- Rollback (forward migration, reviewed before use; stored results are lost, the ledger itself is untouched):
--   DROP POLICY "AuditEvent_ledger_audit_system_insert" ON "AuditEvent";
--   DROP POLICY "AuditEvent_tenant_insert" ON "AuditEvent";
--   CREATE POLICY "AuditEvent_tenant_insert" ON "AuditEvent"
--     FOR INSERT WITH CHECK ((NOT "fbeds_is_hold_expiry_role"())
--       AND (("tenant_id" = "fbeds_current_tenant_id"() AND "actor_type" <> 'SYSTEM') OR ("tenant_id" IS NULL AND "fbeds_platform_access_allowed"())));
--   DROP FUNCTION "fbeds_is_ledger_audit_role"();
--   DROP TABLE "LedgerIntegrityRun"; DROP FUNCTION "fbeds_ledger_integrity_run_immutable"();

CREATE TABLE "LedgerIntegrityRun" (
  "id"               TEXT        NOT NULL,
  "tenant_id"        TEXT        NOT NULL,
  "run_date"         DATE        NOT NULL,
  "trigger"          TEXT        NOT NULL DEFAULT 'SCHEDULED',
  "status"           TEXT        NOT NULL,
  "errors"           INTEGER     NOT NULL,
  "warnings"         INTEGER     NOT NULL,
  "truncated"        BOOLEAN     NOT NULL DEFAULT false,
  "accounts_scanned" INTEGER     NOT NULL,
  "bookings_scanned" INTEGER     NOT NULL,
  "entries_scanned"  INTEGER     NOT NULL,
  "report"           JSONB       NOT NULL,
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LedgerIntegrityRun_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LedgerIntegrityRun_status_check" CHECK ("status" IN ('PASS', 'WARN', 'FAIL')),
  CONSTRAINT "LedgerIntegrityRun_trigger_check" CHECK ("trigger" = 'SCHEDULED'),
  CONSTRAINT "LedgerIntegrityRun_counts_check" CHECK ("errors" >= 0 AND "warnings" >= 0 AND "accounts_scanned" >= 0 AND "bookings_scanned" >= 0 AND "entries_scanned" >= 0),
  -- The verdict must agree with the counts it was derived from, so a stored row can never contradict itself.
  CONSTRAINT "LedgerIntegrityRun_status_matches_counts" CHECK (
    ("status" = 'FAIL' AND "errors" > 0) OR ("status" = 'WARN' AND "errors" = 0 AND "warnings" > 0) OR ("status" = 'PASS' AND "errors" = 0 AND "warnings" = 0)
  ),
  CONSTRAINT "LedgerIntegrityRun_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "LedgerIntegrityRun_tenant_id_run_date_key" ON "LedgerIntegrityRun"("tenant_id", "run_date");

ALTER TABLE "LedgerIntegrityRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LedgerIntegrityRun" FORCE ROW LEVEL SECURITY;

CREATE FUNCTION "fbeds_is_ledger_audit_role"()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM pg_roles r
     WHERE r.rolname = 'fbeds_ledger_audit'
       AND pg_has_role(current_user, r.oid, 'MEMBER')
  )
$$ LANGUAGE SQL STABLE;

CREATE POLICY "LedgerIntegrityRun_tenant_select" ON "LedgerIntegrityRun"
  FOR SELECT USING ("tenant_id" = "fbeds_current_tenant_id"());
CREATE POLICY "LedgerIntegrityRun_ledger_audit_insert" ON "LedgerIntegrityRun"
  FOR INSERT WITH CHECK ("fbeds_is_ledger_audit_role"() AND "tenant_id" = "fbeds_current_tenant_id"());

-- Append-only: a direct UPDATE or DELETE is rejected. A foreign-key cascade (tenant erased by its owner) runs at trigger depth > 1 and is allowed.
CREATE FUNCTION "fbeds_ledger_integrity_run_immutable"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'LedgerIntegrityRun is append-only' USING ERRCODE = '42501';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "LedgerIntegrityRun_immutable" BEFORE UPDATE OR DELETE ON "LedgerIntegrityRun"
  FOR EACH ROW EXECUTE FUNCTION "fbeds_ledger_integrity_run_immutable"();

-- The run's SYSTEM audit event: the narrow exception, modelled on the hold-expiry policy (ADR 0005).
DROP POLICY "AuditEvent_tenant_insert" ON "AuditEvent";
CREATE POLICY "AuditEvent_tenant_insert" ON "AuditEvent"
  FOR INSERT WITH CHECK (
    NOT "fbeds_is_hold_expiry_role"()
    AND NOT "fbeds_is_ledger_audit_role"()
    AND (
      ("tenant_id" = "fbeds_current_tenant_id"() AND "actor_type" <> 'SYSTEM')
      OR ("tenant_id" IS NULL AND "fbeds_platform_access_allowed"())
    )
  );

CREATE POLICY "AuditEvent_ledger_audit_system_insert" ON "AuditEvent"
  FOR INSERT WITH CHECK (
    "fbeds_is_ledger_audit_role"()
    AND "tenant_id" = "fbeds_current_tenant_id"()
    AND "actor_type" = 'SYSTEM'
    AND "user_id" IS NULL
    AND "action" = 'finance.integrity.run'
    AND "entity_type" = 'ledger_integrity_run'
  );
