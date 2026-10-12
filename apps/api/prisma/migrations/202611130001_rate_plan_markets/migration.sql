-- ADR 0057 slice S3: plan-level buyer market and guest nationality allow-lists.
-- Additive. Existing plans get '[]' (no restriction beyond the contract), so no sellability result changes.
-- A plan list can only narrow the contract: the API refuses codes outside a non-empty contract list, and the evaluator requires BOTH contract and plan to allow the buyer.
-- Tenant-index review: no new query path; reads go through the plan row. RLS, grants and the fbeds_rateplan_ops column grants are unchanged.
-- Rollback: ALTER TABLE "RatePlan" DROP CONSTRAINT "RatePlan_sales_markets_array_chk", DROP CONSTRAINT "RatePlan_nationalities_array_chk", DROP COLUMN "sales_markets", DROP COLUMN "nationalities";

ALTER TABLE "RatePlan"
  ADD COLUMN "sales_markets" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "nationalities" JSONB NOT NULL DEFAULT '[]',
  ADD CONSTRAINT "RatePlan_sales_markets_array_chk" CHECK (jsonb_typeof("sales_markets") = 'array'),
  ADD CONSTRAINT "RatePlan_nationalities_array_chk" CHECK (jsonb_typeof("nationalities") = 'array');
