-- ADR 0089 (Phase 2): Room Event Master and event/exhibition supplements.
--
-- `RoomEvent` is the event catalogue (name, type, destination, event dates, status, reference, notes), independent of any hotel's
-- commercial terms. `EventSupplement` links an approved RoomEvent to one contract (optionally one rate plan; null means every plan of the
-- contract) with a fixed amount (mirrors ContractSupplement's basis/frequency/amountMinor) or a percentage of the eligible contracted base,
-- its own valid-from/to application window (separate from the event's own dates), stacking and priority for overlapping rules, and an
-- approval lifecycle (DRAFT -> PENDING_APPROVAL -> APPROVED -> ACTIVE, or SUSPENDED/EXPIRED). `EventSupplementVersion` is an immutable
-- snapshot of its reviewed terms, directly modeled on ContractVersion (ADR 0067, F-01).
--
-- Not included here (left to the pricing-engine integration migration/ADR update): the stay evaluator reading these tables, the admin API,
-- and the maker-checker service that writes EventSupplementVersion rows. This migration only adds the tables, constraints and isolation.
--
-- Isolation: forced RLS on tenant_id for RoomEvent and EventSupplement, like Contract. EventSupplementVersion is forced RLS on tenant_id,
-- like ContractVersion, and immutable (trigger refuses UPDATE and DELETE for every role).
--
-- Tenant-index review: RoomEvent is read by (tenant_id, status) and by (tenant_id, destination_city, event_start_date, event_end_date) for
-- the dashboard/calendar views. EventSupplement is read by (tenant_id, status), (tenant_id, room_event_id), (contract_id), (rate_plan_id)
-- and (tenant_id, valid_from, valid_to) for the stay evaluator's eligibility lookup. EventSupplementVersion is read by (tenant_id,
-- event_supplement_id); the unique key (event_supplement_id, version) orders history.
--
-- Rollback (forward migration; reviewed before use):
--   DROP TRIGGER "EventSupplementVersion_immutable" ON "EventSupplementVersion"; DROP FUNCTION "fbeds_event_supplement_version_immutable"();
--   DROP TABLE "EventSupplementVersion"; DROP TYPE "EventSupplementVersionKind";
--   DROP TABLE "EventSupplement"; DROP TYPE "EventSupplementStatus"; DROP TYPE "EventSupplementAmountKind"; DROP TYPE "EventSupplementTaxTreatment";
--   DROP TABLE "RoomEvent"; DROP TYPE "RoomEventType"; DROP TYPE "RoomEventStatus";
--   No other table is touched; DailyRate and ContractSupplement are unaffected.

CREATE TYPE "RoomEventType" AS ENUM ('EXHIBITION', 'TRADE_FAIR', 'CONFERENCE', 'FESTIVAL', 'PEAK_SEASON', 'OTHER');
CREATE TYPE "RoomEventStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'CANCELLED', 'ARCHIVED');

CREATE TABLE "RoomEvent" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "name" VARCHAR(160) NOT NULL,
  "event_type" "RoomEventType" NOT NULL,
  "destination_city" VARCHAR(120) NOT NULL,
  "destination_country" CHAR(2) NOT NULL,
  "event_start_date" DATE NOT NULL,
  "event_end_date" DATE NOT NULL,
  "status" "RoomEventStatus" NOT NULL DEFAULT 'DRAFT',
  "reference_ref" VARCHAR(200),
  "internal_notes" TEXT,
  "created_by_id" TEXT NOT NULL,
  "approved_by_id" TEXT,
  "approved_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RoomEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RoomEvent_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "RoomEvent_shape_check" CHECK (
    char_length(btrim("name")) >= 1 AND "destination_country" ~ '^[A-Z]{2}$'
    AND "event_end_date" >= "event_start_date"
    AND (("status" <> 'APPROVED' AND "status" <> 'ARCHIVED') OR "approved_by_id" IS NOT NULL)
  )
);
CREATE INDEX "RoomEvent_tenant_id_status_idx" ON "RoomEvent"("tenant_id", "status");
CREATE INDEX "RoomEvent_tenant_id_destination_city_event_start_date_event_end_date_idx" ON "RoomEvent"("tenant_id", "destination_city", "event_start_date", "event_end_date");

ALTER TABLE "RoomEvent" ENABLE ROW LEVEL SECURITY; ALTER TABLE "RoomEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY "RoomEvent_tenant_isolation" ON "RoomEvent"
  USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());

CREATE TYPE "EventSupplementStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'ACTIVE', 'SUSPENDED', 'EXPIRED');
CREATE TYPE "EventSupplementAmountKind" AS ENUM ('FIXED', 'PERCENTAGE');
CREATE TYPE "EventSupplementTaxTreatment" AS ENUM ('INCLUSIVE', 'EXCLUSIVE');

CREATE TABLE "EventSupplement" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "room_event_id" TEXT NOT NULL,
  "contract_id" TEXT NOT NULL,
  "rate_plan_id" TEXT,
  "amount_kind" "EventSupplementAmountKind" NOT NULL,
  "basis" "SupplementBasis",
  "frequency" "SupplementFrequency",
  "amount_minor" BIGINT,
  "percent_bp" INTEGER,
  "currency" CHAR(3) NOT NULL,
  "tax_treatment" "EventSupplementTaxTreatment" NOT NULL DEFAULT 'EXCLUSIVE',
  "valid_from" DATE NOT NULL,
  "valid_to" DATE NOT NULL,
  "stackable" BOOLEAN NOT NULL DEFAULT false,
  "priority" INTEGER NOT NULL DEFAULT 0,
  "evidence_ref" VARCHAR(200) NOT NULL,
  "status" "EventSupplementStatus" NOT NULL DEFAULT 'DRAFT',
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_by_id" TEXT NOT NULL,
  "approved_by_id" TEXT,
  "activated_at" TIMESTAMP(3),
  "suspended_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EventSupplement_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EventSupplement_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "EventSupplement_room_event_id_fkey" FOREIGN KEY ("room_event_id") REFERENCES "RoomEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "EventSupplement_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "Contract"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "EventSupplement_rate_plan_id_fkey" FOREIGN KEY ("rate_plan_id") REFERENCES "RatePlan"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "EventSupplement_shape_check" CHECK (
    "currency" ~ '^[A-Z]{3}$' AND char_length(btrim("evidence_ref")) >= 1 AND "valid_to" >= "valid_from" AND "version" >= 1
    -- FIXED carries basis/frequency/amountMinor and no percentBp; PERCENTAGE carries percentBp and none of the fixed columns.
    AND (
      ("amount_kind" = 'FIXED' AND "basis" IS NOT NULL AND "frequency" IS NOT NULL AND "amount_minor" IS NOT NULL AND "amount_minor" > 0 AND "percent_bp" IS NULL)
      OR
      ("amount_kind" = 'PERCENTAGE' AND "percent_bp" IS NOT NULL AND "percent_bp" > 0 AND "percent_bp" <= 10000 AND "basis" IS NULL AND "frequency" IS NULL AND "amount_minor" IS NULL)
    )
    -- Only an ACTIVE or SUSPENDED (previously active) rule has been activated/approved.
    AND (("status" <> 'ACTIVE') OR ("approved_by_id" IS NOT NULL AND "activated_at" IS NOT NULL))
    AND (("status" <> 'SUSPENDED') OR ("suspended_at" IS NOT NULL))
  )
);
CREATE INDEX "EventSupplement_tenant_id_status_idx" ON "EventSupplement"("tenant_id", "status");
CREATE INDEX "EventSupplement_tenant_id_room_event_id_idx" ON "EventSupplement"("tenant_id", "room_event_id");
CREATE INDEX "EventSupplement_contract_id_idx" ON "EventSupplement"("contract_id");
CREATE INDEX "EventSupplement_rate_plan_id_idx" ON "EventSupplement"("rate_plan_id");
CREATE INDEX "EventSupplement_tenant_id_valid_from_valid_to_idx" ON "EventSupplement"("tenant_id", "valid_from", "valid_to");

ALTER TABLE "EventSupplement" ENABLE ROW LEVEL SECURITY; ALTER TABLE "EventSupplement" FORCE ROW LEVEL SECURITY;
CREATE POLICY "EventSupplement_tenant_isolation" ON "EventSupplement"
  USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());

CREATE TYPE "EventSupplementVersionKind" AS ENUM ('ACTIVATION', 'AMENDMENT');

CREATE TABLE "EventSupplementVersion" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "event_supplement_id" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "kind" "EventSupplementVersionKind" NOT NULL,
  "terms" JSONB NOT NULL,
  "fingerprint" CHAR(64) NOT NULL,
  "approval_id" TEXT NOT NULL,
  "requested_by_id" TEXT NOT NULL,
  "approved_by_id" TEXT NOT NULL,
  "applied_by_id" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EventSupplementVersion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EventSupplementVersion_event_supplement_id_fkey" FOREIGN KEY ("event_supplement_id") REFERENCES "EventSupplement"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "EventSupplementVersion_shape_check" CHECK ("version" >= 1 AND "fingerprint" ~ '^[0-9a-f]{64}$' AND "requested_by_id" <> "approved_by_id" AND char_length("reason") BETWEEN 1 AND 500)
);
CREATE UNIQUE INDEX "EventSupplementVersion_event_supplement_id_version_key" ON "EventSupplementVersion"("event_supplement_id", "version");
CREATE INDEX "EventSupplementVersion_tenant_id_event_supplement_id_idx" ON "EventSupplementVersion"("tenant_id", "event_supplement_id");

CREATE FUNCTION "fbeds_event_supplement_version_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'EventSupplementVersion rows are immutable' USING ERRCODE = 'check_violation';
END;
$$;
CREATE TRIGGER "EventSupplementVersion_immutable" BEFORE UPDATE OR DELETE ON "EventSupplementVersion" FOR EACH ROW EXECUTE FUNCTION "fbeds_event_supplement_version_immutable"();

ALTER TABLE "EventSupplementVersion" ENABLE ROW LEVEL SECURITY; ALTER TABLE "EventSupplementVersion" FORCE ROW LEVEL SECURITY;
CREATE POLICY "EventSupplementVersion_tenant_isolation" ON "EventSupplementVersion"
  USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());
