-- ADR 0058 slice S10a: promotions on a rate plan.
--
-- A plan with no rows is priced exactly as today. A promotion is a percentage off every night (EARLY_BIRD, LAST_MINUTE, LONG_STAY) or the cheapest nights free
-- (FREE_NIGHTS). At most one promotion applies to a stay (the one that saves the most; ties to the lowest id); the evaluator, not this table, decides that.
--
-- Isolation: forced row-level security on tenant_id, like DailyRate and RatePlanGuestPrice. The runtime role reads it and never writes it: authoring is a
-- privileged supply path (ADR 0032).
--
-- Database rules, mirroring the service validator, so a bad promotion cannot exist whatever the application does:
--   * percent kinds: 1 to 9000 basis points (a fully free night is FREE_NIGHTS only), no free_nights;
--   * FREE_NIGHTS: no percentage, free_nights >= 1 and below min_nights, so the stay keeps a paid night;
--   * the lead and night fields each belong to one kind only; windows may not be inverted; names are 1 to 80 characters and unique per plan ignoring case.
--
-- Tenant-index review: reads are by (tenant_id, rate_plan_id), covered by the new index; the unique key covers (rate_plan_id, name_key).
--
-- Rollback (forward migration; reviewed before use):
--   DROP TABLE "RatePlanPromotion"; DROP TYPE "PromotionKind";

CREATE TYPE "PromotionKind" AS ENUM ('EARLY_BIRD', 'LAST_MINUTE', 'LONG_STAY', 'FREE_NIGHTS');

CREATE TABLE "RatePlanPromotion" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "rate_plan_id" TEXT NOT NULL,
  "kind" "PromotionKind" NOT NULL,
  "name" VARCHAR(80) NOT NULL,
  "name_key" VARCHAR(80) NOT NULL,
  "percent_bp" INTEGER,
  "min_lead_days" INTEGER,
  "max_lead_days" INTEGER,
  "min_nights" INTEGER,
  "free_nights" INTEGER,
  "book_from" DATE,
  "book_to" DATE,
  "stay_from" DATE,
  "stay_to" DATE,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RatePlanPromotion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RatePlanPromotion_rate_plan_id_fkey" FOREIGN KEY ("rate_plan_id") REFERENCES "RatePlan"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "RatePlanPromotion_shape_check" CHECK (
    char_length("name") BETWEEN 1 AND 80 AND "name_key" = lower("name")
    AND (("kind" IN ('EARLY_BIRD', 'LAST_MINUTE', 'LONG_STAY') AND "percent_bp" BETWEEN 1 AND 9000 AND "free_nights" IS NULL)
      OR ("kind" = 'FREE_NIGHTS' AND "percent_bp" IS NULL AND "free_nights" BETWEEN 1 AND 364 AND "min_nights" BETWEEN 2 AND 365 AND "free_nights" < "min_nights"))
    AND ("kind" <> 'EARLY_BIRD' OR ("min_lead_days" BETWEEN 1 AND 730 AND "max_lead_days" IS NULL AND "min_nights" IS NULL))
    AND ("kind" <> 'LAST_MINUTE' OR ("max_lead_days" BETWEEN 0 AND 365 AND "min_lead_days" IS NULL AND "min_nights" IS NULL))
    AND ("kind" NOT IN ('LONG_STAY', 'FREE_NIGHTS') OR ("min_nights" BETWEEN 2 AND 365 AND "min_lead_days" IS NULL AND "max_lead_days" IS NULL))
    AND ("book_from" IS NULL OR "book_to" IS NULL OR "book_to" >= "book_from")
    AND ("stay_from" IS NULL OR "stay_to" IS NULL OR "stay_to" >= "stay_from")
  )
);
CREATE UNIQUE INDEX "RatePlanPromotion_rate_plan_id_name_key_key" ON "RatePlanPromotion"("rate_plan_id", "name_key");
CREATE INDEX "RatePlanPromotion_tenant_id_rate_plan_id_idx" ON "RatePlanPromotion"("tenant_id", "rate_plan_id");

ALTER TABLE "RatePlanPromotion" ENABLE ROW LEVEL SECURITY; ALTER TABLE "RatePlanPromotion" FORCE ROW LEVEL SECURITY;
CREATE POLICY "RatePlanPromotion_tenant_isolation" ON "RatePlanPromotion"
  USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());
