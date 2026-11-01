-- ADR 0067 (F-10): cancellation by nights, no-show rules and a client buffer.
--
-- `CancellationPolicy.kind` separates CANCELLATION tiers (from `days_before_checkin`) from the NO_SHOW rule (days 0), which applies when the guest
-- does not arrive. Every existing row is a cancellation tier, the default. `penalty_nights` is a third penalty form (1..30 nights, charged pro rata
-- of the booking total) and excludes percent and amount. `Contract.client_buffer_days` (0..30, default 0, so nothing changes) moves the tiers the
-- buyer is sold that many days earlier than the hotel's, so the DMC has time to cancel with the hotel inside the free window.
--
-- Isolation: both tables keep their forced RLS; no data is rewritten. Tenant-index review: no new index (rules are read by contract and set).
--
-- Rollback (forward migration; reviewed before use):
--   ALTER TABLE "CancellationPolicy" DROP CONSTRAINT "CancellationPolicy_nights_check", DROP CONSTRAINT "CancellationPolicy_no_show_check",
--     DROP COLUMN "penalty_nights", DROP COLUMN "kind";
--   DROP TYPE "CancellationRuleKind";
--   ALTER TABLE "Contract" DROP CONSTRAINT "Contract_client_buffer_check", DROP COLUMN "client_buffer_days";

CREATE TYPE "CancellationRuleKind" AS ENUM ('CANCELLATION', 'NO_SHOW');

ALTER TABLE "CancellationPolicy"
  ADD COLUMN "kind" "CancellationRuleKind" NOT NULL DEFAULT 'CANCELLATION',
  ADD COLUMN "penalty_nights" INTEGER,
  ADD CONSTRAINT "CancellationPolicy_nights_check" CHECK ("penalty_nights" IS NULL OR ("penalty_nights" BETWEEN 1 AND 30 AND "penalty_percent" IS NULL AND "penalty_minor" IS NULL)),
  ADD CONSTRAINT "CancellationPolicy_no_show_check" CHECK ("kind" <> 'NO_SHOW' OR "days_before_checkin" = 0);

ALTER TABLE "Contract"
  ADD COLUMN "client_buffer_days" INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT "Contract_client_buffer_check" CHECK ("client_buffer_days" BETWEEN 0 AND 30);
