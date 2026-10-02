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
