# Dubai Agent contracted-inventory search: audit and gap closure (29 October 2026)

Scope: Agent search and authoritative recheck over contracted hotel / room / rate-plan inventory. Booking, hold, payment and cancellation stay disabled (`BOOKING_ENABLED` unchanged; `ContractedInventoryAdapter.cancel` still throws). No schema, migration, contract-route or UI change.

## Audit result
The existing architecture was kept. Search and recheck run the one shared evaluator (`evaluateContractedStay`) over `buildStaySnapshot`; nothing was re-implemented.

| Requirement | Where it is enforced | Verdict |
| --- | --- | --- |
| Occupancy / child ages | `resolveGuestPricing`, room limits, SQL pre-filter | Correct; no change |
| Nationality / source market | `marketReasons`, `planMarketReasons`; blank or malformed nationality never satisfies an allow-list; recheck re-applies the searched nationality | Correct; no change |
| Daily rates | per-night rate, currency and basis checks; zero, missing or foreign-currency night removes only that hotel | Correct; no change |
| Supplements, promotions | promotion on net, then supplements, then markup on the sum; offer names both | Correct; no change |
| Markups | NET without an ACTIVE rule is unsellable; half-up integer rounding per night; malformed rules raise `commercial_control_unavailable` | Correct; no change |
| Expired offers | server TTL; recheck returns `offer_expired`; contract `validTo` is the last stay night, inclusive | Correct; no change |
| Authoritative recheck | reprices from current Admin state, never substitutes a sibling plan, tenant-scoped, allocates nothing | Correct; no change |
| Mixed room occupancies | adapter returned an empty **successful** result | **Gap 1** |
| Process memory | `ContractedInventoryAdapter.offers` was never swept | **Gap 2** |

## Verified gaps fixed
1. **Silent false negative for mixed rooms.** A search whose rooms hold different parties (the Agent UI blocks this, the API did not) returned `providerSummary {succeeded: 1}` with zero hotels, which the API reported as `no_availability`. `POST /agent/search` now answers `422 MIXED_ROOM_OCCUPANCY_UNSUPPORTED` for authoritative (contracted) suppliers. The check lives in `room-stays.ts`, shared by the adapter and the controller. Nothing is priced, copied or dropped to make a party fit.
2. **Unbounded offer memory.** Every quoted offer stayed in the adapter's in-process map for the life of the process (the shared cache expires by TTL, the map did not). Elapsed offers are now swept at most once a minute, one hour after they elapse, so a late recheck still answers `offer_expired`.

## Tests added (deterministic, no database)
`contracted-inventory.adapter.search.spec.ts` runs the real adapter, loaders and evaluator over an in-memory tenant-scoped store, with a frozen clock. Every behaviour above is asserted at **1 hotel and 100 hotels**, plus a 100-hotel multi-batch walk (`AGENT_SEARCH_HOTEL_BATCH=7`), exact AED minor-unit totals per hotel, repeat-search determinism, tenant isolation, and the failure paths (malformed markup rule, database down, no supplier). `room-stays.spec.ts` covers the helper and the controller refusal.

Not proven by these tests: SQL pre-filters and row-level security. They are proven by the existing PostgreSQL suites (`dubai-agent-search*.e2e-spec.ts`, `inventory-search-recheck.e2e-spec.ts`), which were **not run** in this change (no database in the authoring environment).

## Checks run locally
`jest` over `src/agent` and `src/supply`: 79 suites, 1044 tests pass. API `tsc --noEmit` and ESLint on touched files clean. `check:contracts`, `check:app-boundaries`, `check:no-float`, `check:no-silent-fallback`, `check:tenant-filter` pass. Full `pnpm test` and the remaining architecture checks are left to CI.
