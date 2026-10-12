-- ADR 0057 slice S2a: optional plan sale window and payment type.
-- Additive and nullable: every existing plan keeps inheriting the contract term and has no recorded payment type, so no sellability result changes.
-- Tenant-index review: no new query path filters on these columns alone; reads go through the existing (tenant_id, status) index and the plan's primary key.
-- Rollback: ALTER TABLE "RatePlan" DROP CONSTRAINT "RatePlan_validity_order_chk", DROP COLUMN "valid_from", DROP COLUMN "valid_to", DROP COLUMN "payment_type"; DROP TYPE "RatePaymentType";
-- Existing RatePlan RLS, grants and the fbeds_rateplan_ops column grants (status, updated_at) are unchanged.

CREATE TYPE "RatePaymentType" AS ENUM ('PREPAID', 'PAY_AT_HOTEL');

ALTER TABLE "RatePlan"
  ADD COLUMN "valid_from" DATE,
  ADD COLUMN "valid_to" DATE,
  ADD COLUMN "payment_type" "RatePaymentType",
  ADD CONSTRAINT "RatePlan_validity_order_chk" CHECK ("valid_from" IS NULL OR "valid_to" IS NULL OR "valid_to" >= "valid_from");
