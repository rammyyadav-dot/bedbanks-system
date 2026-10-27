-- ADR 0102: a general-ledger chart of accounts per tenant, and a versioned mapping from ledger movement categories to account pairs, so a balanced journal can be derived from the agency
-- ledger for the accountants (operating model R8).
--
-- GlAccount          code, name and type never change (trigger, every role); only "active" can be switched off. type is one of ASSET, LIABILITY, EQUITY, REVENUE, EXPENSE.
-- GlCategoryMapping  append-only (trigger, every role): a change is a new row with the next version; the highest version of a category is current. Both accounts belong to the same tenant
--                    (composite foreign keys) and must differ (CHECK). Nothing is posted to the agency ledger and no balance changes.
-- Permission         finance.chart.manage, granted to no role here.
--
-- No table is granted to any role: the service runs on the API connection and both tables are classified finance-gated in the runtime-role contract. Row-level security is ENABLED and
-- FORCED. tenant_id leads every index. The Prisma-generated indexes on the two account columns exist so the composite foreign keys do not seq-scan the mapping table.
--
-- Rollback (forward migration; reviewed before use; it discards the chart and mapping history, so export them first):
--   DROP TABLE "GlCategoryMapping"; DROP TABLE "GlAccount"; DROP FUNCTION "fbeds_gl_account_guard"(); DROP FUNCTION "fbeds_gl_mapping_guard"();
--   DELETE FROM "Permission" WHERE key = 'finance.chart.manage';

-- CreateTable
CREATE TABLE "GlAccount" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GlAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GlCategoryMapping" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "debit_account_id" TEXT NOT NULL,
    "credit_account_id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GlCategoryMapping_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GlAccount_tenant_id_code_key" ON "GlAccount"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "GlAccount_tenant_id_id_key" ON "GlAccount"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "GlCategoryMapping_tenant_id_category_version_key" ON "GlCategoryMapping"("tenant_id", "category", "version");

-- CreateIndex
CREATE INDEX "GlCategoryMapping_tenant_id_debit_account_id_idx" ON "GlCategoryMapping"("tenant_id", "debit_account_id");

-- CreateIndex
CREATE INDEX "GlCategoryMapping_tenant_id_credit_account_id_idx" ON "GlCategoryMapping"("tenant_id", "credit_account_id");

-- AddForeignKey
ALTER TABLE "GlAccount" ADD CONSTRAINT "GlAccount_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GlCategoryMapping" ADD CONSTRAINT "GlCategoryMapping_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GlCategoryMapping" ADD CONSTRAINT "GlCategoryMapping_tenant_id_debit_account_id_fkey" FOREIGN KEY ("tenant_id", "debit_account_id") REFERENCES "GlAccount"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GlCategoryMapping" ADD CONSTRAINT "GlCategoryMapping_tenant_id_credit_account_id_fkey" FOREIGN KEY ("tenant_id", "credit_account_id") REFERENCES "GlAccount"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Integrity beyond Prisma
ALTER TABLE "GlAccount"
  ADD CONSTRAINT "GlAccount_code" CHECK ("code" ~ '^[0-9A-Za-z][0-9A-Za-z._-]{0,15}$'),
  ADD CONSTRAINT "GlAccount_name" CHECK (char_length("name") BETWEEN 2 AND 120),
  ADD CONSTRAINT "GlAccount_type" CHECK ("type" IN ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'));
ALTER TABLE "GlCategoryMapping"
  ADD CONSTRAINT "GlCategoryMapping_category" CHECK ("category" IN ('FUNDING_RECEIVED', 'PAYMENT_REVERSAL', 'OTHER_CREDIT', 'COMMISSION_PAYOUT', 'RESERVATION', 'BOOKING_CHARGE', 'BOOKING_REFUND', 'CREDIT_NOTE', 'ADJUSTMENT')),
  ADD CONSTRAINT "GlCategoryMapping_version" CHECK ("version" >= 1),
  ADD CONSTRAINT "GlCategoryMapping_accounts_differ" CHECK ("debit_account_id" <> "credit_account_id");

-- An account's identity never changes and it is never deleted; only "active" may change.
CREATE FUNCTION "fbeds_gl_account_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'GlAccount is never deleted; deactivate it' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF NEW."tenant_id" <> OLD."tenant_id" OR NEW."code" <> OLD."code" OR NEW."name" <> OLD."name" OR NEW."type" <> OLD."type" OR NEW."created_by_id" <> OLD."created_by_id" OR NEW."created_at" <> OLD."created_at" THEN
    RAISE EXCEPTION 'GlAccount code, name and type are immutable; only active can change' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "GlAccount_guard" BEFORE UPDATE OR DELETE ON "GlAccount" FOR EACH ROW EXECUTE FUNCTION "fbeds_gl_account_guard"();

-- A mapping version is never changed or deleted.
CREATE FUNCTION "fbeds_gl_mapping_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'GlCategoryMapping is append-only; add a new version' USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
CREATE TRIGGER "GlCategoryMapping_guard" BEFORE UPDATE OR DELETE ON "GlCategoryMapping" FOR EACH ROW EXECUTE FUNCTION "fbeds_gl_mapping_guard"();

-- Row-level security
ALTER TABLE "GlAccount" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GlAccount" FORCE ROW LEVEL SECURITY;
CREATE POLICY "GlAccount_tenant_isolation" ON "GlAccount" USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());
ALTER TABLE "GlCategoryMapping" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "GlCategoryMapping" FORCE ROW LEVEL SECURITY;
CREATE POLICY "GlCategoryMapping_tenant_isolation" ON "GlCategoryMapping" USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());

-- Permission key enforced by the chart API. Granted to no role here.
INSERT INTO "Permission" ("id", "key", "description") VALUES
  (gen_random_uuid()::text, 'finance.chart.manage', 'Set up the general-ledger chart of accounts and the mapping of ledger movements to accounts (every change is kept as history)')
ON CONFLICT ("key") DO NOTHING;
