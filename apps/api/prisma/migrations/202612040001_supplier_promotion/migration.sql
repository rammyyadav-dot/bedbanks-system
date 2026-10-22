-- ADR 0084: evidence and system audit for promoting ingested observations into contracted inventory.
--
-- SupplierPromotionRun                    append-only record of one promotion: status (APPLIED | HELD | NOTHING_TO_PROMOTE), counts, a capped summary of reason codes. No payload content.
--                                         HELD is a batch the guard stopped; nothing was written for it.
-- fbeds_is_supplier_promotion_role()      true when the session user is a member of the NOLOGIN group `fbeds_promote` (same shape as ADR 0076 and 0079).
-- Policy "AuditEvent_supplier_promotion_system_insert"   admits exactly: that role, the current tenant, actor SYSTEM, no user, entity_type 'supplier_promotion_run', and the actions
--                                         supplier.promotion.applied | held | nothing.
--
-- No grant to any role is made here: the group and login are provisioned by the owner tool (apps/api/src/database/supplier-promotion-role.ts). Row-level security is ENABLED and FORCED;
-- tenant_id leads every index; the foreign key into Supplier is composite. No money columns.
--
-- Rollback (forward migration; reviewed before use; only while no promotion runs; it discards promotion evidence, the rates and availability already written stay):
--   DROP POLICY "AuditEvent_supplier_promotion_system_insert" ON "AuditEvent"; DROP FUNCTION "fbeds_is_supplier_promotion_role"();
--   DROP TABLE "SupplierPromotionRun"; DROP FUNCTION "fbeds_supplier_promotion_run_immutable"(); DROP TYPE "SupplierPromotionStatus";

-- CreateEnum
CREATE TYPE "SupplierPromotionStatus" AS ENUM ('APPLIED', 'HELD', 'NOTHING_TO_PROMOTE');

-- CreateTable
CREATE TABLE "SupplierPromotionRun" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "supplier_id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "profile_key" TEXT NOT NULL,
    "status" "SupplierPromotionStatus" NOT NULL,
    "rates_considered" INTEGER NOT NULL,
    "rates_promoted" INTEGER NOT NULL,
    "stock_considered" INTEGER NOT NULL,
    "nights_promoted" INTEGER NOT NULL,
    "pool_nights_promoted" INTEGER NOT NULL,
    "nights_closed" INTEGER NOT NULL,
    "summary" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplierPromotionRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SupplierPromotionRun_tenant_id_status_created_at_idx" ON "SupplierPromotionRun"("tenant_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierPromotionRun_tenant_id_supplier_id_idempotency_key_key" ON "SupplierPromotionRun"("tenant_id", "supplier_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "SupplierPromotionRun" ADD CONSTRAINT "SupplierPromotionRun_tenant_id_supplier_id_fkey" FOREIGN KEY ("tenant_id", "supplier_id") REFERENCES "Supplier"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Integrity beyond Prisma
ALTER TABLE "SupplierPromotionRun"
  ADD CONSTRAINT "SupplierPromotionRun_key_format" CHECK ("idempotency_key" ~ '^[A-Za-z0-9_-]{8,128}$'),
  ADD CONSTRAINT "SupplierPromotionRun_profile_format" CHECK ("profile_key" ~ '^[a-z][a-z0-9-]{2,62}$'),
  ADD CONSTRAINT "SupplierPromotionRun_counts" CHECK ("rates_considered" >= 0 AND "rates_promoted" >= 0 AND "stock_considered" >= 0 AND "nights_promoted" >= 0 AND "pool_nights_promoted" >= 0 AND "nights_closed" >= 0 AND "rates_promoted" <= "rates_considered"),
  ADD CONSTRAINT "SupplierPromotionRun_held_writes_nothing" CHECK ("status" = 'APPLIED' OR ("rates_promoted" = 0 AND "nights_promoted" = 0 AND "pool_nights_promoted" = 0 AND "nights_closed" = 0)),
  ADD CONSTRAINT "SupplierPromotionRun_summary_object" CHECK (jsonb_typeof("summary") = 'object' AND pg_column_size("summary") <= 8192);

-- A run is evidence: never updated, and deleted only by the owner-governed erasure (fbeds.ingest_erasure, as for ingestion runs).
CREATE FUNCTION "fbeds_supplier_promotion_run_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('fbeds.ingest_erasure', true) = 'on' THEN RETURN OLD; END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
CREATE TRIGGER "SupplierPromotionRun_immutable" BEFORE UPDATE OR DELETE ON "SupplierPromotionRun" FOR EACH ROW EXECUTE FUNCTION "fbeds_supplier_promotion_run_immutable"();

-- Row-level security
ALTER TABLE "SupplierPromotionRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SupplierPromotionRun" FORCE ROW LEVEL SECURITY;
CREATE POLICY "SupplierPromotionRun_tenant_isolation" ON "SupplierPromotionRun" USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());

CREATE FUNCTION "fbeds_is_supplier_promotion_role"()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM pg_roles r
     WHERE r.rolname = 'fbeds_promote'
       AND pg_has_role(current_user, r.oid, 'MEMBER')
  )
$$ LANGUAGE SQL STABLE;

CREATE POLICY "AuditEvent_supplier_promotion_system_insert" ON "AuditEvent"
  FOR INSERT WITH CHECK (
    "fbeds_is_supplier_promotion_role"()
    AND "tenant_id" = "fbeds_current_tenant_id"()
    AND "actor_type" = 'SYSTEM'
    AND "user_id" IS NULL
    AND "action" IN ('supplier.promotion.applied', 'supplier.promotion.held', 'supplier.promotion.nothing')
    AND "entity_type" = 'supplier_promotion_run'
  );
