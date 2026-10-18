-- Search indexes for agent typeahead and hybrid hotel candidate retrieval (ADR 0072).
-- Hotel trigram GIN indexes on lower(name)/lower(city) already exist (migration 202610180001); they are not recreated here.
-- HotelSearchIndex: generated tsvector + GIN for lexical ranking next to vector and trigram signals.
-- The table is already tenant-scoped with RLS; no policy or grant changes are needed.
-- Tenant-index review: every query keeps its "tenant_id" predicate, and the existing
-- (tenant_id, ...) b-tree indexes are untouched. Planner combines them with these GIN indexes.
-- Rollback:
--   DROP INDEX "HotelSearchIndex_search_tsv_idx"; ALTER TABLE "HotelSearchIndex" DROP COLUMN "search_tsv";

ALTER TABLE "HotelSearchIndex" ADD COLUMN "search_tsv" tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', "normalized_name" || ' ' || "normalized_city" || ' ' || "normalized_address")) STORED;
CREATE INDEX "HotelSearchIndex_search_tsv_idx" ON "HotelSearchIndex" USING gin ("search_tsv");
