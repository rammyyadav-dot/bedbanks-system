# Database engineering and search architecture audit

**Date:** 2026-10-18 · **Branch:** `claude/tender-maxwell-9vpz2a` · **Method:** read the schema, migrations, ADRs and call sites; measured on a throwaway PostgreSQL 16 with `pg_trgm`. `pgvector` is not installable in this environment, so no vector query was benchmarked.

## Verdict on the three stated capabilities

| Claim | Verdict | Evidence |
| --- | --- | --- |
| pgvector for semantic hotel matching and amenity clustering | **Partly true, overstated.** | `HotelSearchIndex` (`vector(64)`, HNSW cosine) exists with RLS (`202610010003`). The embedding is `HashedTokenEmbeddingProvider`: hashed lexical tokens, not a semantic model (`mapping/embedding.ts`). There is no amenity embedding or clustering anywhere; amenities are a controlled catalogue (`HotelAmenity`). |
| Hybrid SQL + vector pipeline for sub-second availability queries | **Not true.** | Vector and trigram retrieval serve supplier-hotel **identity mapping** only. Availability search (`ContractedInventoryAdapter.loadPlans`) is relational Prisma filters with `city ILIKE`; it never touches `HotelSearchIndex`. The sub-second figure comes from one e2e test over 100 hotels. |
| Serverless connection handling | **Not true, by decision.** | ADR 0067 deliberately rejects `@neondatabase/serverless`. The API is a long-lived NestJS process with audited Prisma pool singletons; pooling is `connection_limit` per role URL, plus PgBouncer on the pooled endpoint. |

## Findings

| # | Severity | Finding |
| --- | --- | --- |
| F1 | High | `upsertHotelSearchIndex` and `retrieveHotelCandidates` have **no production caller** (only `test/hotel-search-index.e2e-spec.ts`). The table is never populated; `mapping-pipeline` scores the in-memory catalogue with O(suppliers × catalogue) work. Per CLAUDE.md invariant 10 this is a schema model, not a production capability. |
| F2 | High | Destination typeahead scanned every hotel of the tenant per cache miss (87 ms at 10k hotels). **Fixed in this change** (ADR 0072). |
| F3 | Medium | Availability destination filter `city contains, mode: insensitive` is a `%term%` ILIKE with no supporting index, run before every search. Only the typeahead was fixed; this path needs the resolved `destinationRef` (exact city) to be the norm and `contains` retired. |
| F4 | Medium | `retrieveHotelCandidates` filters by tenant and country **after** the HNSW scan. With many tenants in one index, approximate search can return fewer than 20 candidates for a tenant. pgvector 0.8 `hnsw.iterative_scan` or per-tenant partial indexes is needed before the table is populated at scale. Not testable here. |
| F5 | Low | Vector literals are built with `Prisma.raw` string interpolation. Values are finite numbers validated by `vectorLiteral`, so not exploitable, but a bound parameter cast (`${literal}::vector`) is the safer idiom. |
| F6 | Info | Prod candidate Neon branch lacks later migrations (`docs/fbeds-persistent-database-inventory.md`); `vector` and `pg_trgm` extensions must be confirmed present before `202610010003` and `202610180001` apply. |

## Built in this change
- Migration `202610180001_hotel_trigram_search` (two GIN trigram indexes, rollback and lock notes inside).
- `DestinationResolverService.search` now uses the indexable `<%` operator with a transaction-local threshold; results are semantically unchanged.
- Drift check tolerance, ADR 0072, and `destination-resolver.search.spec.ts`.

Verified: `tsc --noEmit` clean, the two destination-resolver suites pass, `pnpm check:architecture` passes, ESLint clean, migration applies and re-applies on PostgreSQL 16, and the index/operator query plan and timings above. **Not verified:** the full-migration drift check and anything involving `pgvector` (needs a Neon branch).

## Plan (not built, in order)
1. **Decide the embedding strategy (ADR).** Keep the 64-dim hashed vector as a cheap lexical signal, or adopt a real model (needs dimension change, a new migration, re-index and a provider data-handling review under invariant 7). Do not advertise "semantic" until then.
2. **Populate and use the index.** Write `HotelSearchIndex` from hotel create/update in the same transaction; backfill job with idempotency; have `mapping-pipeline` call `retrieveHotelCandidates` to shortlist before `matchSupplierHotel`. Keep "an embedding never approves a mapping alone".
3. **Fix F4 and F5**, then benchmark on a Neon branch at 100k hotels / 20 tenants with `EXPLAIN (ANALYZE)` and recall measured against exact search.
4. **Availability search (F3):** make exact `destinationRef` mandatory for city searches, add a covering index review for `RatePlan`/`Contract` date-range filters, and record search latency percentiles before any "sub-second" claim.
5. **Amenity clustering:** only if product wants it; needs its own design. Today it does not exist.
6. **Pool budget:** record `tasks × Σ connection_limit` against Neon `max_connections` per environment in the runbook.
