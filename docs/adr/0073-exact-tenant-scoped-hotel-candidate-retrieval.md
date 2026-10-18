# ADR 0073: Exact tenant-scoped candidate retrieval for HotelSearchIndex

## Status
Accepted. Query change only; no schema or migration change.

## Context
`retrieveHotelCandidates` (ADR 0009, migration `202610010003`) ordered `HotelSearchIndex` by `embedding <=> query` with `tenant_id` and country in the `WHERE`. When the planner takes the HNSW index it walks the nearest neighbours across **all tenants** and applies the filter afterwards, so a tenant can receive fewer than `LIMIT` rows, or none.

Reproduced on PostgreSQL 16 with pgvector 0.6.0, 50,000 index rows over 100 tenants: tenant `t7` received **0 of 20** candidates, and the plan was an `Index Scan using ...embedding_idx` with the tenant predicate as a `Filter`. pgvector 0.8 adds `hnsw.iterative_scan`, but the deployed version is not guaranteed and a failed `SET` of an unknown setting would abort the request transaction.

## Decision
`retrieveHotelCandidates` is now a hybrid retriever (vector, trigram and full-text arms fused by Reciprocal Rank Fusion, added on `main` after this ADR was first written). The flaw lived in its **vector arm**; the trigram and full-text arms already used btree/GIN indexes and were unaffected, so a tenant degraded to fewer or no vector candidates rather than none overall.

The fix applies to the vector arm: read the tenant's rows first and order them exactly: the tenant/country scope is a `MATERIALIZED` CTE (`tenant_scope`), then `ORDER BY embedding <=> query LIMIT 20`. Recall is exact and independent of pgvector's version and `hnsw.ef_search`. The vector is now a bound parameter cast with `::vector` instead of a spliced literal.

Measured exact-scan cost (same table, one tenant of 100,000 hotels): 45 ms for a 33,000-row country scope, 92 ms for the whole 100,000-row tenant. It grows with the tenant's own catalogue, not with the number of tenants.

## Consequences
- The HNSW index is no longer used by this query. It is kept (dropping it is a separate migration with its own review) and becomes useful only if a cross-tenant or very-large-tenant query is added. Revisit if a single tenant approaches ~500,000 indexed hotels.
- The shortlist is a retrieval signal only; it still never approves a mapping.

## Rollback
Make the vector arm read `HotelSearchIndex` directly again (drop the `tenant_scope` CTE) in `hotel-search-index.ts`.
