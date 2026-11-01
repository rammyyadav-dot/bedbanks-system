-- Availability search hot path (ADR 0074). Measured on PostgreSQL 16 as a restricted, non-BYPASSRLS login with forced RLS, one tenant of 60,000 hotels:
--   1. Hotel city lookup:    28 ms (sequential scan of the tenant) -> 0.4 ms (index scan).
--   2. Rate plan candidates: sequential scan of every tenant Contract, to join the mapped hotels -> index nested loop from the mapped hotels (39 -> 23 ms execution).
--
--   3. Hotel directory ordering (name, id) for the keyset-paged streaming export: a sort of the whole tenant per page -> an index-ordered scan.
--
-- Why a generated column and not an expression index: the runtime login is subject to forced row-level security. PostgreSQL evaluates a non-leakproof
-- user qual (lower(), LIKE, ILIKE) after the policy qual and therefore refuses to use it as an index condition, so an index on lower("city") is
-- ignored for every restricted login (verified: it is used for a superuser and skipped under RLS). A plain column compared with "=" is leakproof.
-- Prisma cannot declare generated columns or partial indexes, so scripts/check-migration-drift.mjs tolerates the two Hotel objects by name.
--
-- Tenant-index review: the Hotel index leads with tenant_id; the Contract index is on a foreign key that is unique per hotel in practice and is always
-- reached through RatePlan, which is tenant filtered. RLS and every tenant predicate are untouched.
-- Lock note: ADD COLUMN ... STORED rewrites "Hotel" under ACCESS EXCLUSIVE and the index builds take a SHARE lock. Hotel is a low-write catalogue table;
-- run in a quiet window and size the window from the row count (a rewrite of 100k rows is seconds).
-- Rollback: DROP INDEX "Hotel_tenant_id_name_id_idx"; DROP INDEX "Hotel_tenant_id_city_key_complete_idx"; ALTER TABLE "Hotel" DROP COLUMN "city_key"; DROP INDEX "Contract_supplier_hotel_mapping_id_idx";
-- (queries stay correct; the adapter falls back to nothing, so redeploy the previous API first because it reads "city_key").

ALTER TABLE "Hotel" ADD COLUMN "city_key" TEXT GENERATED ALWAYS AS (lower("city")) STORED;

CREATE INDEX "Hotel_tenant_id_city_key_complete_idx" ON "Hotel" ("tenant_id", "city_key", "id") WHERE "content_status" = 'COMPLETE';

CREATE INDEX "Contract_supplier_hotel_mapping_id_idx" ON "Contract" ("supplier_hotel_mapping_id");

CREATE INDEX "Hotel_tenant_id_name_id_idx" ON "Hotel" ("tenant_id", "name", "id");
