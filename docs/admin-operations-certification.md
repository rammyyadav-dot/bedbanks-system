# fBeds — Admin Operational Layer Certification

Scope: make Admin an authoritative, read-mostly operations control plane for the Dubai MVP (about 100 hotels). Evidence below was produced on a **disposable local PostgreSQL** (`fbeds_ci`) only. No production deployment, production database, live supplier, live booking or live payment was touched.

## Verdict

**ADMIN MVP: CERTIFIED WITH CONDITIONS.** The code, API, tenant isolation, RBAC, the 100-hotel acceptance and the real-stack browser checks pass on the disposable database. One condition is human-owned and blocks *production* operation of the transaction views:

> `RUNTIME_RLS=BLOCKED` for transaction tables. The production API role `fbeds_api_login` has, by design (ADR 0008), no read grants on `Booking`, `InventoryHold`, `Cancellation`, `LedgerEntry`, `Wallet`, `BookingDocument`, `Connector*`, and no write grants needed for reconcile. Until a human reviews grants (options in ADR 0013), those Admin views show a distinct "not readable by the API role" state (HTTP 503 `OPERATIONS_READ_DENIED`), never an empty list or zeros. RLS itself was proven under a non-bypass test role (`ADMIN-RLS`), not under the production login role.

## A. Release identity
STARTING_SHA=e8c92d2 (origin/main) · BRANCH=`claude/charming-goodall-0jo555` · FINAL_SHA and DRAFT_PR are in the PR body.

## B. Admin route inventory (`apps/admin/app`, `page.tsx`)
TOTAL_ADMIN_ROUTES=50 · AUTHORITATIVE_API_BACKED=38 (12 added or rewritten here; 26 pre-existing) · MOCK=0 · PLACEHOLDER=10 · BROKEN=0 observed · NOT_API_BACKED_BY_DESIGN=2 (`/` redirect, `/login`) · UNUSED=not measured.
Of the 26 pre-existing API-backed pages, 10 were exercised in a browser against the real API in this mission (`/dashboard /suppliers /hotels /rooms /mappings /contracts /rates/plans /rates /sellability /board-basis`; `/rooms` correctly showed "Access restricted" for a role without `supply.rooms.read`); the rest were not individually re-verified here.

## Mock-removal table
No mock module, mock import or demo-data flag exists in Admin (guarded by `lib/admin-mvp-guards.test.ts`, which also scans the new pages). The "before" state was explicit "not enabled" placeholders.

| Admin area | Before | After | Data source | Remaining mock |
|---|---|---|---|---|
| Bookings list | placeholder | server-paginated, filtered, flags | `GET /admin/operations/bookings` | none |
| Booking 360 | placeholder | full chain view | `GET /admin/operations/bookings/:id` | none |
| Inventory holds + detail | absent | list, detail with night-level inventory | `/admin/operations/holds[/:id]` | none |
| Reconciliation | absent | queue + confirmed reconcile action | `/admin/operations/reconciliation[/run]` | none |
| Cancellations | placeholder | recorded vs posted refund | `/admin/operations/cancellations` | none |
| Wallets | placeholder | ledger-derived balance, credit | `/admin/operations/wallets` | none |
| Ledger | placeholder | immutable entries, filters | `/admin/operations/ledger` | none |
| Audit explorer | placeholder | sanitised events, request-id filter | `/admin/operations/audit` | none |
| Connector health | absent | status, last runs, credential presence only | `/admin/operations/connectors` | none |
| Operational readiness | absent | API-computed supply/transaction/connector counts | `/admin/operations/readiness` | none |
| Hotel readiness | absent | per-hotel READY/BLOCKED + reason codes | `/admin/operations/hotels` | none |
| Suppliers, hotels, rooms, mappings, contracts, rate plans, rates, availability, stop-sell, sellability, board basis, dashboard, settings, access | API-backed | unchanged | existing `/supply/*`, `/admin/*` | none |
| Finance (summary), payments, reports, notifications, pricing, distribution, tenants (+detail), users (+detail) | placeholder | **still placeholder**, labelled "not enabled" | none | 0 mocks; 10 non-launch-critical placeholders |

LAUNCH_CRITICAL_MOCKS_BEFORE=0 · REMOVED=0 · REMAINING=0. Launch-critical placeholders replaced: 6 (bookings, booking detail, cancellations, wallets, ledger, audit).

## Authority matrix
| Domain | Authoritative source | Admin read | Admin write | RBAC | Audit |
|---|---|---|---|---|---|
| Supplier | `Supplier` | yes | yes (existing) | `supply.suppliers.*` | existing supply audit |
| Hotel | `Hotel` | yes | yes (existing) | `supply.hotels.*` | existing |
| Room | `RoomType` | yes | yes (existing) | `supply.rooms.*` | existing |
| Mapping | `SupplierHotelMapping`, `SupplierRoomMapping` | yes | yes (existing) | `supply.mappings.*` | existing |
| Contract | `Contract` + policies | yes | yes (existing) | `supply.contracts.*` | existing |
| Rate | `RatePlan`, `DailyRate` | yes | yes (existing) | `supply.rates.*` | existing |
| Availability | `DailyAvailability` | yes | yes (existing) | `supply.availability.*` | existing |
| Hold | `InventoryHold(+Night)` | yes | no | `booking.read` | agent flow audits |
| Booking | `Booking` | yes | no | `booking.read` | agent flow audits |
| Reconciliation | existing `BookingReconciliationService` | yes | **action only** (existing idempotent service) | `booking.reconcile` | service audits `booking.reconciled` / `booking.prebook.expired` |
| Cancellation | `Cancellation` + ledger | yes | no | `booking.cancel` | agent flow audits |
| Wallet | `Wallet` + ledger sum | yes | no | `finance.read` | n/a (read) |
| Ledger | `LedgerEntry` (immutable) | yes | no | `finance.read` | n/a (read) |
| Audit | `AuditEvent` | yes | no | `audit.read` | n/a (read); denials audited by the guard |

Write is marked only where Admin writes. Everything under `/admin/operations` is read-only except the single reconcile action.

## Defect records
| ID | Expected | Actual | Reproduction | Root cause | Class | Fix | Regression test |
|---|---|---|---|---|---|---|---|
| D1 | main green | 13 API unit + 5 Agent tests failed from 2026-10-02 | run unit suites on `e8c92d2` | tests hard-coded `checkIn 2026-10-01`, now in the past | P1 test-only (red CI) | relative dates (`d3bcd26`, `00b2d0a`) | the same specs |
| D2 | main green | 8 `packages/domain` tests failed | `pnpm -r test` | same hard-coded date | P1 test-only | relative dates (`db27ddf`) | `search-offers.test.cjs` (3/30 nights accepted, 61 rejected) |
| D3 | wallets show real drift only | my "cache vs ledger" flag showed permanent DRIFT | browser check `/finance/wallets` | `Wallet.cached_balance` is written by no code path; I treated it as a signal | P2, my defect (committed, then fixed before the PR) | removed the signal; ledger sum is the only authority | `ADMIN-LEDGER`; browser check |
| D4 | invalid filter is a 400 | supplier `status` filter passed unchecked to Prisma (would 500); first fix omitted `PENDING_REVIEW` | self-review | missing enum validation | P2, my defect | `enumParam` with the real enum | `ADMIN-SUPPLY` (valid, empty and invalid values) |
| D5 | WCAG AA contrast | shared Admin chrome (breadcrumb, eyebrow, page text, pagination caption) and my filter bar failed axe | axe on 4 pages | low-contrast greys in `globals.css`/inline styles | P2 (pre-existing + mine) | darkened tokens; explicit filter colours | browser axe checks (0 serious/critical) |
| D6 | hold-sweeper e2e passes locally | 1 failure with a bare `DATABASE_URL` | `inventory-hold.e2e-spec.ts` | the spec appends `&application_name=…`, assuming CI's `?schema=public` URL | environment, not a code defect | none needed; documented | passes with the CI URL; identical failure on pristine main |

## Test results (disposable DB)
| Check | Result |
|---|---|
| `pnpm -r --if-present type-check` | exit 0 |
| `pnpm -r --if-present lint` | exit 0 |
| API unit (jest) | 42 suites, 352 tests, 0 failed |
| API e2e (CI-form `DATABASE_URL`) | 28 suites, 176 tests, 0 failed (before the last 2 assertions added to existing specs; both re-run: 24/24) |
| Admin unit | 23/23 (includes route/mock/float/no-silent-failure guards) |
| Agent / Supplier / Website | 63 / 4 / 54 pass |
| `packages/domain` / `packages/money` | 20 / 3 pass |
| `ADMIN-RLS`, `ADMIN-DENIED`, isolation | pass (`test/admin-operations.e2e-spec.ts`: 15 tests) |
| Dubai 100-hotel (existing fixture, extended) | 9 tests, including the Admin acceptance |
| Real-stack browser (`tools/admin-ops-verify`) | 37/37 |
| `check:architecture`, `check:schema`, `prisma:validate` | pass |
| Migration status / drift | up to date; "No schema drift" (no schema or migration change in this branch) |
| Builds: API, Admin, Agent, Supplier, Website | all exit 0 |

`check:no-float` only scans 2 money-path files; Admin money safety is enforced by `admin-mvp-guards.test.ts` (no `parseFloat`, `.toFixed`, or `Number(minor)/100`) and all money crosses the API as integer strings.

## ADMIN-01..25 coverage
| ID | Where |
|---|---|
| 01 unauthenticated denied | Dubai spec (401 on 4 routes) |
| 02/03 permission denied / allowed | Dubai spec (403 / 200); `operations.controller.spec.ts`; browser viewer vs owner |
| 04 cross-tenant | `ADMIN-ISOLATION`, `ADMIN-RLS`, Dubai spec, browser tenant B |
| 05–07 supplier / hotel / room | `ADMIN-SUPPLY`, Dubai spec, existing `supply.e2e-spec.ts` |
| 08/09 mappings visible | Dubai spec (100 hotel and 100 room mappings), `ADMIN-SCENARIOS B,C` |
| 10–13 contract / rate / availability / stop-sell | existing `supply.e2e-spec.ts`; `ADMIN-SCENARIOS D–G`; readiness |
| 14 sellability reason | existing inspector; readiness uses the same `evaluateNightSellability` |
| 15 holds | `ADMIN-SCENARIOS I` |
| 16–17 booking search / 360 | `ADMIN-BOOKING-360`, `ADMIN-PAGING`, browser |
| 18 reconciliation | `ADMIN-RECON`, browser (confirm, one POST, request id) |
| 19 cancellations | `ADMIN-CANCEL` |
| 20 documents read-only | `ADMIN-DOCS` |
| 21/22 wallet / ledger | `ADMIN-LEDGER` |
| 23 audit sanitised | `ADMIN-23` |
| 24 no fake fallback | `ops-state.test.ts`, guard test, browser 401/403/503/500/network/empty |
| 25 pagination beyond page 1 | `ADMIN-PAGING`, Dubai spec (4 pages of 25) |

Scenarios A–L: `ADMIN-SCENARIOS` (A–J), `ADMIN-RECON` (K), `ADMIN-CANCEL` (L). The operator sees canonical reason codes (`SUPPLIER_MAPPING_INVALID`, `ROOM_MAPPING_UNAPPROVED`, `OUTSIDE_CONTRACT_VALIDITY`, `DAILY_RATE_MISSING_OR_INVALID`, `AVAILABILITY_MISSING`, `STOP_SELL`, `NO_INVENTORY`) without SQL.

## Dubai 100-hotel acceptance (existing fixture, extended in place)
DUBAI_HOTELS_VISIBLE=100 · HOTEL_51_PLUS and HOTEL_100 located by search and by page position · PAGINATION=4×25, never the whole set in one response · FILTERING=readiness, mapping, content status, name prefix · SELLABILITY_DIAGNOSTICS=100 READY, 100 stop-sell plans surfaced · readiness for 100 hotels × 3 plans × 7 nights computed in about 2 s (one request).

## Open items
| Severity | Area | Blocker | Evidence | Required action |
|---|---|---|---|---|
| P1 | Production access | Transaction views unreadable on the production runtime role; reconcile needs privileges it lacks | ADR 0008 self-check; `ADMIN-DENIED` | Human decision on grants (ADR 0013 options A/B); until then views show the explicit denied state |
| P2 | Scale | Pre-existing supply lists (`/supply/hotels`, `contracts`, `rate-plans`, `mappings`, rooms) return full arrays and their pages filter client-side. Fine at about 100 hotels; the new `/operations/hotels` is the paginated view | code | Add pagination to those endpoints before scaling past the MVP |
| P2 | Data | The supplier booking reference is not persisted; Booking 360 says so instead of inferring | `supplierBookingReference: null` | Schema change plus decision in the Supplier #1 mission |
| P2 | Data | `Wallet.cached_balance` is maintained by no code path | grep | Remove the column or maintain it (migration, human review) |
| P2 | Tests | No browser CI for Admin; browser checks are a manual script | `tools/admin-ops-verify` | Add a CI job once an API fixture job exists |
| P3 | Docs | ADR numbering has two `0011` files | `docs/adr` | Renumber (pre-existing) |

OPEN_P0=0 · OPEN_P1=1.

## Safety
PRODUCTION_DEPLOYED=NO · PRODUCTION_DB_MUTATED=NO · LIVE_SUPPLIER_USED=NO · LIVE_BOOKING_CREATED=NO · LIVE_PAYMENT_PROCESSED=NO. The seed script refuses any database other than local `fbeds_ci`. No historical migration, `_prisma_migrations` row or schema file was touched. No secret value is stored or logged; connector views return credential presence only.
