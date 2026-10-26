# ADR 0099: Indexed prefix search for the destination typeahead (PERF-01)

## Status
Accepted. Adds one reviewed migration (`202612120001_hotel_prefix_search_keys`). Builds on ADR 0072, 0073 and 0074. Measured on PostgreSQL 16 as a restricted NOBYPASSRLS login with forced row-level security. **Not run against Neon.**

## Context
PERF-01 asks for the Neon full-text and hybrid-search reference patterns (`.agents/skills/neon-postgres/references/hybrid-search.md`) to take heavy text filtering off the multi-tenant search path.

- The pattern's ranking and fusion half is already in the repo: `retrieveHotelCandidates` fuses vector, trigram and `tsvector` candidates with Reciprocal Rank Fusion (ADR 0073), using stock extensions only because ADR 0040 plans a move off Neon (the skill's `lakebase_text` BM25 is Neon-only).
- That retrieval serves supplier-hotel **mapping**, not guest-facing search. The high-frequency path is the agent destination typeahead (`DestinationResolverService.loadDestinations`), and ADR 0074 recorded that its trigram indexes are **not used by the runtime login**: under forced RLS PostgreSQL will not use an index for a non-leakproof qual (`lower()`, `LIKE`, `<%`, and equally `@@` on a `tsvector`). Every cache miss therefore scanned the tenant's hotels. A GIN full-text index would be ignored for the same reason, so extending full-text search to this path would add write cost and no speed.

## Decision
1. Express "starts with" as a range, which is leakproof: `("city_key" COLLATE "C") >= p AND < p || U+10FFFF`. `COLLATE "C"` makes the range exactly "starts with p" whatever the database collation is.
2. Add `Hotel.name_key = lower(name)` (generated, like `city_key`) and two partial indexes `(tenant_id, key COLLATE "C", id) WHERE content_status = 'COMPLETE'`.
3. The resolver reads prefix hits first, for cities and hotels separately. The ADR 0072 substring/word-similarity scan runs **only for a category with no prefix hit**, so typos ("Dubia") and mid-string matches ("palm" in "Grand Palm") behave as before when nothing starts with the term.
4. Stock PostgreSQL only. No provider extension, no `SECURITY DEFINER` function.

## Measured (50,000 hotels in the tenant, restricted login, forced RLS)
| Query | Before | After |
| --- | --- | --- |
| City, substring | 26 ms (seq/bitmap filter of the tenant) | 0.15 ms (selective prefix) |
| Hotel name, substring | 33 ms | 0.06 ms (selective prefix) |
| City, broad 2-letter prefix (25% of rows) | n/a | 18 ms |
| Hotel name, broad prefix (6% of rows) | n/a | 5 ms |

Prefix and `LIKE 'p%'` counts were equal (12,500 each). The migration applies, rolls back and re-applies cleanly.

## Consequences and limits
- **Only a prefix is accelerated.** A query with no prefix hit in a category still scans the tenant for that category. Mid-string and fuzzy matching under RLS remain unindexed.
- **Behaviour change:** when some city starts with the term, cities that merely contain it are no longer listed (typing "san" lists San Diego, not Pleasanton). Hotels are treated the same way. This is deliberate for a typeahead and is the cost of skipping the scan.
- **Broad terms are not cheap.** The city query aggregates every matching hotel row to find distinct cities, so a term matching a large share of a tenant is bounded by that share, not by the limit. A distinct-city table would remove this and is not built.
- Writes to `Hotel` maintain two more index entries and one stored column.
- The free-text `contains` destination filter in `ContractedInventoryAdapter.loadPlans` (audit F3) is unchanged: it is a substring match by contract, and callers with a resolved `destinationRef` already use the indexed exact lookup.

## Open decision
A `SECURITY DEFINER` search function that takes the tenant explicitly would allow trigram and full-text indexes to be used for substring and fuzzy search. It moves a tenant-isolation guarantee from RLS into function code (invariants 1 and 2), so it needs its own ADR and security review. Not done here.

## Rollback
`DROP INDEX "Hotel_tenant_id_name_prefix_idx"; DROP INDEX "Hotel_tenant_id_city_prefix_idx"; ALTER TABLE "Hotel" DROP COLUMN "name_key";` after redeploying the previous API (the new resolver reads `name_key`). Results stay correct on the previous API; only speed returns to the earlier scan.
