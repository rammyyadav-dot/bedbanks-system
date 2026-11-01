-- ADR 0058 slice S10b: derived rates.
--
-- A derived plan sells at its PARENT's nightly rate for the same date, plus or minus a signed adjustment (PERCENT_BP or FIXED_MINOR). It has no
-- DailyRate rows of its own; availability, restrictions and pool membership stay its own. Depth is one: a parent is never itself derived, so a cycle
-- cannot exist by construction. Parent and derived plan share contract, hotel, currency and occupancy.
--
-- Rules the database enforces, so they hold whatever the application does:
--   * the three derived columns are all set or all null; a plan is never its own parent; the adjustment is within sane bounds (an INTEGER: basis points,
--     or at most 2,000,000,000 minor units either way, so a plan row always serializes as plain JSON);
--   * a derived plan may not own a DailyRate row (trigger on DailyRate, and on RatePlan when a plan with rates is made derived);
--   * the parent exists, is not derived, and has the same tenant, contract, hotel, currency and occupancy (trigger on RatePlan);
--   * a plan that has derived plans cannot itself become derived.
-- The trigger on RatePlan fires on INSERT and on UPDATE OF the derived columns only, so status transitions by the narrow lifecycle role never run it.
-- A parent whose currency or occupancy changes later is caught at pricing time: the evaluator re-checks the shape and the stay is not sold.
--
-- Isolation: the new columns sit on RatePlan, which already has forced row-level security on tenant_id. The self reference is ON DELETE RESTRICT.
-- Tenant-index review: derived plans are listed by (tenant_id, derived_from_id), covered by the new index.
--
-- Rollback (forward migration; reviewed before use; only valid while no plan is derived):
--   DROP TRIGGER "DailyRate_derived_guard" ON "DailyRate"; DROP TRIGGER "RatePlan_derived_guard" ON "RatePlan";
--   DROP FUNCTION fbeds_daily_rate_derived_guard(); DROP FUNCTION fbeds_rate_plan_derived_guard();
--   ALTER TABLE "RatePlan" DROP CONSTRAINT "RatePlan_derived_check", DROP COLUMN "derived_adjustment", DROP COLUMN "derived_mode", DROP COLUMN "derived_from_id";
--   DROP TYPE "DerivedRateMode";

CREATE TYPE "DerivedRateMode" AS ENUM ('PERCENT_BP', 'FIXED_MINOR');

ALTER TABLE "RatePlan" ADD COLUMN "derived_from_id" TEXT, ADD COLUMN "derived_mode" "DerivedRateMode", ADD COLUMN "derived_adjustment" INTEGER;
ALTER TABLE "RatePlan" ADD CONSTRAINT "RatePlan_derived_from_id_fkey" FOREIGN KEY ("derived_from_id") REFERENCES "RatePlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RatePlan" ADD CONSTRAINT "RatePlan_derived_check" CHECK (
  ("derived_from_id" IS NULL AND "derived_mode" IS NULL AND "derived_adjustment" IS NULL)
  OR ("derived_from_id" IS NOT NULL AND "derived_mode" IS NOT NULL AND "derived_adjustment" IS NOT NULL AND "derived_from_id" <> "id"
      AND (("derived_mode" = 'PERCENT_BP' AND "derived_adjustment" BETWEEN -9000 AND 100000)
        OR ("derived_mode" = 'FIXED_MINOR' AND "derived_adjustment" BETWEEN -2000000000 AND 2000000000)))
);
CREATE INDEX "RatePlan_tenant_id_derived_from_id_idx" ON "RatePlan"("tenant_id", "derived_from_id");

CREATE FUNCTION fbeds_rate_plan_derived_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  parent RECORD;
  parent_hotel TEXT;
  own_hotel TEXT;
BEGIN
  IF NEW."derived_from_id" IS NULL THEN RETURN NEW; END IF;
  SELECT "tenant_id", "contract_id", "currency", "occupancy", "derived_from_id", "room_type_id" INTO parent FROM "RatePlan" WHERE "id" = NEW."derived_from_id";
  IF NOT FOUND THEN RAISE EXCEPTION 'DERIVED_PARENT_MISSING' USING ERRCODE = '23514'; END IF;
  IF parent."derived_from_id" IS NOT NULL THEN RAISE EXCEPTION 'DERIVED_PARENT_IS_DERIVED' USING ERRCODE = '23514'; END IF;
  SELECT "hotel_id" INTO parent_hotel FROM "RoomType" WHERE "id" = parent."room_type_id";
  SELECT "hotel_id" INTO own_hotel FROM "RoomType" WHERE "id" = NEW."room_type_id";
  IF parent."tenant_id" <> NEW."tenant_id" OR parent."contract_id" <> NEW."contract_id" OR parent."currency" <> NEW."currency" OR parent."occupancy" <> NEW."occupancy"
     OR parent_hotel IS NULL OR own_hotel IS NULL OR parent_hotel <> own_hotel THEN
    RAISE EXCEPTION 'DERIVED_PARENT_MISMATCH' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF EXISTS (SELECT 1 FROM "DailyRate" WHERE "rate_plan_id" = NEW."id") THEN RAISE EXCEPTION 'RATE_PLAN_HAS_OWN_RATES' USING ERRCODE = '23514'; END IF;
    IF EXISTS (SELECT 1 FROM "RatePlan" WHERE "derived_from_id" = NEW."id") THEN RAISE EXCEPTION 'RATE_PLAN_HAS_DERIVED_PLANS' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "RatePlan_derived_guard" BEFORE INSERT OR UPDATE OF "derived_from_id", "derived_mode", "derived_adjustment" ON "RatePlan"
  FOR EACH ROW EXECUTE FUNCTION fbeds_rate_plan_derived_guard();

CREATE FUNCTION fbeds_daily_rate_derived_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "RatePlan" WHERE "id" = NEW."rate_plan_id" AND "derived_from_id" IS NOT NULL) THEN
    RAISE EXCEPTION 'RATE_PLAN_IS_DERIVED' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "DailyRate_derived_guard" BEFORE INSERT OR UPDATE OF "rate_plan_id" ON "DailyRate"
  FOR EACH ROW EXECUTE FUNCTION fbeds_daily_rate_derived_guard();
