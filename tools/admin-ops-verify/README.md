# Admin operations browser verification

Real-stack check of the Admin operations views: a real API process, the production Admin build and headless Chromium.
It is **not** wired into CI (Admin has no browser CI yet); run it by hand against a **disposable local database only**.

`seed.ts` refuses any `DATABASE_URL` other than `postgresql://…@localhost:5432/fbeds_ci` (optionally `?schema=public`).

```bash
export DATABASE_URL='postgresql://postgres:postgres@localhost:5432/fbeds_ci?schema=public'
export MAPPING_DATABASE_URL="$DATABASE_URL" REDIS_URL=redis://127.0.0.1:6379
pnpm --filter @bedbanks/api prisma:migrate:deploy

# 1. API (secure cookies are mandatory; Chromium accepts them on http://localhost)
NODE_ENV=development API_PORT=3002 API_HOST=127.0.0.1 AUTH_COOKIE_SECURE=true TRUSTED_ORIGINS=http://localhost:3000 \
  HOLD_EXPIRY_SWEEP_ENABLED=false BOOKING_ENABLED=false pnpm --filter @bedbanks/api start &

# 2. Admin production build
pnpm --filter @bedbanks/admin-console build
API_INTERNAL_URL=http://localhost:3002/api/v1 AUTH_API_ORIGIN=http://localhost:3000 \
  pnpm --filter @bedbanks/admin-console exec next start -p 3000 &

# 3. Seed (re-run before each verify: the reconcile step consumes the stuck booking) and verify
(cd apps/api && NODE_ENV=test node --no-experimental-strip-types -r @swc-node/register ../../tools/admin-ops-verify/seed.ts)
node tools/admin-ops-verify/verify.cjs
```

It checks: every operations view shows API data; Booking 360 links; reconcile needs a confirmation and a double click sends one POST;
401/403/503-denied/500/network/empty render distinct states (responses are intercepted in the test only, the app has no mock path);
axe WCAG A/AA on four pages; a viewer without `booking.read` sees FORBIDDEN and no operations navigation; tenant B cannot see tenant A.

## Hotel commercial workspace

`seed-hotels.ts` creates tenant A with 34 hotels (ready, partial and blocked scenarios, enough to paginate), a viewer holding only `supply.hotels.read`,
and tenant B with one hotel; `verify-hotels.cjs` then drives the production Admin build in Chromium. Same disposable-database guard as above.

```bash
(cd apps/api && NODE_ENV=test node --no-experimental-strip-types -r @swc-node/register ../../tools/admin-ops-verify/seed-hotels.ts)
node tools/admin-ops-verify/verify-hotels.cjs
```

It checks the list (summary, server pagination, search, every filter, shareable URLs, empty state), the failure states (401, 403, 503 denied, 500, network),
every Hotel 360 tab, the sellability inspector (including a multi-night failure and a double click), exceptions, forbidden and tenant-B behaviour,
keyboard use, horizontal overflow at 1280 / 768 / 390 px, and axe (WCAG A/AA) on the list, Hotel 360, Rates & Inventory, the inspector and exceptions.

## Hotel Operations (ADR 0021)

`verify-hotels.cjs` also covers Hotel Setup, rooms, amenities, policies, images, supplier mapping governance, Quick Update, Distribution & Readiness, the directory's identifier search, a read-only user and a cross-tenant request. Re-seed with `seed-hotels.ts` before every run: the run edits the seeded hotels (it publishes one, creates mappings and applies a rate change), so a second run on the same seed starts from changed data.

## Hotel readiness for stated criteria (ADR 0038)

`verify-hotel-readiness.cjs` drives the readiness panel on Distribution & Readiness after `seed-hotels.ts`: seven gates, scope and limitation text, blockers by gate (mapping, rate, availability, no rate plan, draft hotel), navigation into the existing tabs, child-age fields, invalid criteria, 503, 500 and network failures, double submit, keyboard use, overflow at 1280 / 768 / 390 px, axe, a viewer without `supply.rates.read` and a cross-tenant request. Run it against an API that connects as the provisioned non-owner runtime role (`provisionApiRuntimeRole`), not the owner: the point is to see privilege-denied evidence reported as UNKNOWN.

```bash
(cd apps/api && NODE_ENV=test node --no-experimental-strip-types -r @swc-node/register ../../tools/admin-ops-verify/seed-hotels.ts)
node tools/admin-ops-verify/verify-hotel-readiness.cjs
```

`verify-hotels.cjs` expects an owner-connected API (its Bookings tab reads tables the runtime role is denied by design); the two scripts are run against different API principals.

## Agency credit limit

`seed-credit.ts` creates a tenant with an agency and two Admin users who can read and manage agencies; `verify-credit.cjs` drives the Credit panel in Chromium (request, a second person approves and applies, removal is also a request). Same disposable-database guard as above.

```bash
(cd apps/api && NODE_ENV=test node --no-experimental-strip-types -r @swc-node/register ../../tools/admin-ops-verify/seed-credit.ts)
node tools/admin-ops-verify/verify-credit.cjs
```

## Hotel images

`verify-images.cjs` reuses the hotels seed (`seed-hotels.ts`, reseed first) and drives the Images tab in Chromium with real, decodable PNGs: upload, size and type refusals, duplicate refusal, primary, order, alt text, delete, persistence, phone overflow, and a read-only user.

```bash
node tools/admin-ops-verify/verify-images.cjs
```

## Agent hotel thumbnail

`seed-agent-images.ts` creates a tenant with two published, sellable Dubai hotels (one with a real decodable primary image), plus an Agent user. `verify-agent-images.cjs` signs in to the production **Agent** build (port 3003), searches Dubai and checks the thumbnail, the initial-mark fallback, the detail header and overflow. Start the API with `TRUSTED_ORIGINS=http://localhost:3003` and the Agent with `cd apps/agent && pnpm exec next start -p 3003`.

```bash
(cd apps/api && NODE_ENV=test node --no-experimental-strip-types -r @swc-node/register ../../tools/admin-ops-verify/seed-agent-images.ts)
node tools/admin-ops-verify/verify-agent-images.cjs
```

## Inventory & Allotment (ADR 0030)

`seed-inventory.ts` creates a Dubai hotel whose three plans share a pool of 5, a hotel with no pool, an Admin owner, a read-only viewer, an Agent and a second tenant. `verify-inventory.cjs` drives the production **Admin** (:3000) and **Agent** (:3003) builds: Hotels → hotel → Inventory & Allotment → pool → Quick Update → preview → apply → reload → Agent search → offer → Admin changes the pool → recheck is unavailable; on-request is not selectable; loading / empty / unavailable states; a read-only account; overflow at 1280/768/390; axe. Start the API with `TRUSTED_ORIGINS=http://localhost:3000,http://localhost:3003`.

`inventory-scale.ts` (run from `apps/api` with `N=1|10|100`) seeds N hotels with pooled plans plus exhausted, on-request and closed-to-departure cases, compares Agent search with the expected result for every plan, times search and the Admin summary, and checks exactly-once pool allocation under concurrency. It prints observed numbers only.

## Hotel setup journey on the strict API role (ADR 0032)

`seed-hotel-journey.ts` creates one empty tenant with two Admin users (maker and checker); `verify-hotel-journey.cjs` drives the whole journey in Chromium against an API
process connected as the **provisioned, non-superuser, non-BYPASSRLS runtime login role** (never the owner): Add hotel hands off into Hotel Setup, the profile saves, a room is created
with bedding and an amenity then archived and restored, hotel amenities save, an image uploads and decodes, an image is uploaded before publication (ADR 0058), completeness reaches 13 of 13, a second person approves publication,
the hotel is COMPLETE, and a privileged column answers the typed 403. Disposable local database only (`fbeds_ci` or `p0N_*`).

```bash
# owner connection: migrate, then provision the runtime role (generated password, kept out of the shell history) and seed
pnpm --filter @bedbanks/api prisma:migrate:deploy
PROVISION_DATABASE_URL=<owner url> API_RUNTIME_LOGIN_PASSWORD=<generated 32+ char URL-safe secret> pnpm --filter @bedbanks/api ops:provision-api-runtime-role
(cd apps/api && NODE_ENV=test node --no-experimental-strip-types -r @swc-node/register ../../tools/admin-ops-verify/seed-hotel-journey.ts)
# start the API with DATABASE_URL = the runtime login URL and the Admin build as above, then:
node tools/admin-ops-verify/verify-hotel-journey.cjs
```


## Rate certification (ADR 0033)

`seed-rate-certification.ts` creates a tenant with one hotel per rate-audit scenario (clean, zero amount, NET with and without a markup rule, rate gap, inactive plan, logical duplicate, unverified basis, wrong currency, recorded markets, bad code format, other-occupancy rows), a viewer holding only `supply.hotels.read` and a second tenant. `verify-rate-certification.cjs` drives the page, the plan detail, the simulator and the report downloads in Chromium and checks that the only non-GET request is the simulator. Re-seed before every run. Same disposable-database guard as above.

```bash
(cd apps/api && NODE_ENV=test node --no-experimental-strip-types -r @swc-node/register ../../tools/admin-ops-verify/seed-rate-certification.ts)
node tools/admin-ops-verify/verify-rate-certification.cjs
```

## Pool capacity editor and per-plan consumption (ADR 0036)

`seed-pool-capacity.ts` creates one hotel whose three plans share a pool of 10 with holds in five lifecycle states made through the production hold services (held, confirmed, released, confirmed-then-cancelled), a night at its committed floor, a second hotel whose pool has no stock rows, and four users (operator with preview and apply, preview-only, read-only, other tenant). `verify-pool-capacity.cjs` drives the workspace, the editor, the stale-preview conflict, the failure states, keyboard use, overflow and axe in Chromium. Re-seed before every run. Same disposable-database guard as above. Run the API as the provisioned strict runtime login (see the Hotel setup journey section): Apply and attribution both work there.

```bash
(cd apps/api && NODE_ENV=test node --no-experimental-strip-types -r @swc-node/register ../../tools/admin-ops-verify/seed-pool-capacity.ts)
node tools/admin-ops-verify/verify-pool-capacity.cjs
```

## Agent Dubai MVP completion (docs/agent-dubai-mvp-completion.md)

`seed-agent-mvp.ts` creates 30 filler Dubai hotels plus one hotel per scenario (image, long names, shared pool of 1 over three plans, stale supplier, ON_REQUEST, CLOSED, price change, sold-out), Agent users and a second tenant. `verify-agent-mvp.cjs` drives the production Agent build (:3003) against the real API on the strict runtime login (:3002; a second API with `AGENT_OFFER_TTL_MS=1500` on :3004 for the real server-side expiry check): login and session, search and pagination, details, recheck outcomes, shared pool, cross-tenant, failure and retry, responsive, keyboard and axe, and no-allocation counters. It needs `OWNER_DATABASE_URL` for fixtures and read-only evidence. Same disposable-database guard as above; re-seed before every run.

## Admin bookings list and detail (ADR 0039, Phase 1)

`seed-bookings.ts` creates one tenant with 40 bookings (all ten statuses, four agencies, five hotels, USD/GBP/EUR/AED, Urgent-like and missing-supplier-ref cases, some Unassigned) and three users (`ops`, `opsall`, `agency`). `verify-bookings.cjs` drives the production Admin build against the API on the strict runtime login with the booking module on its own SELECT-only role (`BOOKING_OPS_DATABASE_URL`, see `docs/booking-module-README.md`): Needs-action landing, masking, filters in the URL, detail tabs, the unavailable operations record, axe, mobile width, agency scoping, read-only network, and a real 503 when the booking role is disabled (needs `OWNER_DATABASE_URL`). Same disposable-database guard; re-seed before a run.

```bash
(cd apps/api && NODE_ENV=test node --no-experimental-strip-types -r @swc-node/register ../../tools/admin-ops-verify/seed-bookings.ts)
OWNER_DATABASE_URL=<owner url> node tools/admin-ops-verify/verify-bookings.cjs
```

`seed-bookings.ts` also creates `lead` (every booking action) and `requester` (agency user, request only). `verify-booking-actions.cjs` (Phase 2) drives the action dialogs (modal, keyboard, axe, stale-status conflict, second confirmation, reference edit), manual entry and the agency/read-only views in Chromium, with the API started as above plus `ADMIN_MANUAL_BOOKING_ENABLED=true`. Re-seed before each run.

```bash
OWNER_DATABASE_URL=<owner url> node tools/admin-ops-verify/verify-booking-actions.cjs
```

`verify-booking-supplier.cjs` (Phase 3) needs the API started with the runner and the mock supplier allowed for the seeded tenant, so seed first, then start the API:
`ADMIN_MANUAL_BOOKING_ENABLED=true ADMIN_SUPPLIER_JOBS_ENABLED=true BOOKING_JOB_RUNNER_ENABLED=true BOOKING_JOB_RUNNER_INTERVAL_MS=1000 ALLOW_MOCK_SUPPLIER=true MOCK_SUPPLIER_TENANT_IDS=<tenant from .seed-bookings.json>`.
It drives manual entry with "send now", the confirmed, ghost (timeout but booked), unreachable (unknown, never failed), flaky (Retry now) and unconfigured cases, axe on the Supplier tab, and the operator without permission and agency views.

```bash
OWNER_DATABASE_URL=<owner url> node tools/admin-ops-verify/verify-booking-supplier.cjs
```

`verify-booking-ops.cjs` (Phase 4) drives the operations queue in Chromium: Flow A (unknown supplier answer: marked uncertain, sync offered, send withheld, evidenced "no booking exists", then one safe resend), Flow B (cancellation refused: Urgent, still Cancel requested, timeline), Flow C (claim, My queue, another operator sees the owner, audit), Flow D (deterministic SLA breach and ordering), plus permission views and axe. Seed first (it creates the deterministic fixtures and the `lead`, `worker`, `worker2`, `opsviewer` users), start the API with `ADMIN_BOOKING_OPS_ENABLED=true` in addition to the Phase 3 switches, then:

```bash
OWNER_DATABASE_URL=<owner url> node tools/admin-ops-verify/verify-booking-ops.cjs
```

`verify-booking-finance.cjs` (Phase 5) drives money and documents in Chromium against the seeded finance fixtures: cancel with a penalty (preview before confirming, penalty fixed at the request, correct invoice, credit note and cancellation note), a booking with no stored terms (needs a decision, credit note withheld, decided, then issued), a waiver by a second person (raising refused), the voucher without net rate or supplier, read-only viewer, no-permission operator and agency user, and the manual-entry rules. Same stack and `OWNER_DATABASE_URL` as the other booking harnesses (seed first; the fixtures are consumed by a run, so re-seed to repeat).

```bash
OWNER_DATABASE_URL=<owner url> node tools/admin-ops-verify/verify-booking-finance.cjs
```

`verify-booking-views.cjs` (Phase 6A/6B) drives saved views and the new filters in Chromium: save, open (the URL is the normal booking query and the count matches), changed marker, update, rename, duplicate name (case-insensitive), save as new, default (applied only on a blank visit), reset, delete, audit without filters, a stale and a restricted view (never applied), privacy between two people (404, no hijack), no toolbar without the permission, destination, source and currency-with-amount filters in minor units, unsupported field and incomplete amount range rejected by the API, axe and 390 px. `seed-bookings.ts` adds the `views2` user. Same stack and `OWNER_DATABASE_URL` as the other booking harnesses; re-seed to repeat.

```bash
OWNER_DATABASE_URL=<owner url> node tools/admin-ops-verify/verify-booking-views.cjs
```

`verify-booking-bulk.cjs` (Phase 6C) drives bulk actions in Chromium on the strict-role stack with its own fixtures: capability gating (and the direct API refused for someone without it), row selection, select page and clear (no write), confirmation and owner required, all-success, partial (mixed selection), stale (a booking changed after selection), double click and network failure with retry (one operation), and acknowledge; with database evidence for each effect, event and audit, and axe on the dialogs. Re-seed before each run.

## Agent search-first home

`verify-agent-home-search.cjs` drives the production Agent home, calendar, guest and nationality controls, criterion invalidation and account-local recent search replay/removal against the same strict-role disposable runtime as `verify-agent-mvp.cjs`. Seed with `seed-agent-mvp.ts`; `FILLERS=94` makes 100 visible Dubai hotels for the MVP pagination journey. Application API connections must use the restricted runtime login; the seed and failure-scenario SQL use the disposable owner separately. Run the MVP harness before adding an extra membership for tenant-switch checks.

```bash
CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium SHOT_DIR=<evidence directory> node tools/admin-ops-verify/verify-agent-home-search.cjs
OWNER_DATABASE_URL=<disposable owner> CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium SHOT_DIR=<evidence directory> node tools/admin-ops-verify/verify-agent-mvp.cjs
```

The executable override is optional; without it Playwright uses its installed Chromium. Destination delay/failure interception is marked `[stub]` or `[injected]` and establishes UI presentation only. Home checks cover 1280/768/390px, popup bounds and Escape focus, canonical destination keyboard selection/free text refusal, date draft cancellation and invalid ranges, child ages, honest mixed-occupancy rejection, canonical nationality search/AED, real search/recheck context, stale result invalidation, fresh history replay/removal, real two-room/child-age recheck, same-account tenant switching, injected pagination/recheck/missing-mapping failures with real retry, and axe on the home and open calendar. Mixed occupancy remains an adapter gap: the domain accepts separate rooms, but contracted inventory currently prices only identical room occupancies. Area resolution remains unsupported.

## Hotel Rate Plans tab (ADR 0041)

`verify-rate-plans.cjs` drives the Rate Plans tab after `seed-hotels.ts` (owner-connected API, `NODE_ENV=test`, disposable `p0N_*` database; re-seed before every run). It arranges three extra plans on a ready hotel, then checks through the UI: tab and counts against the API, status filter and code search, the readiness checklist against `GET .../readiness` check by check, a refused activation, a successful activation (row, counts, one audit event), suspension with a required reason, a stale-version error, clone as DRAFT, the Rates & Inventory and Quick Update tabs, read-only status on the rate plan form, keyboard, overflow at 1280 / 768 / 390 px, axe, a viewer without `supply.rates.read`, and tenant B.

```bash
(cd apps/api && NODE_ENV=test node --no-experimental-strip-types -r @swc-node/register ../../tools/admin-ops-verify/seed-hotels.ts)
node tools/admin-ops-verify/verify-rate-plans.cjs
```

## Agent search only offers ACTIVE rate plans (ADR 0041)

`verify-agent-suspended-plan.cjs` runs after `seed-agent-mvp.ts` against the strict-role API (:3002): it suspends, drafts and expires one hotel's plans through the owner connection, searches as an Agent over HTTP, checks the hotel disappears (and the others stay), restores ACTIVE and checks the count returns to baseline and that searching created no hold, booking or ledger row. `OWNER_DATABASE_URL` must be a disposable local database.

## Enterprise Hotel Overview (ADR 0050)

`seed-hotel-journey.ts` now supplies a read-only account as well as maker/checker. `verify-hotel-journey.cjs` adds real persisted overview reads, linked operational summaries, publication-versus-sellability, property archive, private-contact/RBAC checks, 320/390/768/1280/1440px bounds and axe. Set `PLAYWRIGHT_EXECUTABLE_PATH` for system Chromium and `SHOT_DIR` for screenshots. Use a fresh seed for each run and an API authenticated as the verified strict runtime login. No production endpoint or fixture data is required.

## Admin blueprint features (ADR 0051, 0053, 0054 slice 1)

`verify-admin-blueprint.cjs` checks the Business navigation group, Hotels saved views, summary profile-status tiles, CSV export, bulk owner assignment, the Search Monitor, Payables, breadcrumbs, and a read-only viewer who sees none of the new controls. After `seed-hotels.ts`, run `su postgres -c "bash tools/admin-ops-verify/grant-blueprint-perms.sh fbeds_ci"` (grants the seeded owner role `supply.hotels.export`, `audit.read`, `finance.read`; adds sample search events and a net amount), then the script. Re-seed before every run: bulk owner assignment changes the seeded hotels. The API in this check needs `NODE_ENV=test DB_RUNTIME_ROLE_GUARD=off` only because the local database user is the owner; never use that outside a disposable database.

## Quick Update (ADR 0021 stage 5 / ADR 0067)

`seed-quick-update.ts` creates a tenant with one hotel, three AED rate plans (two share dates and prices for a multi-plan scope; one is a DRAFT plan to show an INVALID row) plus a GBP plan to exercise the single-currency guard, an owner, a read-only viewer, and a second tenant. `verify-quick-update.cjs` drives the Quick Update tab in Chromium through: SET price across plans and ranges; the ADR 0067 F-13 large-price-change guardrail (disabled Apply until confirmed); fingerprint staleness (a concurrent database edit between preview and apply is refused, nothing written); idempotent replay of the exact apply request (`replayed:true`, no second audit event or write); ADJUST by percent and by amount (BigInt half-away-from-zero basis points); seasons (non-overlapping date windows); an occupancy-priced rate (ADR 0067 F-05; the plan's own occupancy rows stay untouched); a weekday filter with stop-sell SET then CLEAR; restrictions (minStay, closedToArrival, a release override); a mixed-currency scope refused before anything is written; a viewer without `supply.rates.manage` refused even by a direct API call; and tenant B refused not-found against tenant A's hotel. Every assertion reads real `DailyRate`/`DailyAvailability`/`AuditEvent` rows back in integer minor units (BigInt). Re-seed before every run: the run writes real rates and inventory. Same disposable-database guard as above.

```bash
(cd apps/api && NODE_ENV=test node --no-experimental-strip-types -r @swc-node/register ../../tools/admin-ops-verify/seed-quick-update.ts)
node tools/admin-ops-verify/verify-quick-update.cjs
```

## Promotions and contract supplements (ADR 0089 / ADR 0067)

`seed-promotions-supplements.ts` creates a tenant with an ACTIVE contract carrying a BOARD supplement (a meal-plan charge, every night) and a COMPULSORY supplement (once per stay) plus one ACTIVE rate plan, a second DRAFT contract for the Admin UI's add/remove-supplement flow, a maker and a checker, a read-only viewer, and a second tenant. `verify-promotions-supplements.cjs` drives: adding and removing board/compulsory supplements through the real contract policy editor (with direct-API validation of currency, amount and a BOARD supplement with no board named); a promotion's full draft → validate → submit → approve (a different person, self-approval refused even by direct API call) → activate lifecycle, with exactly one audit event per step; idempotent creation (replaying the exact captured create request returns the same promotion, never a second one; reusing the key for different terms is a 409); and the `HotelDealPreviewNight` math (`promotionMinor` / `supplementMinor` / `netMinor` / `markupMinor` / `sellMinor`) checked against real `DailyRate` and `ContractSupplement` rows in integer minor units — supplements are never discounted by the promotion, and a SELL-basis rate carries no markup. Finishes with tenant B refused not-found on every route and a read-only viewer seeing no action buttons. Re-seed before every run. Same disposable-database guard as above.

```bash
(cd apps/api && NODE_ENV=test node --no-experimental-strip-types -r @swc-node/register ../../tools/admin-ops-verify/seed-promotions-supplements.ts)
node tools/admin-ops-verify/verify-promotions-supplements.cjs
```

## Room occupancy rules and extra-bed/child-supplement pricing (ADR 0021 stage 2 / ADR 0057 S6 / ADR 0067 F-03)

"Extra bed" is not a priced room feature in this codebase: `RoomBedding.extraBed` (Supported / Not supported / Not recorded) is descriptive only and carries no price; the money is `Contract.ChildPolicy`'s age-banded `extraBedAllowed` + `supplementMinor`, applied through the guest-pricing evaluator. `seed-room-occupancy.ts` creates a tenant with one hotel (a room with a valid occupancy triple, an ACTIVE contract/rate plan and a child-age band for pricing), a second DRAFT contract for the Admin UI's add/validate child-band flow, an owner, a read-only viewer, and a second tenant. `verify-room-occupancy.cjs` drives: the canonical room occupancy rule (`maxOccupancy >= maxAdults + maxChildren`, refused otherwise) through the real room editor, with idempotent room creation (replaying the create request returns `replayed:true` for the same room); confirms extra-bed support is recorded as descriptive metadata only, never as a priced field; adds and validates a child-age band (extra bed allowed + a per-night supplement) through the contract policy editor, with an overlapping band refused and a band above age 17 refused directly by the API; and checks the stored supplement's exact integer-minor-unit math through the rate-certification simulator (the same evaluator Agent search uses) — a covered child age prices and reconciles exactly, an uncovered one is refused, never priced at zero or guessed. Finishes with tenant B and a read-only viewer refused on every route. Re-seed before every run. Same disposable-database guard as above.

```bash
(cd apps/api && NODE_ENV=test node --no-experimental-strip-types -r @swc-node/register ../../tools/admin-ops-verify/seed-room-occupancy.ts)
node tools/admin-ops-verify/verify-room-occupancy.cjs
```

## Room Event Master and event supplements — the "event overlay" (ADR 0089 Phase 2/3)

`seed-event-supplements.ts` creates a tenant with one hotel, an ACTIVE contract and rate plan (SELL basis, for pricing math), a second independent contract/plan (to show a supplement never leaks onto it), a maker and a checker, a read-only viewer, and a second tenant. `verify-event-supplements.cjs` drives the Room Event Master screen (`window.prompt` reason dialogs, handled as Playwright dialogs) through: creating and approving a Room Event (a second person, self-approval refused even by direct API call); a FIXED (PER_ROOM/PER_NIGHT) and a PERCENTAGE event supplement, each through its own draft → submit → approve (a different person) → activate lifecycle with an immutable version snapshot; the Rate Impact Preview checked against real `DailyRate` rows in integer minor units; two non-stackable overlapping supplements resolved by priority (the higher one wins outright, the other excluded); a third, equal-priority supplement making the resolution ambiguous — the API fails closed with `EVENT_SUPPLEMENT_CONFLICT` rather than picking one arbitrarily, resolved by suspending the duplicate; and a maker-checker amendment (request → approve → a separate execute step that alone applies the change and bumps the version), filed through the real "Request amendment" button. Finishes with tenant B and a read-only viewer refused on every route. Re-seed before every run. Same disposable-database guard as above.

```bash
(cd apps/api && NODE_ENV=test node --no-experimental-strip-types -r @swc-node/register ../../tools/admin-ops-verify/seed-event-supplements.ts)
node tools/admin-ops-verify/verify-event-supplements.cjs
```

Not covered by a separate script, and why: "date-range updates" is a facet of Quick Update's own `scope.ranges`, already exercised above, not a distinct feature. "Stop-sales" has only one live, writing surface — Quick Update's `availability.stopSell` flag, covered above; the supplier-extranet "Stop sales" page (`apps/supplier/app/(portal)/availability/stop-sales/page.tsx`) is an explicit `SupplyWorkflowUnavailable` placeholder, and its backing data model (`ExtranetChangeSet`, ADR 0061 Amendment 3 slice 4a) explicitly "writes nothing to DailyAvailability, DailyRate or RatePlan" — it stages a CSV for staff review, never applies it — so certifying it as a live stop-sales path would misrepresent a placeholder as a production capability (CLAUDE.md invariant 10).
