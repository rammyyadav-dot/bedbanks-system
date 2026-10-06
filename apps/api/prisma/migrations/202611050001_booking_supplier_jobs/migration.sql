-- ADR 0039, Phase 3: the supplier job queue and call log for the Admin booking module, plus one read-only helper for the job runner.
--
-- BookingSupplierJob   a DB-backed queue (BOOK, CANCEL, STATUS_CHECK) behind the JobQueue interface. One first try plus three retries, waiting 30 s / 2 min / 5 min (run_after): at most four calls.
--                      A booking is never marked FAILED from here when the supplier's answer is unknown: the job goes UNKNOWN and an operator syncs.
-- BookingSupplierCall  the append-only log of every call made (the spec's supplier_call). A SUMMARY only: outcome, attempt, duration, error code, supplier
--                      reference. Raw supplier requests and responses are NEVER stored (CLAUDE.md invariant 7), so there is no payload column.
-- fbeds_booking_due_tenants(now)  SECURITY DEFINER, returns only tenant ids that have a job due to run, so the runner can visit tenants without any
--                      cross-tenant table read. EXECUTE is granted to the booking group role by the owner-run provisioning script, not here.
-- Both tables: tenant-composite keys, tenant_id leading every index, FORCED row-level security (tenant_id = fbeds_current_tenant_id()).
-- No existing row, constraint, policy or grant changes. Rows cascade with their booking (never done by the application).
--
-- Rollback (forward migration; reviewed before use; only while the runner is stopped):
--   DROP FUNCTION "fbeds_booking_due_tenants"(timestamp);
--   DROP TABLE "BookingSupplierCall"; DROP TABLE "BookingSupplierJob";
--   DROP FUNCTION "fbeds_booking_supplier_call_immutable"();
--   DROP TYPE "BookingSupplierJobStatus"; DROP TYPE "BookingSupplierJobKind";
CREATE TYPE "BookingSupplierJobKind" AS ENUM ('BOOK', 'CANCEL', 'STATUS_CHECK');
CREATE TYPE "BookingSupplierJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'RETRY_WAIT', 'SUCCEEDED', 'FAILED', 'UNKNOWN');

CREATE TABLE "BookingSupplierJob" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "booking_id" TEXT NOT NULL,
  "kind" "BookingSupplierJobKind" NOT NULL,
  "status" "BookingSupplierJobStatus" NOT NULL DEFAULT 'QUEUED',
  "attempt" INTEGER NOT NULL DEFAULT 0,
  "max_attempts" INTEGER NOT NULL DEFAULT 4,
  "run_after" TIMESTAMP(3) NOT NULL,
  "locked_until" TIMESTAMP(3),
  "requested_by_user_id" TEXT,
  "idempotency_key" TEXT NOT NULL,
  "request_fingerprint" TEXT NOT NULL,
  "last_error_code" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "completed_at" TIMESTAMP(3),
  CONSTRAINT "BookingSupplierJob_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BookingSupplierJob_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "BookingSupplierJob_tenant_id_booking_id_fkey" FOREIGN KEY ("tenant_id", "booking_id") REFERENCES "Booking"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "BookingSupplierJob_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "BookingSupplierJob_attempts_check" CHECK ("attempt" >= 0 AND "max_attempts" BETWEEN 1 AND 10 AND "attempt" <= "max_attempts"),
  CONSTRAINT "BookingSupplierJob_key_check" CHECK (length("idempotency_key") BETWEEN 8 AND 128 AND "request_fingerprint" ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX "BookingSupplierJob_tenant_id_booking_id_idempotency_key_key" ON "BookingSupplierJob"("tenant_id", "booking_id", "idempotency_key");
CREATE INDEX "BookingSupplierJob_tenant_id_status_run_after_idx" ON "BookingSupplierJob"("tenant_id", "status", "run_after");
CREATE INDEX "BookingSupplierJob_tenant_id_booking_id_created_at_idx" ON "BookingSupplierJob"("tenant_id", "booking_id", "created_at");

CREATE TABLE "BookingSupplierCall" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "booking_id" TEXT NOT NULL,
  "job_id" TEXT,
  "action" "BookingSupplierJobKind" NOT NULL,
  "attempt" INTEGER NOT NULL,
  "supplier_key" TEXT NOT NULL,
  "outcome" TEXT NOT NULL,
  "error_code" TEXT,
  "http_status" INTEGER,
  "duration_ms" INTEGER,
  "supplier_reference" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BookingSupplierCall_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BookingSupplierCall_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "BookingSupplierCall_tenant_id_booking_id_fkey" FOREIGN KEY ("tenant_id", "booking_id") REFERENCES "Booking"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "BookingSupplierCall_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "BookingSupplierJob"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "BookingSupplierCall_values_check" CHECK ("attempt" >= 0 AND ("duration_ms" IS NULL OR "duration_ms" >= 0) AND ("http_status" IS NULL OR "http_status" BETWEEN 100 AND 599))
);
CREATE INDEX "BookingSupplierCall_tenant_id_booking_id_created_at_idx" ON "BookingSupplierCall"("tenant_id", "booking_id", "created_at");

ALTER TABLE "BookingSupplierJob" ENABLE ROW LEVEL SECURITY; ALTER TABLE "BookingSupplierJob" FORCE ROW LEVEL SECURITY;
ALTER TABLE "BookingSupplierCall" ENABLE ROW LEVEL SECURITY; ALTER TABLE "BookingSupplierCall" FORCE ROW LEVEL SECURITY;
CREATE POLICY "BookingSupplierJob_tenant_isolation" ON "BookingSupplierJob"
  USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());
CREATE POLICY "BookingSupplierCall_tenant_isolation" ON "BookingSupplierCall"
  USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());

-- The call log is append-only (same cascade exception as BookingEvent). The job_id SET NULL is a foreign-key action, so allowed at depth > 1.
CREATE OR REPLACE FUNCTION "fbeds_booking_supplier_call_immutable"() RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN COALESCE(NEW, OLD); END IF;
  RAISE EXCEPTION 'BookingSupplierCall is append-only' USING ERRCODE = '42501';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "BookingSupplierCall_immutable" BEFORE UPDATE OR DELETE ON "BookingSupplierCall"
  FOR EACH ROW EXECUTE FUNCTION "fbeds_booking_supplier_call_immutable"();

-- Tenants with something to run. SECURITY DEFINER so the runner needs no cross-tenant table grant; it returns ids only, nothing else.
-- A RUNNING job whose lock has expired (a crashed runner) counts as due.
CREATE FUNCTION "fbeds_booking_due_tenants"(now_ts TIMESTAMP) RETURNS SETOF TEXT AS $$
  SELECT DISTINCT j."tenant_id" FROM "BookingSupplierJob" j
   WHERE (j."status" IN ('QUEUED', 'RETRY_WAIT') AND j."run_after" <= now_ts)
      OR (j."status" = 'RUNNING' AND j."locked_until" IS NOT NULL AND j."locked_until" <= now_ts)
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION "fbeds_booking_due_tenants"(TIMESTAMP) FROM PUBLIC;
