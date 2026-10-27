-- ADR 0100, step 2 of 2: ledger adjustments and reversals on an agency account, proposed by one person and approved by another.
--
-- LedgerAdjustment   ADJUSTMENT (a reasoned correction, credit or debit: bank fee, unidentified credit allocated, correction, goodwill) or REVERSAL (a received payment taken back:
--                    bank recall, chargeback, duplicate payment). PROPOSED by one person, APPROVED or REJECTED by another (CHECK: the approver is never the proposer). Approval posts exactly
--                    one ledger entry of the same kind and amount in the SAME transaction and links it in ledger_entry_id (unique), which is how an adjustment can never be posted twice.
--                    amount_minor is the signed stored amount in the account currency: an ADJUSTMENT either way, a REVERSAL always negative. A REVERSAL names the funding receipt it takes
--                    back (CHECK) and an ADJUSTMENT never does; the cap against what the receipt paid is enforced by the service under the receipt row lock and re-checked by the daily
--                    integrity run (REVERSAL_EXCEEDS_RECEIPT). (tenant, request_id) makes a proposal idempotent. Once decided a row never changes and no row is ever deleted (trigger).
--                    A BEFORE INSERT trigger ties the row to its account: the wallet is in the same tenant, belongs to the same agency and holds the same currency, and a named receipt
--                    belongs to that agency and currency too (a foreign key is validated without a tenant comparison, so row-level security alone would not catch a mix-up).
-- LedgerEntry        "LedgerEntry_sign_by_type" is re-created to include the new kinds: CREDIT, RELEASE, REFUND positive; DEBIT, HOLD, REVERSAL negative; ADJUSTMENT non-zero. It is added
--                    NOT VALID and then validated, so a row that breaks it stops the migration and nothing is applied. The table is locked for the duration of the scan, like
--                    202611230001_ledger_integrity_guards before it; run it in a quiet window.
-- Permissions        finance.adjustment.propose and finance.adjustment.approve, granted to no role here.
-- Not changed        No existing entry, booking, cancellation, credit note or funding receipt is touched.
--
-- No table is granted to any role: the service runs on the API connection like the credit note and commission payout services (the booking module's role has no ledger access,
-- ADR 0032), and the table is classified finance-gated in the runtime-role contract. Row-level security is ENABLED and FORCED. tenant_id leads every tenant index; the two single-column
-- indexes (wallet_id, funding_receipt_id) exist only so the foreign keys do not seq-scan the child table when a wallet or receipt changes.
--
-- Rollback (forward migration; reviewed before use; it discards the record of proposed and decided adjustments, so export them first; ADJUSTMENT and REVERSAL entries already posted stay,
-- the ledger is append-only, and the sign rule below must keep covering them, so restore the older CHECK only if none were posted):
--   DROP TABLE "LedgerAdjustment"; DROP FUNCTION "fbeds_ledger_adjustment_guard"(); DROP FUNCTION "fbeds_ledger_adjustment_account"();
--   DROP TYPE "LedgerAdjustmentStatus"; DROP TYPE "LedgerAdjustmentReason"; DROP TYPE "LedgerAdjustmentKind";
--   DELETE FROM "Permission" WHERE key IN ('finance.adjustment.propose', 'finance.adjustment.approve');

-- migration-safety: allow drop-constraint re-created below with the new kinds in the same transaction, validated before the migration can commit
ALTER TABLE "LedgerEntry" DROP CONSTRAINT "LedgerEntry_sign_by_type";
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_sign_by_type" CHECK (
  ("type" IN ('CREDIT', 'RELEASE', 'REFUND') AND "amount_minor" > 0)
  OR ("type" IN ('DEBIT', 'HOLD', 'REVERSAL') AND "amount_minor" < 0)
  OR ("type" = 'ADJUSTMENT' AND "amount_minor" <> 0)
) NOT VALID;
ALTER TABLE "LedgerEntry" VALIDATE CONSTRAINT "LedgerEntry_sign_by_type";

-- CreateEnum
CREATE TYPE "LedgerAdjustmentKind" AS ENUM ('ADJUSTMENT', 'REVERSAL');

-- CreateEnum
CREATE TYPE "LedgerAdjustmentReason" AS ENUM ('BANK_FEE', 'UNIDENTIFIED_CREDIT_ALLOCATED', 'CORRECTION', 'GOODWILL', 'PAYMENT_RECALL', 'CHARGEBACK', 'DUPLICATE_PAYMENT');

-- CreateEnum
CREATE TYPE "LedgerAdjustmentStatus" AS ENUM ('PROPOSED', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "LedgerAdjustment" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "agency_id" TEXT NOT NULL,
    "wallet_id" TEXT NOT NULL,
    "kind" "LedgerAdjustmentKind" NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "reason" "LedgerAdjustmentReason" NOT NULL,
    "note" TEXT NOT NULL,
    "funding_receipt_id" TEXT,
    "status" "LedgerAdjustmentStatus" NOT NULL DEFAULT 'PROPOSED',
    "request_id" TEXT NOT NULL,
    "proposed_by_id" TEXT NOT NULL,
    "decided_by_id" TEXT,
    "decided_at" TIMESTAMP(3),
    "decision_reason" TEXT,
    "ledger_entry_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LedgerAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LedgerAdjustment_ledger_entry_id_key" ON "LedgerAdjustment"("ledger_entry_id");

-- CreateIndex
CREATE INDEX "LedgerAdjustment_tenant_id_status_created_at_idx" ON "LedgerAdjustment"("tenant_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "LedgerAdjustment_tenant_id_agency_id_idx" ON "LedgerAdjustment"("tenant_id", "agency_id");

-- CreateIndex
CREATE INDEX "LedgerAdjustment_wallet_id_idx" ON "LedgerAdjustment"("wallet_id");

-- CreateIndex
CREATE INDEX "LedgerAdjustment_funding_receipt_id_idx" ON "LedgerAdjustment"("funding_receipt_id");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerAdjustment_tenant_id_id_key" ON "LedgerAdjustment"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerAdjustment_tenant_id_request_id_key" ON "LedgerAdjustment"("tenant_id", "request_id");

-- AddForeignKey
ALTER TABLE "LedgerAdjustment" ADD CONSTRAINT "LedgerAdjustment_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerAdjustment" ADD CONSTRAINT "LedgerAdjustment_tenant_id_agency_id_fkey" FOREIGN KEY ("tenant_id", "agency_id") REFERENCES "Agency"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerAdjustment" ADD CONSTRAINT "LedgerAdjustment_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerAdjustment" ADD CONSTRAINT "LedgerAdjustment_funding_receipt_id_fkey" FOREIGN KEY ("funding_receipt_id") REFERENCES "FundingReceipt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerAdjustment" ADD CONSTRAINT "LedgerAdjustment_ledger_entry_id_fkey" FOREIGN KEY ("ledger_entry_id") REFERENCES "LedgerEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Integrity beyond Prisma
ALTER TABLE "LedgerAdjustment"
  ADD CONSTRAINT "LedgerAdjustment_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "LedgerAdjustment_amount_nonzero" CHECK ("amount_minor" <> 0),
  ADD CONSTRAINT "LedgerAdjustment_note" CHECK (char_length("note") BETWEEN 3 AND 500),
  ADD CONSTRAINT "LedgerAdjustment_request_id" CHECK (char_length("request_id") BETWEEN 8 AND 80),
  ADD CONSTRAINT "LedgerAdjustment_decision_reason" CHECK ("decision_reason" IS NULL OR char_length("decision_reason") BETWEEN 3 AND 500),
  ADD CONSTRAINT "LedgerAdjustment_kind_facts" CHECK (
    CASE "kind"
      WHEN 'ADJUSTMENT' THEN "funding_receipt_id" IS NULL AND "reason" IN ('BANK_FEE', 'UNIDENTIFIED_CREDIT_ALLOCATED', 'CORRECTION', 'GOODWILL')
      WHEN 'REVERSAL' THEN "funding_receipt_id" IS NOT NULL AND "amount_minor" < 0 AND "reason" IN ('PAYMENT_RECALL', 'CHARGEBACK', 'DUPLICATE_PAYMENT')
    END
  ),
  ADD CONSTRAINT "LedgerAdjustment_status_facts" CHECK (
    CASE "status"
      WHEN 'PROPOSED' THEN "decided_by_id" IS NULL AND "decided_at" IS NULL AND "decision_reason" IS NULL AND "ledger_entry_id" IS NULL
      WHEN 'APPROVED' THEN "decided_by_id" IS NOT NULL AND "decided_at" IS NOT NULL AND "ledger_entry_id" IS NOT NULL
      WHEN 'REJECTED' THEN "decided_by_id" IS NOT NULL AND "decided_at" IS NOT NULL AND "decision_reason" IS NOT NULL AND "ledger_entry_id" IS NULL
    END
  ),
  ADD CONSTRAINT "LedgerAdjustment_second_person" CHECK ("status" = 'PROPOSED' OR "decided_by_id" <> "proposed_by_id");

-- The row is tied to its account when it is created: same tenant, same agency, same currency, and a named receipt belongs to that agency and currency.
CREATE FUNCTION "fbeds_ledger_adjustment_account"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  w_agency text;
  w_currency text;
  r_agency text;
  r_currency text;
BEGIN
  SELECT w."agency_id", w."currency" INTO w_agency, w_currency FROM "Wallet" w WHERE w."id" = NEW."wallet_id" AND w."tenant_id" = NEW."tenant_id";
  IF w_currency IS NULL THEN
    RAISE EXCEPTION 'LedgerAdjustment wallet belongs to another tenant or does not exist' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF w_agency IS DISTINCT FROM NEW."agency_id" OR w_currency <> NEW."currency" THEN
    RAISE EXCEPTION 'LedgerAdjustment agency or currency differs from its wallet' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."funding_receipt_id" IS NOT NULL THEN
    SELECT f."agency_id", f."currency" INTO r_agency, r_currency FROM "FundingReceipt" f WHERE f."id" = NEW."funding_receipt_id" AND f."tenant_id" = NEW."tenant_id";
    IF r_currency IS NULL OR r_agency <> NEW."agency_id" OR r_currency <> NEW."currency" THEN
      RAISE EXCEPTION 'LedgerAdjustment receipt belongs to another tenant, agency or currency' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "LedgerAdjustment_account" BEFORE INSERT ON "LedgerAdjustment" FOR EACH ROW EXECUTE FUNCTION "fbeds_ledger_adjustment_account"();

-- Never deleted. Only a PROPOSED row may be updated (to its decision); its identity and amount never change.
CREATE FUNCTION "fbeds_ledger_adjustment_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'LedgerAdjustment is never deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."status" <> 'PROPOSED' THEN
    RAISE EXCEPTION 'A decided LedgerAdjustment is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."tenant_id" <> OLD."tenant_id" OR NEW."agency_id" <> OLD."agency_id" OR NEW."wallet_id" <> OLD."wallet_id" OR NEW."kind" <> OLD."kind" OR NEW."currency" <> OLD."currency"
     OR NEW."amount_minor" <> OLD."amount_minor" OR NEW."reason" <> OLD."reason" OR NEW."note" <> OLD."note" OR NEW."funding_receipt_id" IS DISTINCT FROM OLD."funding_receipt_id"
     OR NEW."request_id" <> OLD."request_id" OR NEW."proposed_by_id" <> OLD."proposed_by_id" OR NEW."created_at" <> OLD."created_at" THEN
    RAISE EXCEPTION 'LedgerAdjustment identity and amount are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "LedgerAdjustment_guard" BEFORE UPDATE OR DELETE ON "LedgerAdjustment" FOR EACH ROW EXECUTE FUNCTION "fbeds_ledger_adjustment_guard"();

-- Row-level security
ALTER TABLE "LedgerAdjustment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LedgerAdjustment" FORCE ROW LEVEL SECURITY;
CREATE POLICY "LedgerAdjustment_tenant_isolation" ON "LedgerAdjustment" USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());

-- Permission keys enforced by the adjustment API. Granted to no role here.
INSERT INTO "Permission" ("id", "key", "description") VALUES
  (gen_random_uuid()::text, 'finance.adjustment.propose', 'Propose a correction or a payment reversal on an agency account; no money moves until it is approved'),
  (gen_random_uuid()::text, 'finance.adjustment.approve', 'Approve or reject a proposed adjustment or reversal; approval posts to the agency account (never the person who proposed it)')
ON CONFLICT ("key") DO NOTHING;
