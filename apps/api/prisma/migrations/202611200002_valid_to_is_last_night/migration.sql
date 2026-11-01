-- ADR 0067 (F-06): one date convention. `Contract.valid_to` and `RatePlan.valid_to` now mean the LAST STAY NIGHT (inclusive), as hotels write
-- contract periods and as markups, promotions, rate loading and the calendar import already read them. Until now the stay evaluator read them as
-- the last CHECK-OUT date, so the contracted last night never sold.
--
-- Data: every stored value was entered under the old meaning (last check-out). To keep each contract and plan selling exactly the nights it sold
-- before this release, valid_to moves back one day (last check-out minus one = last night). A row whose valid_to equals valid_from sold no night
-- under the old meaning and cannot be expressed as zero nights under the new one; it is left unchanged and now covers that one night (none exist in
-- the seeded data; operators should review any listed by the query in ADR 0067).
-- `ContractVersion` snapshots are immutable and keep the value as reviewed, under the old meaning; the ADR records the cut-over.
--
-- Forced row-level security applies to the table owner too, so the owner update would match no row without a tenant context. FORCE is lifted for
-- this transaction only and restored before commit (ALTER TABLE is transactional).
--
-- Tenant-index review: no index or key changes.
--
-- Rollback (forward migration; reviewed before use, together with reverting the application change):
--   the same three statements per table with "valid_to" + 1 in place of - 1, on the same rows.

ALTER TABLE "Contract" NO FORCE ROW LEVEL SECURITY;
UPDATE "Contract" SET "valid_to" = "valid_to" - 1 WHERE "valid_to" > "valid_from";
ALTER TABLE "Contract" FORCE ROW LEVEL SECURITY;

ALTER TABLE "RatePlan" NO FORCE ROW LEVEL SECURITY;
UPDATE "RatePlan" SET "valid_to" = "valid_to" - 1 WHERE "valid_to" IS NOT NULL AND ("valid_from" IS NULL OR "valid_to" > "valid_from");
ALTER TABLE "RatePlan" FORCE ROW LEVEL SECURITY;
