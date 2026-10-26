-- Indexed prefix lookup for the agent destination typeahead (PERF-01, ADR 0099).
-- ADR 0074 found the ADR 0072 trigram indexes are ignored by the runtime login: it is under forced row-level security, and PostgreSQL will not use an
-- index for a non-leakproof qual (lower(), LIKE, <%). Text range comparisons (>=, <) are leakproof, so a prefix is expressed as a range over a key column.
-- Measured on PostgreSQL 16 as a restricted NOBYPASSRLS login with forced RLS, 50,000 hotels in the tenant:
--   city  substring (lower(city) LIKE '%x%') 26 ms  -> prefix range 0.15 ms (index only)
--   name  substring (lower(name) LIKE '%x%') 33 ms  -> prefix range 0.06 ms (index only)
-- The range is compared under COLLATE "C" (byte order = code point order for UTF-8), so "key >= p AND key < p || U+10FFFF" is exactly "starts with p"
-- whatever the database collation is. The index expressions carry the same COLLATE "C"; a query that omits it cannot use them.
--
-- "city_key" already exists (202611280001). This adds the matching "name_key" generated column and two partial indexes.
-- Prisma cannot declare generated columns, collated expression indexes or partial indexes, so scripts/check-migration-drift.mjs tolerates the three objects by name.
--
-- Tenant-index review: both indexes lead with tenant_id; every query keeps its explicit tenant predicate and row-level security is untouched.
-- Lock note: ADD COLUMN ... STORED rewrites "Hotel" under ACCESS EXCLUSIVE and the index builds take a SHARE lock. Hotel is a low-write catalogue table;
-- run in a quiet window and size the window from the row count (a rewrite of 100k rows is seconds).
-- Rollback: DROP INDEX "Hotel_tenant_id_name_prefix_idx"; DROP INDEX "Hotel_tenant_id_city_prefix_idx"; ALTER TABLE "Hotel" DROP COLUMN "name_key";
-- (redeploy the previous API first: the new resolver reads "name_key"; the old one does not).

ALTER TABLE "Hotel" ADD COLUMN "name_key" TEXT GENERATED ALWAYS AS (lower("name")) STORED;

CREATE INDEX "Hotel_tenant_id_city_prefix_idx" ON "Hotel" ("tenant_id", ("city_key" COLLATE "C"), "id") WHERE "content_status" = 'COMPLETE';

CREATE INDEX "Hotel_tenant_id_name_prefix_idx" ON "Hotel" ("tenant_id", ("name_key" COLLATE "C"), "id") WHERE "content_status" = 'COMPLETE';
