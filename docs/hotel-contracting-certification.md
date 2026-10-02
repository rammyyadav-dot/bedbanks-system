# fBeds — Hotel Contracting & Commercial Operations Certification

Scope: turn the Admin hotel list into a commercial operations workspace (list, Hotel Commercial 360, rate and inventory calendar, sellability inspector, exceptions centre) whose every readiness verdict comes from the same evaluator the Agent sells by. Evidence was produced on a **disposable local PostgreSQL** (`fbeds_ci`, plus a throwaway replay database) only. No production deployment, production database, production grant, live supplier, live booking or live payment was touched.

Design record: `docs/adr/0014-hotel-commercial-assessment.md`. Earlier work this builds on: `docs/adr/0013-admin-operations-api.md`, `docs/admin-operations-certification.md`.

## Verdict
**HOTEL CONTRACTING ADMIN MVP: CERTIFIED WITH CONDITIONS.** Everything the certification rule requires passed on the final head. The conditions are about Production, not the code:
1. **ADR 0013 stays open and human-owned.** Under the production-design API role the hotel, room, mapping, contract, rate and availability views work, but booking and hold counts, the hotel audit tab and contract-policy counts are not readable and show an explicit "unavailable" state. No grant was changed.
2. **Production runtime RLS: NOT ASSESSED.** Isolation was proven under a non-bypass test role and under the provisioned `fbeds_api_login` role on a disposable database, not under the actual production role.
3. Human review of the final diff is pending.

## A. Release identity
STARTING_BRANCH=`feat/admin-authoritative-operations` (the merged PR #208 branch) · STARTING_SHA=`0dea2d1` (#208 head, observed merged) · ORIGIN_MAIN_SHA=`4355dde` · WORKING_TREE=clean · FINAL_BRANCH=`claude/charming-goodall-0jo555` (worked on locally as `feat/admin-hotel-commercial-360`) · FINAL_SHA and DRAFT_PR are in the PR body.

#208 was verified from the repository, not assumed: the `/admin/operations/*` module, Booking 360, holds, readiness, the reconcile action and the explicit denied states all exist in `main`. Its readiness logic did **not** match the Agent (see defect D1).

## B. Hotel operations
| | |
|---|---|
| HOTEL_LIST | `/hotels`: hotel, code, destination, stars, supplier, contract state, mapping (and rooms mapped), rates, inventory, sellability, issues, updated, action. Entity status is shown separately from commercial readiness. |
| SERVER_PAGINATION | 25 per page; metadata (`page`, `pageSize`, `total`) from the API. Tested: first, middle, final and empty pages, with search and with filters. |
| SEARCH | Hotel name (substring) or hotel code (prefix), literal (a `%` matches nothing). |
| FILTERING | Destination, supplier, hotel status, readiness, mapping, contract state, contract expiry within 7/30/60/90 days, issue category or reason code. All applied by the API; all in the URL so a view is shareable. |
| HOTEL_360 | `/hotels/[id]` with tabs Overview, Rooms, Mappings, Contracts, Rates & Inventory, Sellability, Bookings, Audit. Tabs needing another permission are hidden, and a deep link without it shows FORBIDDEN. Documents were not added as a tab: booking documents live inside Booking 360, which is linked, not rebuilt. |
| ADD_HOTEL | Existing flow kept. A hotel created through the real form opens as BLOCKED, "Sellable to Agents: NO", DRAFT, with critical issues (browser-verified). |

## C. Commercial readiness
Definitions (ADR 0014): READY = every active rate plan is sellable on every night of the window; PARTIAL = some are; BLOCKED = none are or no plan is active. Window default 30 nights from today (UTC), maximum 90. Each plan-night is judged by `evaluateContractedStay`, the Agent's evaluator, as a one-night stay. Stay-length rules are excluded from readiness and reported by the inspector.

| | |
|---|---|
| READY / PARTIAL / BLOCKED | Each proven by test (HOTEL-OPS-05/06/07) and in the browser. A hotel with a stop-sell plan beside a sellable one is PARTIAL by design. |
| MAPPING_DIAGNOSTICS | Hotel mapping PENDING/REJECTED/NONE and room mapping NONE/PENDING/REJECTED, with the unmapped rooms listed per supplier mapping. Rooms are never matched by name. |
| CONTRACT_DIAGNOSTICS | ACTIVE / EXPIRING / EXPIRED / INACTIVE / NONE from one server threshold (30 days). `validTo` is the last check-out date, exactly as the Agent treats it. |
| RATE_DIAGNOSTICS | RATE_MISSING vs RATE_INVALID, with the affected range; currency and amount-basis problems. |
| AVAILABILITY_DIAGNOSTICS | AVAILABILITY_MISSING with range; remaining = allotment − sold − held. |
| STOP_SELL_DIAGNOSTICS | Per night, per plan, with range. |
| INVENTORY_DIAGNOSTICS | NO_INVENTORY (including a hold consuming the last room); an oversold row shows a negative remaining rather than hiding it. |

## D. Contracting
CONTRACT_WORKSPACE: contracts (supplier, status, expiry state, validity, currency, version, plan counts, policy counts) and rate plans (room, board, currency, amount basis, status, stay rules, window result), plus the chain *contract → plan → rate → availability → stop-sell → inventory → sellable* with each step's verdict. RATE_PLANS and BOARD_BASIS shown with canonical board codes (the `CHAR(3)` padding is trimmed in these views). Expiry visible per contract, per hotel and as a filter.

## E. Rate & inventory
RATE_CALENDAR / INVENTORY_CALENDAR: per rate plan and date, rate, basis, allotment, sold, held, remaining, stop-sell and the verdict with its canonical reasons; window 1-62 nights; opens at the affected night and room when reached from an issue. INTEGER_MONEY: amounts cross the API as integer minor-unit strings and are formatted for display only (a guard test forbids float arithmetic in the new code). HELD_VISIBILITY: a hold shows in `held`, in `remaining`, in the hotel's active-hold count and in the Bookings tab, which links to the existing hold views. The calendar is read-only; it links to the existing rates workbench for edits (which keeps its validation and audit). No mutation surface was added.

## F. Sellability
SELLABILITY_INSPECTOR: check-in, check-out, adults, children, rooms, optional room. Returns SELLABLE / NOT SELLABLE, offers, the cheapest integer total, and per rate plan: gates (PASS/FAIL), stay-level reasons and a night-by-night verdict. MULTI_NIGHT_DIAGNOSTICS: a stay with one stop-sold night is not sellable and names the night; the same hotel is sellable for dates that avoid it. CANONICAL_REASON_CODES: the existing set, plus one diagnostic, `HOTEL_STAR_RATING_MISSING`. AGENT_CONSISTENCY: an e2e test compares Admin and Agent search for the same stay across 11 hotels and they agree on every one.

## G. Exceptions
COMMERCIAL_EXCEPTION_VIEW: `/exceptions`, server-paginated, filterable by severity and category, ordered CRITICAL → HIGH → WARNING deterministically, each item carrying hotel, room/plan, supplier, issue, canonical reason, affected range, observed time and a deep link to the section that resolves it. Categories (13) are a closed set derived from canonical reasons. Severity is an operational ranking, documented in ADR 0014.

## H. Security
| | |
|---|---|
| AUTH | 401 without a session on every new route. |
| RBAC | Existing keys only: `supply.hotels.read`, `supply.contracts.read`, `supply.mappings.read`, `supply.rates.read`, `audit.read`. Formal roles, fail closed (a handler without a declared permission is denied; a spec asserts it). 403 for a caller without the key; a viewer holding only `supply.hotels.read` can use the list and 360 but not contracts, mappings, rates or audit. |
| TENANT_ISOLATION | Tenant from the session only. Tenant B cannot read tenant A hotels, rooms, mappings, contracts, rates, availability, sellability, audit or exceptions (404 or empty scope); a tenant id in the query or a foreign tenant header is ignored or refused. |
| TEST_ROLE_RLS | `HOTEL-OPS-RLS`: under a NOBYPASSRLS test role, ten tables return only the current tenant and nothing without a tenant context. |
| RUNTIME_ROLE (disposable) | `HOTEL-OPS-RUNTIME-ROLE`: under the provisioned `fbeds_api_login` role, the hotel views read supply data for the current tenant only; booking/hold counts and contract-policy counts come back `null` (unavailable), not zero. |
| PRODUCTION_RUNTIME_RLS | **NOT ASSESSED.** |
| ADR_0013 | Open. Human decision required before relying on booking, hold and audit views in Production. |

## I. Dubai acceptance (existing 100-hotel fixture, extended in place)
HOTELS=100 (100 rooms, 300 active rate plans, 100 hotel mappings, 100 room mappings, 100 contracts, 7 sellable nights).

| Scenario | Result |
|---|---|
| DUBAI-01/02/03 hotels 1, 51+, 100 | located by search and by page position |
| DUBAI-04 final page | page 4 of 25 ends at hotel 100; page 5 is an empty success |
| DUBAI-05 search beyond page 1 | hotel 78 found |
| DUBAI-06 destination filter | `Dubai` = 100, `Nowhere` = 0 (success, not an error) |
| DUBAI-07 READY explained | stop-sell lifted on one hotel: READY, all 12 gates PASS, inspector shows an offer and the integer total |
| DUBAI-08 hotel mapping | PENDING → BLOCKED, `SUPPLIER_MAPPING_INVALID`, UNMAPPED_HOTEL |
| DUBAI-09 room mapping | REJECTED → BLOCKED, UNMAPPED_ROOM |
| DUBAI-10 contract | ended contract → BLOCKED, `OUTSIDE_CONTRACT_VALIDITY` |
| DUBAI-11 / 12 | rates removed → RATE_MISSING; availability removed → AVAILABILITY_MISSING |
| DUBAI-13 stop-sell | identified on all 100 hotels with the 7-night range |
| DUBAI-14 exhaustion | INVENTORY_EXHAUSTED |
| DUBAI-15 hold | hold shows in `held`, remaining never negative, active-hold count 1, released afterwards |
| DUBAI-16 bookings | server-side `hotelId` filter: 0 then 1, then removed |

Each scenario perturbs one hotel and restores it in `finally`; the fixture is verified unchanged afterwards and the Agent tests that follow still pass.

## J. Performance (measured, 100 hotels × 3 plans, local disposable PostgreSQL)
| Call | Time | SQL SELECTs |
|---|---|---|
| List, 25 hotels (page 1) | 205 ms | 19 |
| List, 100 hotels, 7 nights | 217 ms | 19 |
| List, 100 hotels, 30 nights (default window) | 379 ms | 19 |
| List, computed readiness filter over 100 hotels | 188 ms | 18 |
| Summary, 100 hotels, 7 / 30 nights | 220 / 290 ms | 18 |
| Exceptions, 100 hotels, 30 nights | 273 ms | 17 |
| Hotel 360 | 36 ms | 21 |
| Calendar, 14 nights | 16 ms | 17 |
| Sellability inspector | 19 ms | 17 |

N_PLUS_ONE_FOUND: none; the statement count is identical for 25 hotels and 100 hotels (a test asserts it), because assessment loads all hotels' data in a fixed set of bulk queries. No optimisation claim is made against #208: its readiness was not measured in isolation. Times are one local run, not a benchmark.

## K. Tests
| | Result |
|---|---|
| API unit | 43 suites, 402 tests, 0 failed |
| API e2e (full, nothing else running) | 29 suites, 203 tests, 0 failed, 0 skipped |
| Admin unit | 31 / 31 |
| Agent / Supplier / Website | 67 / 4 / 54 |
| `packages/domain` / `packages/money` | 20 / 3 |
| New assessor unit tests | 21 (fixed injected clock) |
| Hotel commercial e2e | 24 (HOTEL-OPS-01..21, Agent consistency, exceptions, RLS, runtime role, query counts) |
| Dubai 100-hotel spec | 10 (DUBAI-01..16, performance, and the unchanged Agent search/pagination/recheck/price-changed/expired/boundary tests) |
| Browser, hotel workspace | 81 / 81 |
| Browser, earlier operations views (regression) | 37 / 37 |
| Accessibility | axe WCAG A/AA: 0 serious or critical on Hotels list, Hotel 360, Rates & Inventory, Sellability Inspector, Exceptions; no page-level horizontal overflow at 1280, 768 and 390 px; keyboard activation of tabs |
| Static checks | architecture (contracts, no-float, no-silent-fallback, public-env), schema integrity, `prisma validate`, `prisma generate`: pass |
| Migration | all 26 replayed into a fresh database; status up to date; no drift before or after the tests; no schema or migration file changed |
| `pnpm -r type-check` / `pnpm -r lint` | exit 0 / exit 0 |

Agent regression: search, pagination, offer, recheck, price changed, expired, unavailable, provider unavailable and the booking gate are covered by the unchanged Agent specs inside the 203/402 above; the D0→D+6 contract/date boundary is `dubai-commercial-scale.e2e-spec.ts`, and the same `validTo` rule is asserted for Admin. Date-rot: new tests use dates relative to today or the injected fixed clock; the hard-coded dates remaining in touched files are pure parsing/formatting tests.

## L. Builds
API, Admin, Agent, Supplier, Website: all exit 0, built independently on the final code.

## M. Defects
| ID | Severity | Defect | Root cause | Fix | Regression test | Status |
|---|---|---|---|---|---|---|
| D1 | P1 | Admin readiness (from #208) said "ready" for hotels the Agent would not list: no supplier mapping, hotel content not COMPLETE, no star rating | readiness used the lenient per-night evaluator, not the Agent's | one shared evaluator and snapshot builder; star-rating diagnostic | assessor unit tests; Admin-vs-Agent consistency e2e | fixed |
| D2 | P2 | `%` and `_` matched every row in free-text filters (hotel search, and the earlier supplier, audit and booking filters) | Prisma `contains`/`startsWith` do not escape LIKE wildcards; a comment claimed they did | `likeLiteral` on every user-text filter; comment corrected | wildcard e2e across all filters; unit test | fixed |
| D3 | P2 | Contracts view returned a 500 under the API runtime role | policy tables are outside that role's grants (42501) | policy counts read separately and reported `null` (unavailable) | `HOTEL-OPS-RUNTIME-ROLE` | fixed |
| D4 | P2 | Hotel audit endpoint would 500 where `AuditEvent` is unreadable | missing denial handling | explicit `OPERATIONS_READ_DENIED` | runtime-role test | fixed |
| D5 | P2 | An issue linked to the calendar at today, not the affected night; a hotel with no star rating could not be fixed from the page; the "saved" confirmation vanished after saving | link carried no context; form lacked the field; refresh unmounted the form | context-carrying links, star-rating field, refresh keeps data on screen | browser checks (link URL, edit→recalculate loop) | fixed |
| D6 | P2 | Narrow screens scrolled the whole page sideways; inactive-tab, success/warning pill and form-label text below WCAG AA contrast | tab row and long id forced overflow; low-contrast shared colours | scrollable tab row, wrapping ids, darker shared colours | browser overflow and axe checks | fixed |
| D7 | P3 | `BoardBasis.code` is `CHAR(3)` so "BB" arrived as "BB " | column type | trimmed in the new views | e2e (`boardCode: 'BB'`) | fixed here; other consumers not changed |
| D8 | P3 | `dubai-agent-search` "hides the hotel…" test ran at 4.3–4.9 s against a 5 s default (the same on pristine `main`) and timed out under load | nine sequential writes and searches | explicit 30 s timeout, no assertion changed | passes alone and in the full run | fixed |
| — | not a defect | one hold-sweeper spec fails with a `DATABASE_URL` lacking `?schema=public` | the spec appends `&application_name=` | use the CI-form URL | — | n/a |

OPEN_P0=0 · OPEN_P1=0.

## N. Remaining gaps
**MVP blockers:** none found.

**Production blockers (human-owned):**
- ADR 0013: choose the production role strategy (least privilege) and define separate read privileges for bookings, holds, ledger, documents, connectors, contract-policy tables and audit, and a separate privilege for reconciliation. Until then those parts show "unavailable".
- Certify runtime RLS under the actual production role (NOT ASSESSED here).

**P2 enhancements:**
- Computed filters, the summary and exceptions assess at most 500 hotels (the response says `scanCapped`). Beyond that, move aggregation into SQL or a maintained summary.
- Other list pages (`/contracts`, `/rates/plans`, `/mappings`, rooms) still load whole lists; only Hotels is server-paginated here.
- The hotel summary counts hotels (not contracts) for expiring and expired.
- Stop-sell, rates and mappings are edited in their existing workbenches, not inline.
- The Admin browser verification is a manual script, not CI.
- `CHAR(3)` board codes are still padded outside the new views.

**Future commercial features (not built, not modelled):** contracting CRM and negotiation workflow, promotions and free nights, CTA/CTD rules beyond the stored flag, complex child pricing and supplements, supplier payables, revenue analytics, automated contract ingestion.

## Safety
PRODUCTION_DEPLOYED=NO · PRODUCTION_DB_MUTATED=NO · PRODUCTION_GRANTS_CHANGED=NO · LIVE_SUPPLIER_USED=NO · LIVE_BOOKING_CREATED=NO · LIVE_PAYMENT_PROCESSED=NO. The seed scripts refuse any database but local `fbeds_ci`; the migration replay used a throwaway database that was dropped. No schema, migration or grant file changed. No secret value was added to the repository.
