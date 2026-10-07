# Agent home search upgrade

The Agent home now has a compact fBeds header and search-first card: destination, dates, rooms and Search in the primary row; canonical nationality and server-supported selling currency below. Dates and occupancy use drafts with Apply/Cancel. Account/tenant-scoped recent searches replay a fresh search. The authoritative search and recheck contracts, evaluator, permissions and database policies are reused.

## Inspection and scope

Base: current remote main `38381576b8809482fdd29b984292f880c42c6d4e`, tree `0feefd9abf11fc2c147c35a4b2ee4440b20a786b`. Initial working tree was clean. The initially available default pnpm was 11.19.0; every task install/check/build was explicitly run with pnpm 10.4.1. Branch: `feat/agent-home-search-upgrade`. Tools: Node `v24.19.0`, pnpm `10.4.1`, Next `16.3.3`, Chromium `151.0.7922.173` (system browser), PostgreSQL 16 with pgvector.

Git fetch succeeded. The GitHub CLI PR API returned Forbidden; the connected GitHub tool could read branches and open PRs (no open PRs returned). Related branches include `feat/agent-canonical-search-ux`, `feat/agent-dubai-mvp-completion`, `perf/agent-search-100-hotels` and the marketplace/search UX branches; their merged behavior is reused from main. No unrelated work was present or overwritten. The uploaded request included no screenshot, so the specified hierarchy/colors are the layout reference; pixel comparison with the unavailable reference is not claimed.

Tested application code head: `693a5cbbdd069136e047bcb65ad8425fbaabc6f3`, tree `375afd8172c79af3dcaab016795e56a901eb6a08`. The subsequent evidence/harness commit changes no application code. Final-head CI is evaluated on the final published commit.

## Requirement matrix

| Area | Status | Reused / upgraded / remaining gap |
| --- | --- | --- |
| Home hierarchy and responsive branding | IMPLEMENTED | One shared search form; horizontal desktop, two-column tablet and stacked mobile; compact header, support, account profile menu, authorized workspace context; only existing notices beneath history |
| Canonical destination | IMPLEMENTED | Existing tenant-scoped city/hotel resolver; typed text clears identity; debounced responses ignore stale work; combobox arrows/Enter; no fallback to Dubai |
| Area/landmark/airport resolution | MISSING | Domain and resolver do not support area identities; no unsupported options added; Dubai remains certified MVP scope |
| Stay dates | IMPLEMENTED | Existing two-month desktop/mobile calendar, native date-only entry, range/nights; drafts, Apply/Cancel, Escape focus and arrow keys; 1–30 nights and Asia/Dubai today; no automatic checkout correction |
| Occupancy validation | IMPLEMENTED for supported scope | Existing room and child-age limits, individual drafts, add/remove, Apply/Cancel; mandatory child ages; uniform rooms survive real search/navigation/recheck |
| Different occupancy per room | PARTIAL | Domain accepts separate rooms, but `ContractedInventoryAdapter.search` returns no offers when `uniformRoomStays` is false. UI blocks this honestly without copying guests. No evaluator/schema expansion |
| Nationality | IMPLEMENTED | Searchable existing canonical country list and account-local choice; eligibility retained by search and stored authoritative recheck context; inaccurate old commercial helper corrected |
| Account-provided nationality default | MISSING | Current identity contract supplies no nationality default; existing valid IN initial choice and saved account choice retained |
| Currency/money | IMPLEMENTED | Server settlement currencies only; AED in tested runtime; no FX/relabeling; existing integer money utilities and total-stay labels |
| Search context and API routing | IMPLEMENTED | Existing canonical criteria, generation guards, 25-hotel pages, same-origin proxy, server-only URL guard; applying criteria now invalidates results and old offer/recheck UI |
| Results/detail/pagination | IMPLEMENTED | Existing canonical identities and board/room/rate plans, images/placeholders, cancellation and pricing; 100 unique hotels reached; sticky criteria overlap with Back fixed |
| Authoritative recheck | IMPLEMENTED/reused | RECHECKED, PRICE_CHANGED with acceptance/recheck, UNAVAILABLE and EXPIRED verified; strict runtime, real inventory; no allocation |
| Recent searches | IMPLEMENTED | Existing eight-entry session history scoped by account AND tenant; filters included in deduplication, valid occupancy reused, fresh replay/removal, logout clears all tenant keys, tenant departure clears its history; unscoped legacy history is not attributed to a tenant |
| Errors/session/security | IMPLEMENTED/reused | Initial anonymous visit is not expiry; revoked session recovery, permission denial, missing availability, pagination retry, API failure and stale work; server membership verification and forced RLS unchanged |
| Accessibility | IMPLEMENTED within tested coverage | Labels/error associations, combobox identity/keyboard, non-modal dialogs, Escape focus, visible focus, range buttons, viewport bounds/reduced motion; axe has no serious/critical WCAG A/AA violations on tested home/calendar/results/rechecked detail |
| Approved content | IMPLEMENTED | Existing notices only; removed large editorial/discovery/reservation sections from disabled-booking home; no invented counts/rates/promotions |
| Smart Search/promotional engines | MISSING/future scope | Not added |
| Hosted Agent acceptance | BLOCKED / NOT_VERIFIED | No dedicated authenticated hosted Agent/API account was supplied or verified; no hosted resource changes made |
| Screenshot fidelity | BLOCKED reference | Screenshot was not attached; written hierarchy used |

## Files and behavior

- `components/search/search-criteria-form.tsx`: shared form hierarchy, stale destination response guard, combobox keyboard behavior, draft calendar/occupancy, canonical country search, viewport positioning and accessible validation/focus.
- `components/home/agent-home.tsx`: compact home, tenant-scoped recent cards, correct total occupancy from per-room criteria, approved notices only.
- `components/agent-portal.tsx`: supported-occupancy/currency/date checks, account/tenant history wiring and cleanup, remove unsupported Dubai shortcut from home, clear old results/recheck when criteria change, profile menu and permitted navigation.
- `components/agent-workspace.tsx`: avoid duplicate workspace header/picker for an already selected single workspace; retain authorized multi-workspace picker and blocked states.
- `app/globals.css`: responsive search rows, bounded popovers and focus, profile menu, and summary/detail overlap correction.
- `lib/stay-calendar.ts`: Asia/Dubai date floor; picking check-in does not silently replace checkout.
- `lib/occupancy.ts`: explicit UI scope guard matching the existing adapter's uniform-room limit; concise summary.
- `lib/recent-searches.ts`: tenant keying/cleanup, board/property filter deduplication, occupancy validation through existing builder.
- `lib/marketplace-content.ts`: selling currency and correct nationality eligibility wording.
- `lib/{recent-searches,marketplace-search}.test.mjs`: meaningful regression cases for isolation/logout/deduplication, Dubai midnight, no silent date correction and unsupported mixed rooms.
- `tsconfig.json`: allow explicit TypeScript imports under the existing `noEmit` setting so native Node24 tests can reuse the existing occupancy builder.
- `tools/admin-ops-verify/{seed-agent-mvp.ts,verify-agent-mvp.cjs,verify-agent-home-search.cjs,README.md}`: disposable two-tenant agent fixture, production-browser journeys, updated Apply/profile/keyboard selectors and optional system Chromium path.
- This record and `docs/evidence/agent-home-search/`: evidence and limitations.

No backend API, canonical contract, money model, database schema, migration, grants, RLS evaluator or supplier integration code changed. The browser sends a selected membership's tenant header; the server continues to validate that membership against the authenticated session. Recheck sends canonical offer/search references and expected money; the authoritative server offer stores the hotel/room/board/plan, dates, nationality and occupancy. Criteria edits unmount those stale offers rather than leaving a previous recheck usable. Unsupported saved currencies are refused explicitly instead of silently substituted.

## Validation

Commands use `pnpm@10.4.1` under Node24 (invoked via `npx --yes pnpm@10.4.1` in this environment).

| Command/check | Result |
| --- | --- |
| `CI=true pnpm install --frozen-lockfile` | PASS; no dependency/lockfile changes |
| `pnpm --filter @bedbanks/api prisma:generate` | PASS; required generated prerequisite |
| `pnpm check:architecture` | PASS |
| `pnpm check:schema` | PASS |
| `pnpm --filter @bedbanks/agent-portal type-check` | PASS |
| `pnpm --filter @bedbanks/agent-portal lint` | PASS; no warnings |
| `pnpm --filter @bedbanks/agent-portal test` | 108/108 PASS |
| `node --test tools/deployment/config.test.mjs tools/deployment/hosted-agent-smoke.test.mjs` | 9/9 PASS; includes URL validation; Agent unit suite also includes next-config tests |
| `node --test packages/domain/src/search-offers.test.cjs` | 28/28 PASS |
| `API_INTERNAL_URL=http://127.0.0.1:3002/api/v1 pnpm --filter @bedbanks/agent-portal build` | PASS production webpack build |
| `VERCEL=1` with missing `API_INTERNAL_URL` loading Next config | PASS: refused, fail closed |
| Built `.next/static` inspection | PASS: no internal API URL, database URL, internal environment names or test runtime credential markers; values not printed |
| `verify-agent-mvp.cjs` | 50/50 PASS; 100 hotels, all recheck states, permissions, failures/retry, overflow/axe, unchanged hold/booking/ledger counters |
| `verify-agent-home-search.cjs` | 23/23 PASS; home controls, two identical rooms with explicit child ages through real search/recheck, replay/removal/past-date correction, same-account tenant switch, stale suggestions, calendar keys and home/calendar axe |

Runtime classification: production Next Agent on `localhost:3003` -> same-origin `/api/v1/*` rewrite -> real Nest API (`3002`, and short-TTL `3004`) -> disposable PostgreSQL 16/pgvector. The application API starts on `fbeds_api_login`, verified non-superuser, non-BYPASSRLS and owning nothing. Owner credentials are used only by separate fixture/migration/provisioning and evidence SQL. Docker database storage is disposable tmpfs. Existing migrations were applied only to that disposable database; no new migration or persistent provisioning was introduced. An initial plain PostgreSQL attempt lacked pgvector; it was replaced with the CI pgvector image and the complete migration/strict-role setup then passed.

Stub-only evidence is clearly labeled: API abort/delayed search/expired response interception in the MVP harness, and delayed destination suggestions, pagination abort, recheck abort and missing mapping responses in the home harness. The real short-TTL API independently demonstrates actual expiry; real stock and rate changes demonstrate unavailable/price-changed rechecks. These stubs do not establish hosted or authoritative acceptance. Local history past-date setup is a controlled criteria-only fixture, not an availability response.

No API/domain/evaluator code changed; affected API suites were not required. Existing domain tests and the database-backed strict-role browser boundary/evaluator journey were run. This UI mission does not recertify a production database or close F01.

## Gates

| Gate | Result |
| --- | --- |
| AGENT_HOME_LAYOUT | PASS_LOCAL |
| DESTINATION_RESOLUTION | PASS_LOCAL_CITY_HOTEL; AREA_UNSUPPORTED |
| DATE_VALIDATION | PASS_LOCAL |
| OCCUPANCY_VALIDATION | PASS_LOCAL_SUPPORTED_SCOPE; MIXED_ROOM_GAP |
| NATIONALITY_PROPAGATION | PASS_LOCAL |
| CURRENCY_INTEGRITY | PASS_LOCAL_AED |
| RECENT_SEARCH_ISOLATION | PASS_LOCAL |
| SEARCH_CONTEXT_PRESERVED | PASS_LOCAL |
| PAGINATION | PASS_LOCAL |
| HUNDRED_HOTEL_ACCESS | PASS_LOCAL_100_UNIQUE |
| AUTHORITATIVE_RECHECK | PASS_LOCAL_STRICT_ROLE |
| RECHECK_STATES | PASS_LOCAL_ALL_FOUR |
| BOOKING_FAIL_CLOSED | PASS_LOCAL |
| ACCESSIBILITY | PASS_TESTED_KEYBOARD_BOUNDS_AXE |
| AGENT_BUILD | PASS |
| API_URL_GUARD | PASS |
| CLIENT_SECRET_CHECK | PASS |
| FINAL_HEAD_CI | PENDING; see final PR/head report |
| LOCAL_BROWSER_ACCEPTANCE | PASS_LOCAL_50_MVP_AND_23_HOME |
| HOSTED_AGENT_MVP | NOT_VERIFIED |

## Safety

PRODUCTION_DB_MIGRATION_EXECUTED=NO
PERSISTENT_ROLE_PROVISIONING_EXECUTED=NO
PRODUCTION_DEPLOYMENT_EXECUTED=NO
DNS_OR_ALIAS_CHANGED=NO
LIVE_SUPPLIER_ENABLED_BY_THIS_WORK=NO
BOOKING_ENABLED_BY_THIS_WORK=NO
PAYMENT_ENABLED_BY_THIS_WORK=NO
PR_MERGED_BY_THIS_SESSION=NO
F01_STATUS=OPEN
F01_PINNED_CANDIDATE=aea042299bdc2b7fbc33945b0cb89ba0a7a04238

Final commit/tree, draft PR link and exact-final-head CI conclusions are recorded in the final session report after publishing the final branch head; this committed record leaves that gate pending until observed.
