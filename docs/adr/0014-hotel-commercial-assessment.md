# ADR 0014: Hotel commercial assessment for Admin

## Status
Accepted for the API and Admin code. No schema, migration or database grant changes. ADR 0013 (production role access) is unchanged and still governs production readiness.

## Context
The Admin hotel list showed master data only. The first operations readiness (ADR 0013 work) judged each night with `evaluateNightSellability`, which is more lenient than the evaluator Agent search actually uses (`evaluateContractedStay`): it ignored the content-`COMPLETE` rule, treated a contract with no supplier mapping as sellable, and had no star-rating rule. Admin could therefore call a hotel ready that Agents would never list. The Agent adapter also built its stay snapshot privately, so any second implementation could drift.

## Decision
1. **One evaluator.** Admin readiness, gates, calendar verdicts, the sellability inspector and exceptions are all produced by `evaluateContractedStay`. The snapshot it needs is built in one shared function (`supply/stay-snapshot.ts`), now also used by the Agent search adapter. A pure module (`supply/commercial-assessment.ts`) owns no I/O and takes `today` as an input, so it is deterministic under test.
2. **Readiness** is computed over the nights of a window (default 30, maximum 90, from today in UTC) for the hotel's ACTIVE rate plans. Each plan-night is judged as a one-night stay for the plan's own occupancy. READY: every plan-night is sellable. PARTIAL: some are. BLOCKED: none are, or no rate plan is active. Stay-length rules (minimum and maximum stay, release days, closed-to-arrival) belong to a requested stay, so they are excluded from readiness and reported by the stay-level Sellability Inspector.
3. **Reason codes** are the existing canonical ones. One diagnostic is added, `HOTEL_STAR_RATING_MISSING`, because the Agent silently skips a hotel without a 1-5 rating. The `UNMAPPED_HOTEL` and `UNMAPPED_ROOM` issue categories both carry the canonical `SUPPLIER_MAPPING_INVALID` and record which mapping failed.
4. **Contract expiry** has one definition, `CONTRACT_EXPIRING_DAYS = 30`, in `@bedbanks/contracts`. EXPIRING means ACTIVE and ending within that many days; `validTo` is the last check-out date, as in the Agent. Filters offer 7, 30, 60 and 90 days.
5. **Issue severity** is an operational ranking, not a domain state. CRITICAL: the hotel is blocked. HIGH: a mapping or inactive-entity problem, or a plan blocked across the whole window on a hotel that still sells. WARNING: a partial-date problem or a contract expiring.
6. **Permissions** reuse existing names. Hotel list, summary, 360 and exceptions need `supply.hotels.read`; contracts `supply.contracts.read`; mappings `supply.mappings.read`; calendar and inspector `supply.rates.read`; audit `audit.read`. They are enforced from formal role assignments by `SupplyPermissionGuard` (the same rule as `/supply`), fail closed, and the tenant comes only from the session.
7. **Bounded work.** Assessment loads data for a set of hotels with a fixed number of queries. Without a computed filter only the requested page is assessed; computed filters, the summary and exceptions assess up to 500 hotels and report `scanCapped` when the tenant has more.
8. **Read-only.** No mutation was added. Hotel master edits keep using the existing supply endpoint; stop-sell, rates and mappings are changed in the existing workflows the pages link to.
9. **Runtime role.** The hotel, room, mapping, contract, rate plan, rate and availability tables are readable by the API runtime role, so these views work under it. Policy tables, bookings, holds and audit events are not; those parts report `null` / `OPERATIONS_READ_DENIED` instead of zero. No grant was changed.
10. **Literal search.** Prisma's `contains` and `startsWith` do not escape `%` or `_`. User text is passed through `likeLiteral` before it reaches them (this also corrects the earlier Admin operations filters).

## Alternatives rejected
- A stored readiness table or column: stale the moment a rate or availability row changes, and a schema change.
- Computing readiness in the browser: it would duplicate commercial rules in React.
- Keeping `evaluateNightSellability` for readiness: it diverges from what Agents are sold.

## Consequences
- A hotel's Admin readiness and its Agent offers share one rule set and one snapshot builder; a test asserts Admin and Agent agree for the same stay.
- A hotel with a stop-sell plan alongside a sellable one is PARTIAL, by design, so intentional restrictions stay visible.
- Rollback: remove the `hotels*` and `exceptions` routes; the older `/supply` pages are untouched.
