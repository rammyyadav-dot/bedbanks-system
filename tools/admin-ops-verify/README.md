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
with bedding and an amenity then archived and restored, hotel amenities save, an image uploads and decodes, completeness reaches 12 of 12, a second person approves publication,
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
