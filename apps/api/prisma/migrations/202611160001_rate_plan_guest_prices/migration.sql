-- ADR 0057 slice S6: per-night child and extra-adult price lines on a rate plan.
--
-- A plan with no rows keeps the original rule (adults + children must equal the plan occupancy, flat nightly rate), so nothing that sells today changes.
-- A plan with rows is priced as base nightly rate + one EXTRA_ADULT line per adult beyond its base occupancy + one CHILD line per child chosen by age band.
-- Money is integer minor units (BIGINT), never negative; zero is an explicit free guest. NET or SELL is stored per line and must match the nightly rate's basis.
--
-- Isolation: forced row-level security on tenant_id, like DailyRate. The runtime role may read it (search prices from it) and never write it:
-- authoring is a privileged supply path (ADR 0032), exactly like rates.
--
-- Database rules, so a bad row cannot exist whatever the application does:
--   * kind CHILD: ages 0 to 17 with max >= min;  kind EXTRA_ADULT: the sentinel band 18-99, so the unique key allows one such line per plan;
--   * amount >= 0, currency 3 letters.
-- Overlapping child bands cannot be expressed as a plain constraint without an extension the schema does not declare, so the service validates them on write
-- and the evaluator refuses a child that matches more than one band (CHILD_PRICE_AMBIGUOUS) instead of picking one.
--
-- Tenant-index review: reads are by (tenant_id, rate_plan_id), covered by the new index; the unique key covers (rate_plan_id, kind, min_age, max_age).
--
-- Rollback (forward migration; reviewed before use):
--   DROP TABLE "RatePlanGuestPrice"; DROP TYPE "GuestPriceKind";

CREATE TYPE "GuestPriceKind" AS ENUM ('CHILD', 'EXTRA_ADULT');

CREATE TABLE "RatePlanGuestPrice" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "rate_plan_id" TEXT NOT NULL,
  "kind" "GuestPriceKind" NOT NULL,
  "min_age" INTEGER NOT NULL,
  "max_age" INTEGER NOT NULL,
  "amount_minor" BIGINT NOT NULL,
  "amount_basis" "RateAmountBasis" NOT NULL,
  "currency" CHAR(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RatePlanGuestPrice_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RatePlanGuestPrice_rate_plan_id_fkey" FOREIGN KEY ("rate_plan_id") REFERENCES "RatePlan"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "RatePlanGuestPrice_shape_check" CHECK (
    "amount_minor" >= 0
    AND "currency" ~ '^[A-Z]{3}$'
    AND (("kind" = 'CHILD' AND "min_age" BETWEEN 0 AND 17 AND "max_age" BETWEEN "min_age" AND 17)
      OR ("kind" = 'EXTRA_ADULT' AND "min_age" = 18 AND "max_age" = 99))
  )
);
CREATE UNIQUE INDEX "RatePlanGuestPrice_rate_plan_id_kind_min_age_max_age_key" ON "RatePlanGuestPrice"("rate_plan_id", "kind", "min_age", "max_age");
CREATE INDEX "RatePlanGuestPrice_tenant_id_rate_plan_id_idx" ON "RatePlanGuestPrice"("tenant_id", "rate_plan_id");

ALTER TABLE "RatePlanGuestPrice" ENABLE ROW LEVEL SECURITY; ALTER TABLE "RatePlanGuestPrice" FORCE ROW LEVEL SECURITY;
CREATE POLICY "RatePlanGuestPrice_tenant_isolation" ON "RatePlanGuestPrice"
  USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());
