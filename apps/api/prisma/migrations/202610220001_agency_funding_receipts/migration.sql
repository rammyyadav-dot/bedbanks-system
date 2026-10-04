-- Agency funding receipts, slice 2 of ADR 0028 (manual bank-transfer funding).
--
-- Owner decisions (2026-10-04): finance staff AND agencies (agent portal) may declare; posting above AED 10,000 needs a second approver;
-- cash deposits and third-party payers are allowed but must be cleared by a compliance review before posting.
--
-- States: DECLARED -> VERIFIED -> POSTED, or REJECTED from DECLARED or VERIFIED. Only POSTED moves money: posting opens the agency's
-- account if needed and appends one CREDIT ("LedgerEntry", idempotency key "funding:<receipt id>"), all in one transaction.
--
-- The service enforces the workflow; these constraints make the database refuse what the service must never do:
--   * amount > 0; ISO currency; trimmed bank reference (1-80) and payer name (1-140);
--   * compliance review is required exactly for cash deposits and third-party payers;
--   * separation of duties: verifier, compliance reviewer and poster each differ from the declarer; above the threshold the poster also
--     differs from the verifier; a receipt needing compliance review cannot be POSTED without a clearance;
--   * each status carries exactly the facts it implies (a POSTED receipt has its verifier, poster, account and ledger entry; a REJECTED one
--     its rejecter and reason; a DECLARED one none of them).
-- One live receipt per (tenant, bank reference, amount, currency): partial unique index, REJECTED receipts excluded so a corrected
-- declaration can be made. Prisma cannot declare it; the schema has the plain tenant/reference index.
--
-- Runtime role: finance-gated (privileged path, ADR 0032): posting writes "Wallet" and "LedgerEntry", which "fbeds_api" never writes. No GRANT.
-- Tenant indexes: every index leads with "tenant_id" (except the unique ledger entry reference). Same-tenant guard on agency, account and entry.
--
-- Rollback is a later forward migration, and only while no receipt is POSTED:
--   DROP TABLE "FundingReceipt"; DROP TYPE "FundingReceiptStatus", "FundingMethod", "FundingPayerType", "FundingChannel";
--   DELETE FROM "Permission" WHERE key = 'funding.manage';

-- CreateEnum
CREATE TYPE "FundingReceiptStatus" AS ENUM ('DECLARED', 'VERIFIED', 'POSTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "FundingMethod" AS ENUM ('BANK_TRANSFER', 'CASH_DEPOSIT');

-- CreateEnum
CREATE TYPE "FundingPayerType" AS ENUM ('AGENCY', 'THIRD_PARTY');

-- CreateEnum
CREATE TYPE "FundingChannel" AS ENUM ('ADMIN', 'AGENT');

-- CreateTable
CREATE TABLE "FundingReceipt" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "agency_id" TEXT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "method" "FundingMethod" NOT NULL,
    "bank_reference" TEXT NOT NULL,
    "value_date" DATE NOT NULL,
    "payer_name" TEXT NOT NULL,
    "payer_type" "FundingPayerType" NOT NULL,
    "notes" TEXT,
    "compliance_review_required" BOOLEAN NOT NULL,
    "second_approval_required" BOOLEAN NOT NULL,
    "status" "FundingReceiptStatus" NOT NULL DEFAULT 'DECLARED',
    "channel" "FundingChannel" NOT NULL,
    "request_id" TEXT NOT NULL,
    "declared_by_id" TEXT NOT NULL,
    "verified_by_id" TEXT,
    "verified_at" TIMESTAMP(3),
    "verification_note" TEXT,
    "compliance_cleared_by_id" TEXT,
    "compliance_cleared_at" TIMESTAMP(3),
    "compliance_note" TEXT,
    "posted_by_id" TEXT,
    "posted_at" TIMESTAMP(3),
    "rejected_by_id" TEXT,
    "rejected_at" TIMESTAMP(3),
    "rejection_reason" TEXT,
    "wallet_id" TEXT,
    "ledger_entry_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FundingReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FundingReceipt_ledger_entry_id_key" ON "FundingReceipt"("ledger_entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "FundingReceipt_tenant_id_request_id_key" ON "FundingReceipt"("tenant_id", "request_id");

-- CreateIndex
CREATE INDEX "FundingReceipt_tenant_id_status_created_at_idx" ON "FundingReceipt"("tenant_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "FundingReceipt_tenant_id_agency_id_created_at_idx" ON "FundingReceipt"("tenant_id", "agency_id", "created_at");

-- CreateIndex
CREATE INDEX "FundingReceipt_tenant_id_bank_reference_idx" ON "FundingReceipt"("tenant_id", "bank_reference");

-- One live receipt per bank reference, amount and currency
CREATE UNIQUE INDEX "FundingReceipt_one_live_per_reference" ON "FundingReceipt"("tenant_id", "bank_reference", "amount_minor", "currency") WHERE "status" <> 'REJECTED';

-- AddForeignKey
ALTER TABLE "FundingReceipt" ADD CONSTRAINT "FundingReceipt_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FundingReceipt" ADD CONSTRAINT "FundingReceipt_agency_id_fkey" FOREIGN KEY ("agency_id") REFERENCES "Agency"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FundingReceipt" ADD CONSTRAINT "FundingReceipt_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FundingReceipt" ADD CONSTRAINT "FundingReceipt_ledger_entry_id_fkey" FOREIGN KEY ("ledger_entry_id") REFERENCES "LedgerEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Integrity beyond Prisma
ALTER TABLE "FundingReceipt"
  ADD CONSTRAINT "FundingReceipt_amount_positive" CHECK ("amount_minor" > 0),
  ADD CONSTRAINT "FundingReceipt_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "FundingReceipt_bank_reference" CHECK (char_length("bank_reference") BETWEEN 1 AND 80 AND "bank_reference" = btrim("bank_reference")),
  ADD CONSTRAINT "FundingReceipt_payer_name" CHECK (char_length("payer_name") BETWEEN 1 AND 140 AND "payer_name" = btrim("payer_name")),
  ADD CONSTRAINT "FundingReceipt_compliance_rule" CHECK ("compliance_review_required" = ("method" = 'CASH_DEPOSIT' OR "payer_type" = 'THIRD_PARTY')),
  ADD CONSTRAINT "FundingReceipt_verifier_not_declarer" CHECK ("verified_by_id" IS NULL OR "verified_by_id" <> "declared_by_id"),
  ADD CONSTRAINT "FundingReceipt_compliance_not_declarer" CHECK ("compliance_cleared_by_id" IS NULL OR "compliance_cleared_by_id" <> "declared_by_id"),
  ADD CONSTRAINT "FundingReceipt_poster_not_declarer" CHECK ("posted_by_id" IS NULL OR "posted_by_id" <> "declared_by_id"),
  ADD CONSTRAINT "FundingReceipt_second_approver" CHECK (NOT "second_approval_required" OR "posted_by_id" IS NULL OR "posted_by_id" <> "verified_by_id"),
  ADD CONSTRAINT "FundingReceipt_compliance_before_post" CHECK ("status" <> 'POSTED' OR NOT "compliance_review_required" OR "compliance_cleared_by_id" IS NOT NULL),
  ADD CONSTRAINT "FundingReceipt_status_facts" CHECK (
    CASE "status"
      WHEN 'DECLARED' THEN "verified_by_id" IS NULL AND "posted_by_id" IS NULL AND "rejected_by_id" IS NULL AND "wallet_id" IS NULL AND "ledger_entry_id" IS NULL
      WHEN 'VERIFIED' THEN "verified_by_id" IS NOT NULL AND "verified_at" IS NOT NULL AND "posted_by_id" IS NULL AND "rejected_by_id" IS NULL AND "wallet_id" IS NULL AND "ledger_entry_id" IS NULL
      WHEN 'POSTED' THEN "verified_by_id" IS NOT NULL AND "posted_by_id" IS NOT NULL AND "posted_at" IS NOT NULL AND "wallet_id" IS NOT NULL AND "ledger_entry_id" IS NOT NULL AND "rejected_by_id" IS NULL
      WHEN 'REJECTED' THEN "rejected_by_id" IS NOT NULL AND "rejected_at" IS NOT NULL AND "rejection_reason" IS NOT NULL AND "posted_by_id" IS NULL AND "wallet_id" IS NULL AND "ledger_entry_id" IS NULL
    END
  );

-- Row-level security
ALTER TABLE "FundingReceipt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FundingReceipt" FORCE ROW LEVEL SECURITY;
CREATE POLICY "FundingReceipt_tenant_isolation" ON "FundingReceipt" USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());

-- Same-tenant references (ADR 0032 amendment pattern)
CREATE TRIGGER "FundingReceipt_tenant_references" BEFORE INSERT OR UPDATE OF "tenant_id", "agency_id", "wallet_id", "ledger_entry_id" ON "FundingReceipt"
  FOR EACH ROW EXECUTE FUNCTION "fbeds_enforce_tenant_references"('agency_id', 'Agency', 'wallet_id', 'Wallet', 'ledger_entry_id', 'LedgerEntry');

-- Permission key enforced by the funding API. Granted to no role here.
INSERT INTO "Permission" ("id", "key", "description") VALUES
  (gen_random_uuid()::text, 'funding.manage', 'Declare, verify, clear and post agency funding receipts (different people at each step)')
ON CONFLICT ("key") DO NOTHING;
