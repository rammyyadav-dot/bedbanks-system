# ADR 0072: Trigram indexes for destination typeahead

## Status
Accepted.

## Context
`DestinationResolverService.loadDestinations` (ADR 0065) matches `lower("city")` and `lower("name")` with `LIKE '%term%'` and `word_similarity(term, column) >= 0.35`. `Hotel` has only btree indexes (`tenant_id, country_code, city`), and the function form `word_similarity(...) >= t` can never use a trigram index. Every typeahead cache miss therefore reads every hotel of the tenant.

Measured on PostgreSQL 16 with 50,000 synthetic hotels (10,000 per tenant) and a selective term: 87 ms with a tenant-index bitmap scan, 0.6 ms with the indexes below and the operator form. For a non-selective term the planner correctly keeps the tenant index.

## Decision
1. Add GIN `gin_trgm_ops` expression indexes on `lower("city")` and `lower("name")` (migration `202610180001_hotel_trigram_search`).
2. Rewrite the query to `term <% lower(column)`. That is `word_similarity(term, column) >= pg_trgm.word_similarity_threshold`, so results are unchanged. The threshold is set with `set_config(..., true)` inside the existing tenant transaction, so it is transaction-local and safe behind a PgBouncer transaction pooler.
3. The indexes are not tenant-prefixed (`btree_gin` is not installed). Every query keeps its `tenant_id` predicate and RLS applies, so the index only narrows candidates.
4. `scripts/check-migration-drift.mjs` tolerates the two indexes by name, because Prisma cannot declare expression indexes.

## Consequences
- Typeahead cost stops growing linearly with tenant catalogue size for selective terms.
- `CREATE INDEX` takes a SHARE lock on `Hotel` while it builds. `Hotel` is a low-write catalogue table; apply in a quiet window.

## Rollback
`DROP INDEX "Hotel_city_lower_trgm"; DROP INDEX "Hotel_name_lower_trgm";` and remove the two names from the drift tolerance list. Queries stay correct without the indexes.

## Erratum (ADR 0074)
The timings in this ADR were taken with a login that bypasses row-level security. The runtime login does not, and PostgreSQL will not use an index for a non-leakproof qual (`lower()`, `LIKE`, `<%`) under forced RLS, so for that login the two trigram indexes are not used: a selective substring search at 70,000 hotels in one tenant took about 44 ms by sequential and tenant-index scan, against 7.8 ms through the trigram index as the table owner. The queries stay correct; the claimed speedup does not reach the runtime role. See ADR 0074.

