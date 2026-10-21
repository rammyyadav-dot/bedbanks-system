-- ADR 0078: persistence for normalized supplier / channel-manager ingestion (rates, allotments, cancellation policies).
--
-- SupplierIngestRun                 append-only record of one ingestion attempt: status, counts, reject-code summary, idempotency key + request hash. No payload content.
-- SupplierRateObservation           latest supplier net per supplier night (BIGINT minor units + CHAR(3) currency).
-- SupplierAllotmentObservation      latest supplier stock statement per night (mode + count; a missing row is unknown, never zero: ADR 0030 #4).
-- SupplierCancellationObservation   latest cancellation policy per supplier rate plan (canonical ordered windows as JSONB).
--
-- These are OBSERVATIONS keyed by supplier codes. They are not DailyRate / DailyAvailability / CancellationPolicy and nothing reads them to sell. Supplier codes are not canonical ids;
-- governed mappings (ADR 0004) resolve them in a later, separately reviewed step. Every row carries fresh_until, so an observation fails closed after its expiry (ADR 0030 #7).
-- Only a COMPLETE run applies observations (CHECK below); PARTIAL and FAILED runs are evidence only.
--
-- Every foreign key into a tenant-owned table is composite (tenant_id, ...). tenant_id leads every index. Row-level security is ENABLED and FORCED.
-- No grant to any role is made here: the API runtime role does not write these tables (apps/api/src/database/runtime-role-contract.ts, PRIVILEGED_WRITE_MODELS);
-- the writer is a separate ingestion role provisioned by the owner, which is not built in this change.
--
-- Rollback (forward migration; reviewed before use; only while no ingestion is running; it discards ingestion evidence):
--   DROP TABLE "SupplierCancellationObservation"; DROP TABLE "SupplierAllotmentObservation"; DROP TABLE "SupplierRateObservation"; DROP TABLE "SupplierIngestRun";
--   DROP FUNCTION "fbeds_supplier_ingest_run_immutable"(); DROP FUNCTION "fbeds_supplier_observation_guard"();
--   DROP TYPE "SupplierIngestStatus"; DROP TYPE "SupplierIngestKind";
-- Tenant-index review: every unique and secondary index starts with tenant_id; hot read paths are (tenant_id, supplier_id, stay_date) and the natural keys.

-- CreateEnum
CREATE TYPE "SupplierIngestKind" AS ENUM ('RATES', 'ALLOTMENTS', 'CANCELLATION_POLICIES');

-- CreateEnum
CREATE TYPE "SupplierIngestStatus" AS ENUM ('COMPLETE', 'PARTIAL', 'FAILED');

-- CreateTable
CREATE TABLE "SupplierIngestRun" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "supplier_id" TEXT NOT NULL,
    "connector_id" TEXT NOT NULL,
    "kind" "SupplierIngestKind" NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "status" "SupplierIngestStatus" NOT NULL,
    "extracted_count" INTEGER NOT NULL,
    "accepted_count" INTEGER NOT NULL,
    "rejected_count" INTEGER NOT NULL,
    "reject_summary" JSONB NOT NULL DEFAULT '{}',
    "applied" BOOLEAN NOT NULL,
    "source_updated_at" TIMESTAMP(3),
    "received_at" TIMESTAMP(3) NOT NULL,
    "fresh_until" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplierIngestRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierRateObservation" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "supplier_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "supplier_hotel_code" TEXT NOT NULL,
    "supplier_room_code" TEXT NOT NULL,
    "supplier_rate_plan_code" TEXT NOT NULL,
    "stay_date" DATE NOT NULL,
    "board_code" TEXT,
    "currency" CHAR(3) NOT NULL,
    "net_minor" BIGINT NOT NULL,
    "taxes_included" BOOLEAN,
    "min_stay" INTEGER,
    "max_stay" INTEGER,
    "closed_to_arrival" BOOLEAN NOT NULL,
    "closed_to_departure" BOOLEAN NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL,
    "fresh_until" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierRateObservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierAllotmentObservation" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "supplier_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "supplier_hotel_code" TEXT NOT NULL,
    "supplier_room_code" TEXT NOT NULL,
    "supplier_rate_plan_code" TEXT NOT NULL,
    "stay_date" DATE NOT NULL,
    "mode" "InventoryMode" NOT NULL,
    "available" INTEGER,
    "stop_sell" BOOLEAN NOT NULL,
    "release_days" INTEGER,
    "received_at" TIMESTAMP(3) NOT NULL,
    "fresh_until" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierAllotmentObservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierCancellationObservation" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "supplier_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "supplier_hotel_code" TEXT NOT NULL,
    "supplier_room_code" TEXT NOT NULL,
    "supplier_rate_plan_code" TEXT NOT NULL,
    "non_refundable" BOOLEAN NOT NULL,
    "windows" JSONB NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL,
    "fresh_until" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierCancellationObservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SupplierIngestRun_tenant_id_supplier_id_created_at_idx" ON "SupplierIngestRun"("tenant_id", "supplier_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierIngestRun_tenant_id_connector_id_idempotency_key_key" ON "SupplierIngestRun"("tenant_id", "connector_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierIngestRun_tenant_id_id_key" ON "SupplierIngestRun"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "SupplierRateObservation_tenant_id_supplier_id_stay_date_idx" ON "SupplierRateObservation"("tenant_id", "supplier_id", "stay_date");

-- CreateIndex
CREATE INDEX "SupplierRateObservation_tenant_id_run_id_idx" ON "SupplierRateObservation"("tenant_id", "run_id");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierRateObservation_natural_key" ON "SupplierRateObservation"("tenant_id", "supplier_id", "supplier_hotel_code", "supplier_room_code", "supplier_rate_plan_code", "stay_date");

-- CreateIndex
CREATE INDEX "SupplierAllotmentObservation_tenant_id_supplier_id_stay_dat_idx" ON "SupplierAllotmentObservation"("tenant_id", "supplier_id", "stay_date");

-- CreateIndex
CREATE INDEX "SupplierAllotmentObservation_tenant_id_run_id_idx" ON "SupplierAllotmentObservation"("tenant_id", "run_id");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierAllotmentObservation_natural_key" ON "SupplierAllotmentObservation"("tenant_id", "supplier_id", "supplier_hotel_code", "supplier_room_code", "supplier_rate_plan_code", "stay_date");

-- CreateIndex
CREATE INDEX "SupplierCancellationObservation_tenant_id_supplier_id_idx" ON "SupplierCancellationObservation"("tenant_id", "supplier_id");

-- CreateIndex
CREATE INDEX "SupplierCancellationObservation_tenant_id_run_id_idx" ON "SupplierCancellationObservation"("tenant_id", "run_id");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierCancellationObservation_natural_key" ON "SupplierCancellationObservation"("tenant_id", "supplier_id", "supplier_hotel_code", "supplier_room_code", "supplier_rate_plan_code");

-- AddForeignKey
ALTER TABLE "SupplierIngestRun" ADD CONSTRAINT "SupplierIngestRun_tenant_id_supplier_id_fkey" FOREIGN KEY ("tenant_id", "supplier_id") REFERENCES "Supplier"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierIngestRun" ADD CONSTRAINT "SupplierIngestRun_tenant_id_connector_id_supplier_id_fkey" FOREIGN KEY ("tenant_id", "connector_id", "supplier_id") REFERENCES "ConnectorDefinition"("tenant_id", "id", "supplier_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierRateObservation" ADD CONSTRAINT "SupplierRateObservation_tenant_id_supplier_id_fkey" FOREIGN KEY ("tenant_id", "supplier_id") REFERENCES "Supplier"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierRateObservation" ADD CONSTRAINT "SupplierRateObservation_tenant_id_run_id_fkey" FOREIGN KEY ("tenant_id", "run_id") REFERENCES "SupplierIngestRun"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierAllotmentObservation" ADD CONSTRAINT "SupplierAllotmentObservation_tenant_id_supplier_id_fkey" FOREIGN KEY ("tenant_id", "supplier_id") REFERENCES "Supplier"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierAllotmentObservation" ADD CONSTRAINT "SupplierAllotmentObservation_tenant_id_run_id_fkey" FOREIGN KEY ("tenant_id", "run_id") REFERENCES "SupplierIngestRun"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierCancellationObservation" ADD CONSTRAINT "SupplierCancellationObservation_tenant_id_supplier_id_fkey" FOREIGN KEY ("tenant_id", "supplier_id") REFERENCES "Supplier"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierCancellationObservation" ADD CONSTRAINT "SupplierCancellationObservation_tenant_id_run_id_fkey" FOREIGN KEY ("tenant_id", "run_id") REFERENCES "SupplierIngestRun"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Integrity beyond Prisma
ALTER TABLE "SupplierIngestRun"
  ADD CONSTRAINT "SupplierIngestRun_key_format" CHECK ("idempotency_key" ~ '^[A-Za-z0-9_-]{8,128}$'),
  ADD CONSTRAINT "SupplierIngestRun_hash_format" CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "SupplierIngestRun_counts" CHECK ("extracted_count" >= 0 AND "accepted_count" >= 0 AND "rejected_count" >= 0 AND "accepted_count" <= "extracted_count" AND "rejected_count" <= "extracted_count"),
  ADD CONSTRAINT "SupplierIngestRun_applied_needs_complete" CHECK (NOT "applied" OR ("status" = 'COMPLETE' AND "fresh_until" IS NOT NULL AND "fresh_until" > "received_at" AND "accepted_count" > 0)),
  ADD CONSTRAINT "SupplierIngestRun_summary_object" CHECK (jsonb_typeof("reject_summary") = 'object' AND pg_column_size("reject_summary") <= 8192);

ALTER TABLE "SupplierRateObservation"
  ADD CONSTRAINT "SupplierRateObservation_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "SupplierRateObservation_net_positive" CHECK ("net_minor" > 0),
  ADD CONSTRAINT "SupplierRateObservation_stay" CHECK (("min_stay" IS NULL OR "min_stay" BETWEEN 1 AND 365) AND ("max_stay" IS NULL OR "max_stay" BETWEEN 1 AND 365) AND ("min_stay" IS NULL OR "max_stay" IS NULL OR "max_stay" >= "min_stay")),
  ADD CONSTRAINT "SupplierRateObservation_codes" CHECK ("supplier_hotel_code" ~ '^[A-Za-z0-9_.:/-]{1,64}$' AND "supplier_room_code" ~ '^[A-Za-z0-9_.:/-]{1,64}$' AND "supplier_rate_plan_code" ~ '^[A-Za-z0-9_.:/-]{1,64}$' AND ("board_code" IS NULL OR "board_code" ~ '^[A-Za-z0-9_.:/-]{1,64}$')),
  ADD CONSTRAINT "SupplierRateObservation_fresh" CHECK ("fresh_until" > "received_at");

ALTER TABLE "SupplierAllotmentObservation"
  ADD CONSTRAINT "SupplierAllotmentObservation_count_matches_mode" CHECK (("mode" = 'ALLOTMENT' AND "available" IS NOT NULL AND "available" BETWEEN 0 AND 99999) OR ("mode" <> 'ALLOTMENT' AND "available" IS NULL)),
  ADD CONSTRAINT "SupplierAllotmentObservation_release" CHECK ("release_days" IS NULL OR "release_days" BETWEEN 0 AND 365),
  ADD CONSTRAINT "SupplierAllotmentObservation_codes" CHECK ("supplier_hotel_code" ~ '^[A-Za-z0-9_.:/-]{1,64}$' AND "supplier_room_code" ~ '^[A-Za-z0-9_.:/-]{1,64}$' AND "supplier_rate_plan_code" ~ '^([A-Za-z0-9_.:/-]{1,64})?$'),
  ADD CONSTRAINT "SupplierAllotmentObservation_fresh" CHECK ("fresh_until" > "received_at");

ALTER TABLE "SupplierCancellationObservation"
  ADD CONSTRAINT "SupplierCancellationObservation_windows" CHECK (jsonb_typeof("windows") = 'array' AND jsonb_array_length("windows") <= 50 AND ("non_refundable" OR jsonb_array_length("windows") > 0)),
  ADD CONSTRAINT "SupplierCancellationObservation_codes" CHECK ("supplier_hotel_code" ~ '^[A-Za-z0-9_.:/-]{1,64}$' AND "supplier_room_code" ~ '^([A-Za-z0-9_.:/-]{1,64})?$' AND "supplier_rate_plan_code" ~ '^[A-Za-z0-9_.:/-]{1,64}$'),
  ADD CONSTRAINT "SupplierCancellationObservation_fresh" CHECK ("fresh_until" > "received_at");

-- A run is evidence: never updated, and deleted only by the owner-governed erasure (retention, tenant offboarding), which sets the transaction-local flag fbeds.ingest_erasure.
-- The application never sets it (same model as the ledger erasure flag, ADR 0069).
CREATE FUNCTION "fbeds_supplier_ingest_run_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('fbeds.ingest_erasure', true) = 'on' THEN RETURN OLD; END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
CREATE TRIGGER "SupplierIngestRun_immutable" BEFORE UPDATE OR DELETE ON "SupplierIngestRun" FOR EACH ROW EXECUTE FUNCTION "fbeds_supplier_ingest_run_immutable"();

-- An observation is never deleted by the application (expiry is by fresh_until; owner-governed erasure uses fbeds.ingest_erasure), its identity never changes, and an older feed never overwrites a newer one.
CREATE FUNCTION "fbeds_supplier_observation_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('fbeds.ingest_erasure', true) = 'on' THEN RETURN OLD; END IF;
    RAISE EXCEPTION '% rows are never deleted', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."tenant_id" <> OLD."tenant_id" OR NEW."supplier_id" <> OLD."supplier_id" OR NEW."supplier_hotel_code" <> OLD."supplier_hotel_code"
     OR NEW."supplier_room_code" <> OLD."supplier_room_code" OR NEW."supplier_rate_plan_code" <> OLD."supplier_rate_plan_code" OR NEW."created_at" <> OLD."created_at" THEN
    RAISE EXCEPTION '% identity is immutable', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."received_at" < OLD."received_at" THEN
    RAISE EXCEPTION 'An older feed cannot overwrite a newer % row', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "SupplierRateObservation_guard" BEFORE UPDATE OR DELETE ON "SupplierRateObservation" FOR EACH ROW EXECUTE FUNCTION "fbeds_supplier_observation_guard"();
CREATE TRIGGER "SupplierAllotmentObservation_guard" BEFORE UPDATE OR DELETE ON "SupplierAllotmentObservation" FOR EACH ROW EXECUTE FUNCTION "fbeds_supplier_observation_guard"();
CREATE TRIGGER "SupplierCancellationObservation_guard" BEFORE UPDATE OR DELETE ON "SupplierCancellationObservation" FOR EACH ROW EXECUTE FUNCTION "fbeds_supplier_observation_guard"();

-- Row-level security
ALTER TABLE "SupplierIngestRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SupplierIngestRun" FORCE ROW LEVEL SECURITY;
CREATE POLICY "SupplierIngestRun_tenant_isolation" ON "SupplierIngestRun" USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());
ALTER TABLE "SupplierRateObservation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SupplierRateObservation" FORCE ROW LEVEL SECURITY;
CREATE POLICY "SupplierRateObservation_tenant_isolation" ON "SupplierRateObservation" USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());
ALTER TABLE "SupplierAllotmentObservation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SupplierAllotmentObservation" FORCE ROW LEVEL SECURITY;
CREATE POLICY "SupplierAllotmentObservation_tenant_isolation" ON "SupplierAllotmentObservation" USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());
ALTER TABLE "SupplierCancellationObservation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SupplierCancellationObservation" FORCE ROW LEVEL SECURITY;
CREATE POLICY "SupplierCancellationObservation_tenant_isolation" ON "SupplierCancellationObservation" USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());
