# ADR 0072: Hotel search indexes and hybrid candidate retrieval

## Status
Accepted. Adds one reviewed migration (`202611250001_hotel_search_indexes`). Builds on ADR 0009 and ADR 0067.

## Context
- The agent destination typeahead (ADR 0065) filtered `"Hotel"` with `lower(...) LIKE` and `word_similarity(...) >= threshold`. `"Hotel"` had no trigram index, and the function form of `word_similarity` cannot use one, so every keystroke scanned the tenant's hotels.
- Mapping candidate retrieval (ADR 0009) ordered by vector distance alone and returned a trigram score only as a by-product. It had no lexical signal.
- The `neon-postgres` skill describes Lakebase BM25 (`lakebase_text`). That extension exists only on Neon, and ADR 0040 plans a move to AWS RDS.

## Decision
1. Add GIN trigram indexes on `lower("name")` and `lower("city")` of `"Hotel"`. The resolver now uses `LIKE` and the `<%` operator, both index-assisted. The threshold is set per transaction with `set_config('pg_trgm.word_similarity_threshold', ..., true)`, so it is safe on PgBouncer transaction-mode connections (ADR 0067).
2. Add a generated `search_tsv` column (`simple` configuration, over normalized name, city and address) with a GIN index on `"HotelSearchIndex"`.
3. `retrieveHotelCandidates` fetches vector, trigram and full-text candidates (40 each) independently and fuses them with Reciprocal Rank Fusion (`k = 60`). Raw scores are never mixed. Each retriever filters on `tenant_id` explicitly.
4. Use stock pgvector, pg_trgm and tsvector only. No provider-specific extension.
5. The fused score orders candidates. It never approves a mapping (ADR 0009 is unchanged).

## Consequences
- Index writes add a little cost to hotel inserts and updates.
- `search_tsv` is database-generated, so the application never writes it. Prisma models it as an optional `Unsupported("tsvector")`.
- The `simple` configuration does no stemming, which suits proper nouns. Changing it needs a new migration.

## Rollback
Drop the three indexes and the `search_tsv` column (statements are in the migration header). Revert the resolver and retrieval query changes. The data is derived, so nothing is lost.
