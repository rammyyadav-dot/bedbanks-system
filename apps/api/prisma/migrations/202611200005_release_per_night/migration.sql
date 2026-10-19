-- ADR 0067 (F-08): release per period, and an 18:00 release time for new plans.
--
-- `DailyAvailability.release_days` overrides the plan's release for a check-in on that night. Null (every existing row) keeps the plan's release,
-- so no stored behaviour changes. The plan's release time still applies. Range 0..365, as for the plan.
-- New rate plans default to an 18:00 hotel-local release time, the common contract cut-off; existing plans keep the value stored on them.
--
-- Isolation: DailyAvailability keeps its forced RLS; no data is rewritten. Tenant-index review: no new index (read with the night row).
--
-- Rollback (forward migration; reviewed before use):
--   ALTER TABLE "DailyAvailability" DROP CONSTRAINT "DailyAvailability_release_days_check", DROP COLUMN "release_days";
--   ALTER TABLE "RatePlan" ALTER COLUMN "release_time_local" SET DEFAULT '00:00';

ALTER TABLE "DailyAvailability"
  ADD COLUMN "release_days" INTEGER,
  ADD CONSTRAINT "DailyAvailability_release_days_check" CHECK ("release_days" IS NULL OR "release_days" BETWEEN 0 AND 365);

ALTER TABLE "RatePlan" ALTER COLUMN "release_time_local" SET DEFAULT '18:00';
