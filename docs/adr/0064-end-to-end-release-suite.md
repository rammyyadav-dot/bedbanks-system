# ADR 0064: End-to-end release suite against a real database

Status: accepted (2026-10-13).

## Context
Until now CI proved the API with Jest and the website with Playwright, but nothing exercised the Admin, Agent and Supplier portals together with the API and a real PostgreSQL running under the strict runtime role. Defects that only appear when those pieces meet (a stale portal build rejecting a valid API response, a missing per-portal origin setting, a tenant leaking across a boundary) could pass every unit test. `e2e/README.md` reserved the directory for this and said placeholder tests would not be added.

## Decision
1. A workspace package `@bedbanks/e2e` (Playwright 1.56.1, the version the website suite already uses) owns the suite. Its script is `e2e`, not `test`, so `pnpm -r --if-present test` does not start a database and four servers.
2. The suite boots its own stack on fixed non-default ports, loopback only: disposable database `fbeds_preview_xt` (the only name the preview-fixture tool accepts; created, migrated with `prisma migrate deploy`, never `migrate dev`), the `fbeds_api_login` strict runtime role provisioned by the production tool, the explicit preview fixtures (two tenants), the API, and the three portals in production mode through their runtime API origin (ADR 0055/0056).
3. Fixture passwords are generated per run into a 0600 file in the OS temporary directory, outside the repository, and removed at teardown. Nothing is printed.
4. The suite refuses a non-loopback PostgreSQL host and drops only `fbeds_preview_xt`.
5. Booking, hold and payment stay closed (`BOOKING_ENABLED=false`). The suite proves they stay closed, including that no booking, hold, ledger or finance row is created.
6. It runs as its own CI job. It is advisory for release evidence until it has been green on `main` for a defined period; making it a required check is an owner decision.

## Consequences
- Portal builds must be fresh. A stale `.next` build is the one failure mode the suite cannot detect by itself; CI always builds first.
- Tests share one database and run serially.
- Anything the suite finds that is outside its scope is reported, not silently fixed.

## Verification
Each guard test was checked to fail when the guarded behaviour is broken: with `BOOKING_ENABLED=true` the booking-closed tests fail.
