-- ADR 0093: bank statement reconciliation (R6). A bank statement is imported once, matched against supplier settlements and funding receipts, and every
-- difference becomes an exception that a person other than the importer closes.
--
-- BankStatement        immutable (trigger). Account number kept only as a SHA-256 and its last four characters; no remittance text or payer name is stored anywhere.
--                      content_sha256 covers the canonical entries, so the same statement cannot be imported twice under another number; (tenant, request_id) makes an import idempotent.
-- BankStatementEntry   one bank movement: positive amount_minor plus ISO-4217 currency, direction CREDIT | DEBIT. Immutable.
-- BankMatchFinding     the match result per movement (and per expected payment missing from the statement). Only the workflow columns move: OPEN -> RESOLVED, once, by a different
--                      person than raised_by_id (CHECK). A RESOLVED row never changes again and no row is ever deleted (trigger).
--
-- Nothing here posts to "LedgerEntry" or "Wallet", moves money, or converts a currency. No table is granted to any role: the narrow reconciliation role (fbeds_recon_ops) is
-- provisioned separately (apps/api/src/database/reconciliation-role.ts). Row-level security is ENABLED and FORCED. Every foreign key to a tenant-owned table is composite
-- (tenant_id, id). tenant_id leads every new index. Permissions reuse finance.reconcile.run (import) and finance.reconcile.resolve (close an exception); none is added.
--
-- Rollback (forward migration; reviewed before use; it discards imported bank statements and the exception history, so export them first):
--   DROP TABLE "BankMatchFinding"; DROP TABLE "BankStatementEntry"; DROP TABLE "BankStatement";
--   DROP FUNCTION "fbeds_bank_expected_receipts"(DATE, DATE, INTEGER); DROP FUNCTION "fbeds_bank_immutable"(); DROP FUNCTION "fbeds_bank_finding_guard"();
--   DROP TYPE "BankExceptionStatus"; DROP TYPE "BankMatchType"; DROP TYPE "BankDirection"; DROP TYPE "BankStatementFormat";

-- CreateEnum
CREATE TYPE "BankStatementFormat" AS ENUM ('MT940', 'CAMT053', 'CSV');

-- CreateEnum
CREATE TYPE "BankDirection" AS ENUM ('CREDIT', 'DEBIT');

-- CreateEnum
CREATE TYPE "BankMatchType" AS ENUM ('MATCHED', 'AMOUNT_MISMATCH', 'CURRENCY_MISMATCH', 'DIRECTION_MISMATCH', 'AMBIGUOUS_REFERENCE', 'DUPLICATE_ENTRY', 'DUPLICATE_PAYMENT', 'UNMATCHED_ENTRY', 'EXPECTED_NOT_ON_STATEMENT');

-- CreateEnum
CREATE TYPE "BankExceptionStatus" AS ENUM ('OPEN', 'RESOLVED');

-- CreateTable
CREATE TABLE "BankStatement" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "format" "BankStatementFormat" NOT NULL,
    "statement_ref" TEXT NOT NULL,
    "account_sha256" CHAR(64) NOT NULL,
    "account_last4" TEXT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "opening_minor" BIGINT,
    "closing_minor" BIGINT,
    "entry_count" INTEGER NOT NULL,
    "content_sha256" CHAR(64) NOT NULL,
    "request_id" TEXT NOT NULL,
    "imported_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankStatement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankStatementEntry" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "statement_id" TEXT NOT NULL,
    "entry_no" INTEGER NOT NULL,
    "entry_ref" TEXT NOT NULL,
    "direction" "BankDirection" NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "booking_date" DATE NOT NULL,
    "value_date" DATE NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankStatementEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankMatchFinding" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "statement_id" TEXT NOT NULL,
    "finding_key" TEXT NOT NULL,
    "entry_id" TEXT,
    "type" "BankMatchType" NOT NULL,
    "is_exception" BOOLEAN NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "bank_minor" BIGINT,
    "expected_minor" BIGINT,
    "variance_minor" BIGINT,
    "expected_kind" TEXT,
    "expected_id" TEXT,
    "status" "BankExceptionStatus" NOT NULL DEFAULT 'OPEN',
    "resolution" TEXT,
    "resolution_reason" TEXT,
    "raised_by_id" TEXT NOT NULL,
    "resolved_by_id" TEXT,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankMatchFinding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BankStatement_tenant_id_created_at_idx" ON "BankStatement"("tenant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "BankStatement_tenant_id_id_key" ON "BankStatement"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "BankStatement_tenant_id_request_id_key" ON "BankStatement"("tenant_id", "request_id");

-- CreateIndex
CREATE UNIQUE INDEX "BankStatement_tenant_id_content_sha256_key" ON "BankStatement"("tenant_id", "content_sha256");

-- CreateIndex
CREATE UNIQUE INDEX "BankStatement_tenant_id_account_sha256_statement_ref_key" ON "BankStatement"("tenant_id", "account_sha256", "statement_ref");

-- CreateIndex
CREATE INDEX "BankStatementEntry_tenant_id_statement_id_idx" ON "BankStatementEntry"("tenant_id", "statement_id");

-- CreateIndex
CREATE UNIQUE INDEX "BankStatementEntry_tenant_id_id_key" ON "BankStatementEntry"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "BankStatementEntry_statement_id_entry_no_key" ON "BankStatementEntry"("statement_id", "entry_no");

-- CreateIndex
CREATE INDEX "BankMatchFinding_tenant_id_is_exception_status_created_at_idx" ON "BankMatchFinding"("tenant_id", "is_exception", "status", "created_at");

-- CreateIndex
CREATE INDEX "BankMatchFinding_tenant_id_statement_id_status_idx" ON "BankMatchFinding"("tenant_id", "statement_id", "status");

-- CreateIndex
CREATE INDEX "BankMatchFinding_tenant_id_type_expected_id_idx" ON "BankMatchFinding"("tenant_id", "type", "expected_id");

-- CreateIndex
CREATE UNIQUE INDEX "BankMatchFinding_tenant_id_id_key" ON "BankMatchFinding"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "BankMatchFinding_tenant_id_statement_id_finding_key_key" ON "BankMatchFinding"("tenant_id", "statement_id", "finding_key");

-- AddForeignKey
ALTER TABLE "BankStatement" ADD CONSTRAINT "BankStatement_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankStatementEntry" ADD CONSTRAINT "BankStatementEntry_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankStatementEntry" ADD CONSTRAINT "BankStatementEntry_tenant_id_statement_id_fkey" FOREIGN KEY ("tenant_id", "statement_id") REFERENCES "BankStatement"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankMatchFinding" ADD CONSTRAINT "BankMatchFinding_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankMatchFinding" ADD CONSTRAINT "BankMatchFinding_tenant_id_statement_id_fkey" FOREIGN KEY ("tenant_id", "statement_id") REFERENCES "BankStatement"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankMatchFinding" ADD CONSTRAINT "BankMatchFinding_tenant_id_entry_id_fkey" FOREIGN KEY ("tenant_id", "entry_id") REFERENCES "BankStatementEntry"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Integrity beyond Prisma
ALTER TABLE "BankStatement"
  ADD CONSTRAINT "BankStatement_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "BankStatement_ref" CHECK (char_length("statement_ref") BETWEEN 1 AND 80 AND "statement_ref" = btrim("statement_ref")),
  ADD CONSTRAINT "BankStatement_request_id" CHECK (char_length("request_id") BETWEEN 8 AND 80),
  ADD CONSTRAINT "BankStatement_hashes" CHECK ("account_sha256" ~ '^[0-9a-f]{64}$' AND "content_sha256" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "BankStatement_last4" CHECK (char_length("account_last4") BETWEEN 1 AND 4),
  ADD CONSTRAINT "BankStatement_period" CHECK ("period_start" <= "period_end"),
  ADD CONSTRAINT "BankStatement_entry_count" CHECK ("entry_count" BETWEEN 1 AND 50000);

ALTER TABLE "BankStatementEntry"
  ADD CONSTRAINT "BankStatementEntry_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "BankStatementEntry_amount_positive" CHECK ("amount_minor" > 0),
  ADD CONSTRAINT "BankStatementEntry_entry_no" CHECK ("entry_no" >= 1),
  ADD CONSTRAINT "BankStatementEntry_ref" CHECK (char_length("entry_ref") BETWEEN 1 AND 200);

ALTER TABLE "BankMatchFinding"
  ADD CONSTRAINT "BankMatchFinding_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "BankMatchFinding_exception_flag" CHECK ("is_exception" = ("type" <> 'MATCHED')),
  ADD CONSTRAINT "BankMatchFinding_amounts_positive" CHECK (("bank_minor" IS NULL OR "bank_minor" > 0) AND ("expected_minor" IS NULL OR "expected_minor" > 0)),
  ADD CONSTRAINT "BankMatchFinding_variance" CHECK ("variance_minor" IS NULL OR ("bank_minor" IS NOT NULL AND "expected_minor" IS NOT NULL AND "variance_minor" = "bank_minor" - "expected_minor")),
  ADD CONSTRAINT "BankMatchFinding_expected_kind" CHECK ("expected_kind" IS NULL OR "expected_kind" IN ('SUPPLIER_SETTLEMENT', 'FUNDING_RECEIPT')),
  ADD CONSTRAINT "BankMatchFinding_expected_pair" CHECK (("expected_kind" IS NULL) = ("expected_id" IS NULL)),
  ADD CONSTRAINT "BankMatchFinding_resolution" CHECK ("resolution" IS NULL OR "resolution" IN ('EXPLAINED', 'BANK_CORRECTION_REQUESTED', 'INTERNAL_CORRECTION_REQUESTED')),
  ADD CONSTRAINT "BankMatchFinding_reason" CHECK ("resolution_reason" IS NULL OR char_length("resolution_reason") BETWEEN 3 AND 500),
  ADD CONSTRAINT "BankMatchFinding_status_facts" CHECK (
    CASE "status"
      WHEN 'OPEN' THEN "resolution" IS NULL AND "resolution_reason" IS NULL AND "resolved_by_id" IS NULL AND "resolved_at" IS NULL
      WHEN 'RESOLVED' THEN "resolution" IS NOT NULL AND "resolution_reason" IS NOT NULL AND "resolved_by_id" IS NOT NULL AND "resolved_at" IS NOT NULL
    END
  ),
  ADD CONSTRAINT "BankMatchFinding_clean_match_stays_open" CHECK ("is_exception" OR "status" = 'OPEN'),
  ADD CONSTRAINT "BankMatchFinding_second_person" CHECK ("status" <> 'RESOLVED' OR "resolved_by_id" <> "raised_by_id");

-- A statement and its entries are never updated or deleted.
CREATE FUNCTION "fbeds_bank_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is immutable', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
CREATE TRIGGER "BankStatement_immutable" BEFORE UPDATE OR DELETE ON "BankStatement" FOR EACH ROW EXECUTE FUNCTION "fbeds_bank_immutable"();
CREATE TRIGGER "BankStatementEntry_immutable" BEFORE UPDATE OR DELETE ON "BankStatementEntry" FOR EACH ROW EXECUTE FUNCTION "fbeds_bank_immutable"();

-- A finding is never deleted; only an OPEN exception may move to RESOLVED, and what the bank and the books said never changes.
CREATE FUNCTION "fbeds_bank_finding_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'BankMatchFinding is never deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."status" <> 'OPEN' THEN
    RAISE EXCEPTION 'A resolved BankMatchFinding is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."tenant_id" <> OLD."tenant_id" OR NEW."statement_id" <> OLD."statement_id" OR NEW."finding_key" <> OLD."finding_key"
     OR NEW."entry_id" IS DISTINCT FROM OLD."entry_id" OR NEW."type" <> OLD."type" OR NEW."is_exception" <> OLD."is_exception" OR NEW."currency" <> OLD."currency"
     OR NEW."bank_minor" IS DISTINCT FROM OLD."bank_minor" OR NEW."expected_minor" IS DISTINCT FROM OLD."expected_minor" OR NEW."variance_minor" IS DISTINCT FROM OLD."variance_minor"
     OR NEW."expected_kind" IS DISTINCT FROM OLD."expected_kind" OR NEW."expected_id" IS DISTINCT FROM OLD."expected_id"
     OR NEW."raised_by_id" <> OLD."raised_by_id" OR NEW."created_at" <> OLD."created_at" THEN
    RAISE EXCEPTION 'BankMatchFinding facts are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "BankMatchFinding_guard" BEFORE UPDATE OR DELETE ON "BankMatchFinding" FOR EACH ROW EXECUTE FUNCTION "fbeds_bank_finding_guard"();

-- Row-level security
ALTER TABLE "BankStatement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BankStatement" FORCE ROW LEVEL SECURITY;
CREATE POLICY "BankStatement_tenant_isolation" ON "BankStatement" USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());
ALTER TABLE "BankStatementEntry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BankStatementEntry" FORCE ROW LEVEL SECURITY;
CREATE POLICY "BankStatementEntry_tenant_isolation" ON "BankStatementEntry" USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());
ALTER TABLE "BankMatchFinding" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BankMatchFinding" FORCE ROW LEVEL SECURITY;
CREATE POLICY "BankMatchFinding_tenant_isolation" ON "BankMatchFinding" USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());

-- The funding receipts a bank statement is matched against (ADR 0093). The narrow reconciliation role holds no grant on "FundingReceipt" (not even a column grant), so it reads this
-- function instead: reference, amount, currency, value date and status only, for the CURRENT tenant only (the filter is explicit because a SECURITY DEFINER function runs as its owner).
-- No payer name, notes or compliance data leave the table. EXECUTE is granted by the reconciliation role provisioning, not here.
CREATE FUNCTION "fbeds_bank_expected_receipts"(p_from DATE, p_to DATE, p_limit INTEGER) RETURNS TABLE ("id" TEXT, "currency" CHAR(3), "amount_minor" BIGINT, "bank_reference" TEXT, "value_date" DATE, "status" TEXT) AS $$
  SELECT f."id", f."currency", f."amount_minor", f."bank_reference", f."value_date", f."status"::text
    FROM "FundingReceipt" f
   WHERE f."tenant_id" = "fbeds_current_tenant_id"() AND f."status" IN ('DECLARED', 'VERIFIED', 'POSTED') AND f."value_date" BETWEEN p_from AND p_to
   ORDER BY f."value_date", f."id"
   LIMIT p_limit
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION "fbeds_bank_expected_receipts"(DATE, DATE, INTEGER) FROM PUBLIC;
