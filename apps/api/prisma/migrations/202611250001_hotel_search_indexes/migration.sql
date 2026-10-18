-- Search indexes for agent typeahead and hybrid hotel candidate retrieval (ADR 0072).
-- 1. Hotel: trigram GIN on lower(name) and lower(city) so the destination resolver's
--    LIKE and word-similarity (<%) predicates use an index instead of scanning the tenant's hotels.
-- 2. HotelSearchIndex: generated tsvector + GIN for lexical ranking next to vector and trigram signals.
-- Both tables are already tenant-scoped with RLS; no policy or grant changes are needed.
-- Tenant-index review: every query keeps its "tenant_id" predicate, and the existing
-- (tenant_id, ...) b-tree indexes are untouched. Planner combines them with these GIN indexes.
-- Rollback:
--   DROP INDEX "Hotel_name_lower_trgm"; DROP INDEX "Hotel_city_lower_trgm";
--   DROP INDEX "HotelSearchIndex_search_tsv_idx"; ALTER TABLE "HotelSearchIndex" DROP COLUMN "search_tsv";

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX "Hotel_name_lower_trgm" ON "Hotel" USING gin ((lower("name")) gin_trgm_ops);
CREATE INDEX "Hotel_city_lower_trgm" ON "Hotel" USING gin ((lower("city")) gin_trgm_ops);

ALTER TABLE "HotelSearchIndex" ADD COLUMN "search_tsv" tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', "normalized_name" || ' ' || "normalized_city" || ' ' || "normalized_address")) STORED;
CREATE INDEX "HotelSearchIndex_search_tsv_idx" ON "HotelSearchIndex" USING gin ("search_tsv");
