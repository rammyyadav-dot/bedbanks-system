-- ADR 0078: supplier payment terms and due dates.
--
-- SupplierPaymentTerms   a supplier's contracted terms: pay `days` (0 to 365) after the check-out, the check-in or the confirmation of the booking. APPEND-ONLY (trigger): the latest
--                        row for a supplier is current and every earlier row stays as history, so a change of terms is never a silent edit. A supplier with no row has no due dates.
-- Permission             finance.terms.manage, granted to no role here.
--
-- No table is granted to any role: the consumer's narrow role (fbeds_finpost_ops) gets SELECT and INSERT, and column-level SELECT of Booking.check_in and check_out, from its
-- provisioning (apps/api/src/database/finance-posting-role.ts). Row-level security is ENABLED and FORCED. The supplier reference is composite (tenant_id, id). tenant_id leads the index.
--
-- Rollback (forward migration; reviewed before use; it discards the history of agreed terms, so export it first):
--   DROP TABLE "SupplierPaymentTerms"; DROP FUNCTION "fbeds_supplier_terms_immutable"(); DROP TYPE "SupplierTermsBasis";
--   DELETE FROM "Permission" WHERE key = 'finance.terms.manage';

-- CreateEnum
CREATE TYPE "SupplierTermsBasis" AS ENUM ('CHECK_OUT', 'CHECK_IN', 'CONFIRMATION');

-- CreateTable
CREATE TABLE "SupplierPaymentTerms" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "supplier_id" TEXT NOT NULL,
    "basis" "SupplierTermsBasis" NOT NULL,
    "days" INTEGER NOT NULL,
    "note" TEXT,
    "set_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SupplierPaymentTerms_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SupplierPaymentTerms_tenant_id_supplier_id_created_at_idx" ON "SupplierPaymentTerms"("tenant_id", "supplier_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierPaymentTerms_tenant_id_id_key" ON "SupplierPaymentTerms"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "SupplierPaymentTerms" ADD CONSTRAINT "SupplierPaymentTerms_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierPaymentTerms" ADD CONSTRAINT "SupplierPaymentTerms_tenant_id_supplier_id_fkey" FOREIGN KEY ("tenant_id", "supplier_id") REFERENCES "Supplier"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "SupplierPaymentTerms"
  ADD CONSTRAINT "SupplierPaymentTerms_days" CHECK ("days" BETWEEN 0 AND 365),
  ADD CONSTRAINT "SupplierPaymentTerms_note" CHECK ("note" IS NULL OR char_length("note") BETWEEN 1 AND 500);

CREATE FUNCTION "fbeds_supplier_terms_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
CREATE TRIGGER "SupplierPaymentTerms_immutable" BEFORE UPDATE OR DELETE ON "SupplierPaymentTerms" FOR EACH ROW EXECUTE FUNCTION "fbeds_supplier_terms_immutable"();

ALTER TABLE "SupplierPaymentTerms" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SupplierPaymentTerms" FORCE ROW LEVEL SECURITY;
CREATE POLICY "SupplierPaymentTerms_tenant_isolation" ON "SupplierPaymentTerms" USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());

INSERT INTO "Permission" ("id", "key", "description") VALUES
  (gen_random_uuid()::text, 'finance.terms.manage', 'Set the payment terms agreed with a supplier (each change is kept as history)')
ON CONFLICT ("key") DO NOTHING;
