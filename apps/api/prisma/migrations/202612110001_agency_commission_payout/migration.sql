-- ADR 0098: dynamic, tier-based commission payouts to agencies for a closed period's gross booked volume.
--
-- AgencyCommissionPayout   PROPOSED by one person, APPROVED or REJECTED by another (CHECK: the approver is never the proposer). The tier and basis points are resolved from
--                          gross_booked_minor by the service layer's pure tier table, never client supplied; amount_minor = floor(gross_booked_minor * commission_bp / 10000).
--                          Approval posts exactly one CREDIT to the agency account in the SAME transaction and links it in ledger_entry_id (unique), which is how a payout can
--                          never be posted twice. (tenant, request_id) makes a proposal idempotent; (agency, period_start, period_end) is unique, so a period is paid at most
--                          once; (agency, seq) numbers payouts from 1 and `number` is COM-<agency code>-P<seq>, unique per tenant.
--                          Once APPROVED or REJECTED a row never changes and no row is ever deleted (trigger). An approved row must carry its ledger entry, a rejected or
--                          proposed one must not (CHECK).
-- Permissions             finance.commission.propose and finance.commission.approve, granted to no role here.
-- Not changed             Supplier settlements (ADR 0077) and the hotel-contract commissionBp on COMMISSIONABLE rate plans are untouched; this table pays an agency for sales
--                          volume, it does not net against what a supplier is owed.
--
-- No table is granted to any role: the commission payout service runs on the API connection like the credit note and cancellation settlement services (the booking module's
-- role has no ledger access, ADR 0032), and the table is classified finance-gated in the runtime-role contract. Row-level security is ENABLED and FORCED. The agency
-- reference is composite (tenant_id, agency_id). tenant_id leads every new index.

-- CreateEnum
CREATE TYPE "AgencyCommissionTier" AS ENUM ('BRONZE', 'SILVER', 'GOLD', 'ENTERPRISE');

-- CreateEnum
CREATE TYPE "CommissionPayoutStatus" AS ENUM ('PROPOSED', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "AgencyCommissionPayout" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "agency_id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "number" TEXT NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "gross_booked_minor" BIGINT NOT NULL,
    "tier" "AgencyCommissionTier" NOT NULL,
    "commission_bp" INTEGER NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "status" "CommissionPayoutStatus" NOT NULL DEFAULT 'PROPOSED',
    "request_id" TEXT NOT NULL,
    "proposed_by_id" TEXT NOT NULL,
    "decided_by_id" TEXT,
    "decided_at" TIMESTAMP(3),
    "decision_reason" TEXT,
    "ledger_entry_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgencyCommissionPayout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgencyCommissionPayout_ledger_entry_id_key" ON "AgencyCommissionPayout"("ledger_entry_id");

-- CreateIndex
CREATE INDEX "AgencyCommissionPayout_tenant_id_status_created_at_idx" ON "AgencyCommissionPayout"("tenant_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "AgencyCommissionPayout_tenant_id_agency_id_idx" ON "AgencyCommissionPayout"("tenant_id", "agency_id");

-- CreateIndex
CREATE UNIQUE INDEX "AgencyCommissionPayout_tenant_id_id_key" ON "AgencyCommissionPayout"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "AgencyCommissionPayout_tenant_id_request_id_key" ON "AgencyCommissionPayout"("tenant_id", "request_id");

-- CreateIndex
CREATE UNIQUE INDEX "AgencyCommissionPayout_tenant_id_number_key" ON "AgencyCommissionPayout"("tenant_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "AgencyCommissionPayout_agency_id_period_start_period_end_key" ON "AgencyCommissionPayout"("agency_id", "period_start", "period_end");

-- AddForeignKey
ALTER TABLE "AgencyCommissionPayout" ADD CONSTRAINT "AgencyCommissionPayout_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgencyCommissionPayout" ADD CONSTRAINT "AgencyCommissionPayout_tenant_id_agency_id_fkey" FOREIGN KEY ("tenant_id", "agency_id") REFERENCES "Agency"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgencyCommissionPayout" ADD CONSTRAINT "AgencyCommissionPayout_ledger_entry_id_fkey" FOREIGN KEY ("ledger_entry_id") REFERENCES "LedgerEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Integrity beyond Prisma
ALTER TABLE "AgencyCommissionPayout"
  ADD CONSTRAINT "AgencyCommissionPayout_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "AgencyCommissionPayout_gross_non_negative" CHECK ("gross_booked_minor" >= 0),
  ADD CONSTRAINT "AgencyCommissionPayout_commission_bp_range" CHECK ("commission_bp" >= 0 AND "commission_bp" <= 10000),
  ADD CONSTRAINT "AgencyCommissionPayout_amount_non_negative" CHECK ("amount_minor" >= 0),
  ADD CONSTRAINT "AgencyCommissionPayout_period_order" CHECK ("period_end" > "period_start"),
  ADD CONSTRAINT "AgencyCommissionPayout_seq" CHECK ("seq" >= 1),
  ADD CONSTRAINT "AgencyCommissionPayout_number" CHECK (char_length("number") BETWEEN 5 AND 120),
  ADD CONSTRAINT "AgencyCommissionPayout_request_id" CHECK (char_length("request_id") BETWEEN 8 AND 80),
  ADD CONSTRAINT "AgencyCommissionPayout_decision_reason" CHECK ("decision_reason" IS NULL OR char_length("decision_reason") BETWEEN 3 AND 500),
  ADD CONSTRAINT "AgencyCommissionPayout_status_facts" CHECK (
    CASE "status"
      WHEN 'PROPOSED' THEN "decided_by_id" IS NULL AND "decided_at" IS NULL AND "decision_reason" IS NULL AND "ledger_entry_id" IS NULL
      WHEN 'APPROVED' THEN "decided_by_id" IS NOT NULL AND "decided_at" IS NOT NULL AND "ledger_entry_id" IS NOT NULL
      WHEN 'REJECTED' THEN "decided_by_id" IS NOT NULL AND "decided_at" IS NOT NULL AND "decision_reason" IS NOT NULL AND "ledger_entry_id" IS NULL
    END
  ),
  ADD CONSTRAINT "AgencyCommissionPayout_second_person" CHECK ("status" = 'PROPOSED' OR "decided_by_id" <> "proposed_by_id");

-- Never deleted. Only a PROPOSED payout may be updated (to its decision); its identity and amount never change.
CREATE FUNCTION "fbeds_commission_payout_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AgencyCommissionPayout is never deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."status" <> 'PROPOSED' THEN
    RAISE EXCEPTION 'A decided AgencyCommissionPayout is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."tenant_id" <> OLD."tenant_id" OR NEW."agency_id" <> OLD."agency_id" OR NEW."seq" <> OLD."seq" OR NEW."number" <> OLD."number" OR NEW."period_start" <> OLD."period_start"
     OR NEW."period_end" <> OLD."period_end" OR NEW."currency" <> OLD."currency" OR NEW."gross_booked_minor" <> OLD."gross_booked_minor" OR NEW."tier" <> OLD."tier"
     OR NEW."commission_bp" <> OLD."commission_bp" OR NEW."amount_minor" <> OLD."amount_minor" OR NEW."request_id" <> OLD."request_id"
     OR NEW."proposed_by_id" <> OLD."proposed_by_id" OR NEW."created_at" <> OLD."created_at" THEN
    RAISE EXCEPTION 'AgencyCommissionPayout identity and amount are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "AgencyCommissionPayout_guard" BEFORE UPDATE OR DELETE ON "AgencyCommissionPayout" FOR EACH ROW EXECUTE FUNCTION "fbeds_commission_payout_guard"();

-- Row-level security
ALTER TABLE "AgencyCommissionPayout" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AgencyCommissionPayout" FORCE ROW LEVEL SECURITY;
CREATE POLICY "AgencyCommissionPayout_tenant_isolation" ON "AgencyCommissionPayout" USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());

-- Permission keys enforced by the commission payout API. Granted to no role here.
INSERT INTO "Permission" ("id", "key", "description") VALUES
  (gen_random_uuid()::text, 'finance.commission.propose', 'Propose a tier-based commission payout to an agency for a closed period''s gross booked volume; no money moves until it is approved'),
  (gen_random_uuid()::text, 'finance.commission.approve', 'Approve or reject a proposed commission payout; approval credits the agency account (never the person who proposed it)')
ON CONFLICT ("key") DO NOTHING;
