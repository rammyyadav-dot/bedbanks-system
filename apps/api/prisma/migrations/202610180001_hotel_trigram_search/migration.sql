-- Trigram indexes for the agent destination typeahead (DestinationResolverService.loadDestinations), which matches
-- lower("city") / lower("name") by LIKE '%term%' and by pg_trgm word similarity. Without them every keystroke that misses
-- the cache scans all of the tenant's hotels (measured 87 ms for 10k hotels, 0.6 ms with these indexes on a selective term).
-- Prisma cannot declare expression indexes, so scripts/check-migration-drift.mjs tolerates these two by name.
-- Tenant-index review: the indexes are not tenant-prefixed (btree_gin is not installed); every query keeps its
-- "tenant_id" predicate and Row Level Security, so the index only narrows candidates and never widens access.
-- Lock note: CREATE INDEX takes a SHARE lock on "Hotel" for the build; Hotel is a low-write catalogue table. Run in a quiet window.
-- Rollback: DROP INDEX "Hotel_city_lower_trgm"; DROP INDEX "Hotel_name_lower_trgm"; (queries stay correct, only slower).

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX "Hotel_city_lower_trgm" ON "Hotel" USING gin (lower("city") gin_trgm_ops);
CREATE INDEX "Hotel_name_lower_trgm" ON "Hotel" USING gin (lower("name") gin_trgm_ops);
