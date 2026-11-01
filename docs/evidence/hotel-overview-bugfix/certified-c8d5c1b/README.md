# Exact Hotel Overview bugfix certification

Certified implementation: **c8d5c1be09d5868c6ad39c4150a73d549e683379** on `feat/admin-hotel-profile-overview`.

Checks ran after committing that revision with a clean worktree. The subsequent evidence-only commit adds documentation/logs/screenshots and does not change the certified application or test code. Baseline findings and requirement matrix: [bugfix audit](../../../hotel-overview-bugfix-audit.md).

**Local release-gate verdict: PASS.** Hosted authentication and production database readiness: **NOT VERIFIED**. No production deployment, merge, live supplier or booking/payment activation, destructive migration, record deletion or RLS weakening occurred.

| Gate | Observed result |
|---|---|
| API/Admin type-check | PASS |
| API/Admin lint | PASS; zero errors, one pre-existing API unused eslint-disable warning |
| API/Admin production builds | PASS |
| API unit tests | 963 passed, 3 Redis tests initially skipped; targeted Redis rerun passed all 3 against disposable Redis |
| Admin unit tests | 74 passed, zero skipped |
| Agent unit tests | 108 passed, zero skipped |
| Selected API integration regressions | 15 suites, 214 tests passed, zero skipped |
| Real-stack Admin browser journey | 31/31 passed |
| Responsive layout | PASS at 320, 390, 768, 1280, 1440px |
| Accessibility | axe passed on profile and linked operational summaries |
| Runtime role/RLS | fbeds_api_login verified non-superuser and non-BYPASSRLS; strict-role denial/tenant regression suites passed |
| Fresh migration replay | All 64 migrations applied on disposable PostgreSQL 16; no schema drift |
| Schema validation/migration status | PASS; schema valid and no pending migrations |
| Architecture and canonical schema guards | PASS |

## Fixed defects and implementation evidence

All three defects were reproduced before their fix. Failure excerpts are included separately from passing certification results.

- Publication versus Setup edit: [hotel-publication.service.ts:111](https://github.com/rammyyadav-dot/bedbanks-system/blob/c8d5c1b/apps/api/src/hotel-setup/hotel-publication.service.ts#L111) acquires the shared lock before loading/checking the reviewed version. Regression: hotel-setup.e2e-spec.ts:895.
- Legacy archive bypass: [supply.service.ts:224](https://github.com/rammyyadav-dot/bedbanks-system/blob/c8d5c1b/apps/api/src/supply/supply.service.ts#L224) locks current state and uses the shared room-retention guard. Regression: hotel-setup.e2e-spec.ts:853.
- Concurrent room archives: [hotel-rooms.service.ts:183](https://github.com/rammyyadav-dot/bedbanks-system/blob/c8d5c1b/apps/api/src/hotel-setup/hotel-rooms.service.ts#L183) serializes status changes; [hotel-setup-shared.ts:10](https://github.com/rammyyadav-dot/bedbanks-system/blob/c8d5c1b/apps/api/src/hotel-setup/hotel-setup-shared.ts#L10) contains the single last-active-room rule. Regression: hotel-setup.e2e-spec.ts:863.

Related regression safeguards cover canonical/legacy room changes after approval and concurrent amenity writes. Room mutations bump the existing Setup version; no schema, permission, tenant context or approval engine was duplicated or weakened.

## Commands and scope

Node 24, pnpm 10.4.1. Commands used `npx --yes pnpm@10.4.1`:

- `--filter @bedbanks/api type-check`, `lint`, `test:unit`, `build`.
- `REDIS_URL=redis://127.0.0.1:6379 ... --filter @bedbanks/api exec jest --runInBand redis-cache.adapter.spec.ts` for the three initially skipped Redis tests.
- `--filter @bedbanks/admin-console type-check`, `lint`, `test`, `exec next build --webpack`.
- `--filter @bedbanks/agent-portal test`; `check:architecture`; `check:schema`.
- `--filter @bedbanks/api test:e2e --` with api-runtime-role, supply, hotel-commercial, hotel-setup, strict-runtime-role-hotel-setup/commercial/workflows/replay, inventory-search-recheck, inventory-pool-lifecycle, hotel-images, hotel-readiness, dubai-agent-search-hundred and agent-transaction-gates suite names. This is the selected regression scope, not every repository integration suite.
- `prisma:migrate:deploy`, `prisma:migrate:drift`, `prisma:validate`, `prisma:migrate:status` on disposable local databases only; no new migration introduced.
- `tools/admin-ops-verify/seed-hotel-journey.ts` creates fictional accounts on the guarded disposable database. `PLAYWRIGHT_EXECUTABLE_PATH=/usr/bin/chromium SHOT_DIR=... node tools/admin-ops-verify/verify-hotel-journey.cjs` exercises the actual production Admin build and real restricted-role API, with no HTTP stubs.

Browser coverage includes create/edit/validation, room create/archive/restore, amenities, decoded media, 12/12 readiness requirements, maker-checker approval/activation, protected-column denial, non-sellability without commercial supply, property suspension/archive/restoration, duplicate conflict, read-only boundaries, five widths and axe. No uncaught browser exception, unexpected console error or HTTP 5xx occurred. Observed HTTP 400/403/409 responses belong to intentional invalid-edit, denied-column and duplicate probes. Six screenshots use synthetic disposable hotel data.

Result logs preserve commands and summaries; verbose expected-denial traces, fixture credentials and runtime startup logs are omitted. Remaining limits are tenant-derived geography suggestions, exact normalized rather than fuzzy duplicate detection, and unverified hosted/production readiness.
