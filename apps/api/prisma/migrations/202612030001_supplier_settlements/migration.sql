-- ADR 0077: supplier settlements. A payment to a supplier, recorded against its posted payables (ADR 0076).
--
-- SupplierSettlement   PROPOSED by one person, APPROVED (recorded) or REJECTED by another. The system records that a payment was made outside it; it moves no money and posts nothing to
--                      the agency ledger. Integer minor units in the payable's currency, never converted. (tenant, supplier, payment_reference) is unique so the same payment cannot be recorded twice;
--                      (tenant, request_id) makes a proposal idempotent. An APPROVED settlement can never have been approved by its proposer (CHECK). Once APPROVED or REJECTED a row never changes
--                      and is never deleted (trigger).
-- Permissions          finance.settle.propose and finance.settle.approve, granted to no role here.
--
-- No table is granted to any role: the consumer's narrow role (fbeds_finpost_ops) gets SELECT, INSERT and UPDATE of the decision columns from its provisioning
-- (apps/api/src/database/finance-posting-role.ts). Row-level security is ENABLED and FORCED. The supplier reference is composite (tenant_id, id). tenant_id leads every new index.
--
-- Rollback (forward migration; reviewed before use; it discards the record of supplier payments, so export them first):
--   DROP TABLE "SupplierSettlement"; DROP FUNCTION "fbeds_supplier_settlement_guard"(); DROP TYPE "SupplierSettlementStatus";
--   DELETE FROM "Permission" WHERE key IN ('finance.settle.propose', 'finance.settle.approve');

-- CreateEnum
CREATE TYPE "SupplierSettlementStatus" AS ENUM ('PROPOSED', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "SupplierSettlement" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "supplier_id" TEXT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "paid_on" DATE NOT NULL,
    "payment_reference" TEXT NOT NULL,
    "note" TEXT,
    "status" "SupplierSettlementStatus" NOT NULL DEFAULT 'PROPOSED',
    "request_id" TEXT NOT NULL,
    "proposed_by_id" TEXT NOT NULL,
    "decided_by_id" TEXT,
    "decided_at" TIMESTAMP(3),
    "decision_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SupplierSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SupplierSettlement_tenant_id_status_created_at_idx" ON "SupplierSettlement"("tenant_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "SupplierSettlement_tenant_id_supplier_id_currency_status_idx" ON "SupplierSettlement"("tenant_id", "supplier_id", "currency", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierSettlement_tenant_id_id_key" ON "SupplierSettlement"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierSettlement_tenant_id_request_id_key" ON "SupplierSettlement"("tenant_id", "request_id");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierSettlement_tenant_id_supplier_id_payment_reference_key" ON "SupplierSettlement"("tenant_id", "supplier_id", "payment_reference");

-- AddForeignKey
ALTER TABLE "SupplierSettlement" ADD CONSTRAINT "SupplierSettlement_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierSettlement" ADD CONSTRAINT "SupplierSettlement_tenant_id_supplier_id_fkey" FOREIGN KEY ("tenant_id", "supplier_id") REFERENCES "Supplier"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Integrity beyond Prisma
ALTER TABLE "SupplierSettlement"
  ADD CONSTRAINT "SupplierSettlement_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "SupplierSettlement_amount_positive" CHECK ("amount_minor" > 0),
  ADD CONSTRAINT "SupplierSettlement_reference" CHECK (char_length("payment_reference") BETWEEN 3 AND 80 AND "payment_reference" = btrim("payment_reference")),
  ADD CONSTRAINT "SupplierSettlement_request_id" CHECK (char_length("request_id") BETWEEN 8 AND 80),
  ADD CONSTRAINT "SupplierSettlement_note" CHECK ("note" IS NULL OR char_length("note") BETWEEN 1 AND 500),
  ADD CONSTRAINT "SupplierSettlement_reason" CHECK ("decision_reason" IS NULL OR char_length("decision_reason") BETWEEN 3 AND 500),
  ADD CONSTRAINT "SupplierSettlement_paid_on_not_future" CHECK ("paid_on" <= (("created_at" AT TIME ZONE 'UTC')::date)),
  ADD CONSTRAINT "SupplierSettlement_status_facts" CHECK (
    CASE "status"
      WHEN 'PROPOSED' THEN "decided_by_id" IS NULL AND "decided_at" IS NULL AND "decision_reason" IS NULL
      WHEN 'APPROVED' THEN "decided_by_id" IS NOT NULL AND "decided_at" IS NOT NULL
      WHEN 'REJECTED' THEN "decided_by_id" IS NOT NULL AND "decided_at" IS NOT NULL AND "decision_reason" IS NOT NULL
    END
  ),
  ADD CONSTRAINT "SupplierSettlement_second_person" CHECK ("status" <> 'APPROVED' OR "decided_by_id" <> "proposed_by_id");

-- A settlement is never deleted; only a PROPOSED one may be updated (to a decision), and its identity and amount never change.
CREATE FUNCTION "fbeds_supplier_settlement_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'SupplierSettlement is never deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."status" <> 'PROPOSED' THEN
    RAISE EXCEPTION 'A decided SupplierSettlement is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."tenant_id" <> OLD."tenant_id" OR NEW."supplier_id" <> OLD."supplier_id" OR NEW."currency" <> OLD."currency" OR NEW."amount_minor" <> OLD."amount_minor"
     OR NEW."paid_on" <> OLD."paid_on" OR NEW."payment_reference" <> OLD."payment_reference" OR NEW."request_id" <> OLD."request_id"
     OR NEW."proposed_by_id" <> OLD."proposed_by_id" OR NEW."created_at" <> OLD."created_at" THEN
    RAISE EXCEPTION 'SupplierSettlement identity and amount are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "SupplierSettlement_guard" BEFORE UPDATE OR DELETE ON "SupplierSettlement" FOR EACH ROW EXECUTE FUNCTION "fbeds_supplier_settlement_guard"();

-- Row-level security
ALTER TABLE "SupplierSettlement" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SupplierSettlement" FORCE ROW LEVEL SECURITY;
CREATE POLICY "SupplierSettlement_tenant_isolation" ON "SupplierSettlement" USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());

-- Permission keys enforced by the settlement API. Granted to no role here.
INSERT INTO "Permission" ("id", "key", "description") VALUES
  (gen_random_uuid()::text, 'finance.settle.propose', 'Record a proposed payment to a supplier against its posted payables'),
  (gen_random_uuid()::text, 'finance.settle.approve', 'Approve or reject a proposed supplier payment (never the person who proposed it)')
ON CONFLICT ("key") DO NOTHING;
