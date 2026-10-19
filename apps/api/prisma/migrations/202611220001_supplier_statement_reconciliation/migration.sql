-- ADR 0070: supplier statement reconciliation and the dispute queue.
--
-- SupplierStatement            a supplier settlement statement, imported once. IMMUTABLE (trigger). content_sha256 covers the canonical lines so the same statement
--                              cannot be imported twice under another number; (tenant, supplier, statement_ref) and (tenant, request_id) are unique (idempotent import).
-- SupplierStatementLine        its lines: a positive magnitude in integer minor units plus ISO-4217 currency; kind CHARGE | CREDIT | SURCHARGE gives the direction. IMMUTABLE.
-- ReconciliationRun            the job queue. The API inserts QUEUED; the worker claims with a conditional update (QUEUED -> RUNNING), re-drives a stale claim, and stops
--                              after three attempts (FAILED, error_code only - never a raw message).
-- ReconciliationFinding        one row per statement line (and per ledger-side gap): the match result plus the exception workflow OPEN -> (DISPUTED | PENDING_APPROVAL) -> RESOLVED.
--                              (tenant, statement, finding_key) is unique so a re-run updates rather than duplicates. A RESOLVED row never changes again.
-- ReconciliationDecision       append-only history of every state change of a finding.
-- fbeds_reconciliation_due_tenants()  SECURITY DEFINER, returns tenant ids only that have a QUEUED or stale RUNNING run (the worker needs no cross-tenant read).
--                              EXECUTE is granted by the reconciliation role provisioning, not here (same rule as fbeds_compliance_due_scopes).
--
-- Nothing here posts to "LedgerEntry" or "Wallet", and no table is granted to any role: this is a finance-gated privileged path (ADR 0032), like "FundingReceipt".
-- Row-level security is ENABLED and FORCED on all five tables. Every foreign key that reaches a tenant-owned table is composite (tenant_id, id), so a row can only
-- reference rows of its own tenant. Tenant-index review: tenant_id leads every new index; the only non-tenant-led unique key is (statement_id, line_no), which is
-- itself tenant-safe because statement_id is only reachable through the composite foreign key.
-- Money: BIGINT minor units + CHAR(3) currency; variance_minor must equal statement_minor - ledger_minor (CHECK). No floating point and no currency conversion.
--
-- Rollback (forward migration; reviewed before use; only while the worker is stopped; it discards imported statements and the dispute history, so export them first):
--   DROP FUNCTION "fbeds_reconciliation_due_tenants"();
--   DROP TABLE "ReconciliationDecision"; DROP TABLE "ReconciliationFinding"; DROP TABLE "ReconciliationRun"; DROP TABLE "SupplierStatementLine"; DROP TABLE "SupplierStatement";
--   DROP FUNCTION "fbeds_reconciliation_immutable"(); DROP FUNCTION "fbeds_reconciliation_finding_guard"();
--   DROP TYPE "ReconFindingType"; DROP TYPE "ReconExceptionStatus"; DROP TYPE "ReconRunStatus"; DROP TYPE "StatementLineKind";
--   DELETE FROM "Permission" WHERE key IN ('finance.reconcile.run', 'finance.reconcile.resolve');

-- CreateEnum
CREATE TYPE "StatementLineKind" AS ENUM ('CHARGE', 'CREDIT', 'SURCHARGE');

-- CreateEnum
CREATE TYPE "ReconRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "ReconExceptionStatus" AS ENUM ('OPEN', 'DISPUTED', 'PENDING_APPROVAL', 'RESOLVED');

-- CreateEnum
CREATE TYPE "ReconFindingType" AS ENUM ('MATCHED', 'ROUNDING_VARIANCE', 'AMOUNT_OVERCHARGE', 'AMOUNT_UNDERCHARGE', 'CURRENCY_MISMATCH', 'UNINVOICED_SURCHARGE', 'UNMATCHED_LINE', 'AMBIGUOUS_REFERENCE', 'DUPLICATE_LINE', 'NET_UNKNOWN', 'CHARGE_ON_CANCELLED', 'CREDIT_MATCHED', 'CREDIT_VARIANCE', 'CREDIT_WITHOUT_CANCELLATION', 'CREDIT_AMOUNT_UNKNOWN', 'MISSING_FROM_STATEMENT', 'CREDIT_NOT_RECEIVED');

-- CreateTable
CREATE TABLE "SupplierStatement" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "supplier_id" TEXT NOT NULL,
    "statement_ref" TEXT NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "line_count" INTEGER NOT NULL,
    "content_sha256" CHAR(64) NOT NULL,
    "request_id" TEXT NOT NULL,
    "imported_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplierStatement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierStatementLine" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "statement_id" TEXT NOT NULL,
    "line_no" INTEGER NOT NULL,
    "reference" TEXT NOT NULL,
    "kind" "StatementLineKind" NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplierStatementLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReconciliationRun" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "statement_id" TEXT NOT NULL,
    "status" "ReconRunStatus" NOT NULL DEFAULT 'QUEUED',
    "request_id" TEXT NOT NULL,
    "requested_by_id" TEXT NOT NULL,
    "rounding_tolerance_minor" BIGINT NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "claimed_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "error_code" TEXT,
    "matched_count" INTEGER,
    "exception_count" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReconciliationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReconciliationFinding" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "statement_id" TEXT NOT NULL,
    "supplier_id" TEXT NOT NULL,
    "finding_key" TEXT NOT NULL,
    "line_id" TEXT,
    "booking_id" TEXT,
    "type" "ReconFindingType" NOT NULL,
    "rule" TEXT NOT NULL,
    "is_exception" BOOLEAN NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "statement_minor" BIGINT,
    "ledger_minor" BIGINT,
    "variance_minor" BIGINT,
    "status" "ReconExceptionStatus" NOT NULL DEFAULT 'OPEN',
    "proposed_action" TEXT,
    "proposed_by_id" TEXT,
    "proposed_reason" TEXT,
    "second_approval_required" BOOLEAN NOT NULL DEFAULT false,
    "resolution" TEXT,
    "resolved_by_id" TEXT,
    "resolved_at" TIMESTAMP(3),
    "last_run_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReconciliationFinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReconciliationDecision" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "finding_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "from_status" "ReconExceptionStatus" NOT NULL,
    "to_status" "ReconExceptionStatus" NOT NULL,
    "resolution" TEXT,
    "reason" TEXT,
    "actor_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReconciliationDecision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SupplierStatement_tenant_id_supplier_id_period_end_idx" ON "SupplierStatement"("tenant_id", "supplier_id", "period_end");

-- CreateIndex
CREATE INDEX "SupplierStatement_tenant_id_created_at_idx" ON "SupplierStatement"("tenant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierStatement_tenant_id_id_key" ON "SupplierStatement"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierStatement_tenant_id_request_id_key" ON "SupplierStatement"("tenant_id", "request_id");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierStatement_tenant_id_supplier_id_statement_ref_key" ON "SupplierStatement"("tenant_id", "supplier_id", "statement_ref");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierStatement_tenant_id_supplier_id_content_sha256_key" ON "SupplierStatement"("tenant_id", "supplier_id", "content_sha256");

-- CreateIndex
CREATE INDEX "SupplierStatementLine_tenant_id_statement_id_idx" ON "SupplierStatementLine"("tenant_id", "statement_id");

-- CreateIndex
CREATE INDEX "SupplierStatementLine_tenant_id_reference_idx" ON "SupplierStatementLine"("tenant_id", "reference");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierStatementLine_tenant_id_id_key" ON "SupplierStatementLine"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierStatementLine_statement_id_line_no_key" ON "SupplierStatementLine"("statement_id", "line_no");

-- CreateIndex
CREATE INDEX "ReconciliationRun_tenant_id_status_created_at_idx" ON "ReconciliationRun"("tenant_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "ReconciliationRun_tenant_id_statement_id_created_at_idx" ON "ReconciliationRun"("tenant_id", "statement_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "ReconciliationRun_tenant_id_request_id_key" ON "ReconciliationRun"("tenant_id", "request_id");

-- CreateIndex
CREATE INDEX "ReconciliationFinding_tenant_id_is_exception_status_created_idx" ON "ReconciliationFinding"("tenant_id", "is_exception", "status", "created_at");

-- CreateIndex
CREATE INDEX "ReconciliationFinding_tenant_id_statement_id_status_idx" ON "ReconciliationFinding"("tenant_id", "statement_id", "status");

-- CreateIndex
CREATE INDEX "ReconciliationFinding_tenant_id_booking_id_idx" ON "ReconciliationFinding"("tenant_id", "booking_id");

-- CreateIndex
CREATE INDEX "ReconciliationFinding_tenant_id_supplier_id_status_idx" ON "ReconciliationFinding"("tenant_id", "supplier_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ReconciliationFinding_tenant_id_id_key" ON "ReconciliationFinding"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ReconciliationFinding_tenant_id_statement_id_finding_key_key" ON "ReconciliationFinding"("tenant_id", "statement_id", "finding_key");

-- CreateIndex
CREATE INDEX "ReconciliationDecision_tenant_id_finding_id_created_at_idx" ON "ReconciliationDecision"("tenant_id", "finding_id", "created_at");

-- AddForeignKey
ALTER TABLE "SupplierStatement" ADD CONSTRAINT "SupplierStatement_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierStatement" ADD CONSTRAINT "SupplierStatement_tenant_id_supplier_id_fkey" FOREIGN KEY ("tenant_id", "supplier_id") REFERENCES "Supplier"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierStatementLine" ADD CONSTRAINT "SupplierStatementLine_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierStatementLine" ADD CONSTRAINT "SupplierStatementLine_tenant_id_statement_id_fkey" FOREIGN KEY ("tenant_id", "statement_id") REFERENCES "SupplierStatement"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationRun" ADD CONSTRAINT "ReconciliationRun_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationRun" ADD CONSTRAINT "ReconciliationRun_tenant_id_statement_id_fkey" FOREIGN KEY ("tenant_id", "statement_id") REFERENCES "SupplierStatement"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationFinding" ADD CONSTRAINT "ReconciliationFinding_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationFinding" ADD CONSTRAINT "ReconciliationFinding_tenant_id_statement_id_fkey" FOREIGN KEY ("tenant_id", "statement_id") REFERENCES "SupplierStatement"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationFinding" ADD CONSTRAINT "ReconciliationFinding_tenant_id_supplier_id_fkey" FOREIGN KEY ("tenant_id", "supplier_id") REFERENCES "Supplier"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationFinding" ADD CONSTRAINT "ReconciliationFinding_tenant_id_booking_id_fkey" FOREIGN KEY ("tenant_id", "booking_id") REFERENCES "Booking"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationDecision" ADD CONSTRAINT "ReconciliationDecision_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationDecision" ADD CONSTRAINT "ReconciliationDecision_tenant_id_finding_id_fkey" FOREIGN KEY ("tenant_id", "finding_id") REFERENCES "ReconciliationFinding"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Integrity beyond Prisma
ALTER TABLE "SupplierStatement"
  ADD CONSTRAINT "SupplierStatement_ref" CHECK (char_length("statement_ref") BETWEEN 1 AND 80 AND "statement_ref" = btrim("statement_ref")),
  ADD CONSTRAINT "SupplierStatement_period" CHECK ("period_start" <= "period_end"),
  ADD CONSTRAINT "SupplierStatement_line_count" CHECK ("line_count" BETWEEN 1 AND 5000),
  ADD CONSTRAINT "SupplierStatement_sha_format" CHECK ("content_sha256" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "SupplierStatement_request_id" CHECK (char_length("request_id") BETWEEN 8 AND 80);

ALTER TABLE "SupplierStatementLine"
  ADD CONSTRAINT "SupplierStatementLine_line_no" CHECK ("line_no" >= 1),
  ADD CONSTRAINT "SupplierStatementLine_reference" CHECK (char_length("reference") BETWEEN 1 AND 80 AND "reference" = btrim("reference")),
  ADD CONSTRAINT "SupplierStatementLine_amount_positive" CHECK ("amount_minor" > 0),
  ADD CONSTRAINT "SupplierStatementLine_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$');

ALTER TABLE "ReconciliationRun"
  ADD CONSTRAINT "ReconciliationRun_request_id" CHECK (char_length("request_id") BETWEEN 8 AND 80),
  ADD CONSTRAINT "ReconciliationRun_tolerance" CHECK ("rounding_tolerance_minor" BETWEEN 0 AND 1000),
  ADD CONSTRAINT "ReconciliationRun_attempts" CHECK ("attempts" BETWEEN 0 AND 4),
  ADD CONSTRAINT "ReconciliationRun_status_facts" CHECK (
    CASE "status"
      WHEN 'QUEUED' THEN "finished_at" IS NULL
      WHEN 'RUNNING' THEN "claimed_at" IS NOT NULL AND "finished_at" IS NULL
      WHEN 'SUCCEEDED' THEN "finished_at" IS NOT NULL AND "matched_count" IS NOT NULL AND "exception_count" IS NOT NULL AND "error_code" IS NULL
      WHEN 'FAILED' THEN "finished_at" IS NOT NULL AND "error_code" IS NOT NULL
    END
  );

ALTER TABLE "ReconciliationFinding"
  ADD CONSTRAINT "ReconciliationFinding_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "ReconciliationFinding_is_exception" CHECK ("is_exception" = ("type" NOT IN ('MATCHED', 'CREDIT_MATCHED'))),
  ADD CONSTRAINT "ReconciliationFinding_variance" CHECK ("variance_minor" IS NULL OR ("statement_minor" IS NOT NULL AND "ledger_minor" IS NOT NULL AND "variance_minor" = "statement_minor" - "ledger_minor")),
  ADD CONSTRAINT "ReconciliationFinding_clean_is_closed" CHECK ("is_exception" OR "status" = 'RESOLVED'),
  ADD CONSTRAINT "ReconciliationFinding_proposed_action" CHECK ("proposed_action" IS NULL OR "proposed_action" IN ('ACCEPT_STATEMENT', 'KEEP_LEDGER_AND_DISPUTE', 'WRITE_OFF_VARIANCE', 'REJECT_STATEMENT_LINE', 'ACKNOWLEDGE')),
  ADD CONSTRAINT "ReconciliationFinding_resolution" CHECK ("resolution" IS NULL OR "resolution" IN ('ACCEPT_STATEMENT', 'KEEP_LEDGER_AND_DISPUTE', 'WRITE_OFF_VARIANCE', 'REJECT_STATEMENT_LINE', 'ACKNOWLEDGE', 'AUTO_MATCHED')),
  ADD CONSTRAINT "ReconciliationFinding_reason" CHECK ("proposed_reason" IS NULL OR char_length("proposed_reason") BETWEEN 3 AND 500),
  ADD CONSTRAINT "ReconciliationFinding_second_person" CHECK (NOT "second_approval_required" OR "resolved_by_id" IS NULL OR "proposed_by_id" IS NULL OR "resolved_by_id" <> "proposed_by_id"),
  ADD CONSTRAINT "ReconciliationFinding_status_facts" CHECK (
    CASE "status"
      WHEN 'OPEN' THEN "proposed_action" IS NULL AND "proposed_by_id" IS NULL AND "resolution" IS NULL AND "resolved_by_id" IS NULL AND "resolved_at" IS NULL
      WHEN 'DISPUTED' THEN "proposed_action" = 'KEEP_LEDGER_AND_DISPUTE' AND "proposed_by_id" IS NOT NULL AND "resolution" IS NULL AND "resolved_at" IS NULL
      WHEN 'PENDING_APPROVAL' THEN "proposed_action" IS NOT NULL AND "proposed_by_id" IS NOT NULL AND "second_approval_required" AND "resolution" IS NULL AND "resolved_by_id" IS NULL AND "resolved_at" IS NULL
      WHEN 'RESOLVED' THEN "resolved_at" IS NOT NULL AND (NOT "is_exception" OR ("resolution" IS NOT NULL AND ("resolved_by_id" IS NOT NULL OR "resolution" = 'AUTO_MATCHED')))
    END
  );

ALTER TABLE "ReconciliationDecision"
  ADD CONSTRAINT "ReconciliationDecision_reason" CHECK ("reason" IS NULL OR char_length("reason") BETWEEN 3 AND 500);

-- Immutability: statements, their lines and the decision history never change.
CREATE FUNCTION "fbeds_reconciliation_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
CREATE TRIGGER "SupplierStatement_immutable" BEFORE UPDATE OR DELETE ON "SupplierStatement" FOR EACH ROW EXECUTE FUNCTION "fbeds_reconciliation_immutable"();
CREATE TRIGGER "SupplierStatementLine_immutable" BEFORE UPDATE OR DELETE ON "SupplierStatementLine" FOR EACH ROW EXECUTE FUNCTION "fbeds_reconciliation_immutable"();
CREATE TRIGGER "ReconciliationDecision_immutable" BEFORE UPDATE OR DELETE ON "ReconciliationDecision" FOR EACH ROW EXECUTE FUNCTION "fbeds_reconciliation_immutable"();

-- A finding keeps its identity for life, is never deleted, and a RESOLVED finding never changes again.
CREATE FUNCTION "fbeds_reconciliation_finding_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ReconciliationFinding is never deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."status" = 'RESOLVED' THEN
    RAISE EXCEPTION 'A resolved ReconciliationFinding is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."tenant_id" <> OLD."tenant_id" OR NEW."statement_id" <> OLD."statement_id" OR NEW."supplier_id" <> OLD."supplier_id"
     OR NEW."finding_key" <> OLD."finding_key" OR NEW."created_at" <> OLD."created_at" THEN
    RAISE EXCEPTION 'ReconciliationFinding identity is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ReconciliationFinding_guard" BEFORE UPDATE OR DELETE ON "ReconciliationFinding" FOR EACH ROW EXECUTE FUNCTION "fbeds_reconciliation_finding_guard"();

-- Row-level security
ALTER TABLE "SupplierStatement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SupplierStatement" FORCE ROW LEVEL SECURITY;
CREATE POLICY "SupplierStatement_tenant_isolation" ON "SupplierStatement" USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());
ALTER TABLE "SupplierStatementLine" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SupplierStatementLine" FORCE ROW LEVEL SECURITY;
CREATE POLICY "SupplierStatementLine_tenant_isolation" ON "SupplierStatementLine" USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());
ALTER TABLE "ReconciliationRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReconciliationRun" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ReconciliationRun_tenant_isolation" ON "ReconciliationRun" USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());
ALTER TABLE "ReconciliationFinding" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReconciliationFinding" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ReconciliationFinding_tenant_isolation" ON "ReconciliationFinding" USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());
ALTER TABLE "ReconciliationDecision" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ReconciliationDecision" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ReconciliationDecision_tenant_isolation" ON "ReconciliationDecision" USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());

-- Tenants with work for the worker. SECURITY DEFINER so the worker needs no cross-tenant read; it returns tenant ids only.
-- A claim older than ten minutes is stale. Run the CI check that this returns a tenant's row under the migration role (the definer must bypass FORCE RLS, as for the compliance functions).
CREATE FUNCTION "fbeds_reconciliation_due_tenants"() RETURNS SETOF TEXT AS $$
  SELECT DISTINCT r."tenant_id" FROM "ReconciliationRun" r
   WHERE r."status" = 'QUEUED' OR (r."status" = 'RUNNING' AND r."claimed_at" < now() - interval '10 minutes')
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION "fbeds_reconciliation_due_tenants"() FROM PUBLIC;

-- Permission keys enforced by the reconciliation API. Granted to no role here.
INSERT INTO "Permission" ("id", "key", "description") VALUES
  (gen_random_uuid()::text, 'finance.reconcile.run', 'Import a supplier settlement statement and run its matching against the ledger'),
  (gen_random_uuid()::text, 'finance.reconcile.resolve', 'Decide reconciliation exceptions (a second person above the threshold)')
ON CONFLICT ("key") DO NOTHING;
