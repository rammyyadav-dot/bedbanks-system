# Tenant Control Center execution evidence

Executed 2026-10-11 on feature branch `feat/tenant-control-center`, based on
`5e145867c5daaad02b83475c832a78ab72e172ae`. This is a draft implementation with
explicit release gates, not production readiness certification.

Before final delivery, `main` advanced to
`0fe05d7eb2813e4294d1a463399de778833556fe`. It was integrated into the feature
branch; both sets of shared CSS and contract exports were preserved. The tenant
ADR is now 0042 and its migration is `202611100002_tenant_control_center`, after
the new hotel archive migration. Fresh migration replay, drift, restricted-role
certification, related regressions, builds and workspace checks were repeated
against the integrated result. The broader full-run results below apply to the
implementation before this integration, rather than claiming a green full run
of the final merged tree.

## Executed checks

| Check | Result |
| --- | --- |
| Disposable PostgreSQL 16 migration replay | Passed from an empty `fbeds_ci` database |
| Prisma migration drift | Only the existing unsupported `HotelSearchIndex_embedding_hnsw` index difference; no new schema drift |
| Strict-role tenant HTTP certification | 18/18 passed using `fbeds_api_login` and a separate restricted `fbeds_tenant_control_login`; owner connection used only by isolated fixtures |
| API unit tests | 96 suites passed, one skipped; 1,054 tests passed, three skipped |
| Admin tests | 74/74 passed |
| Related HTTP regressions | Five suites, 32/32 tests passed: Settings, platform admin, tenant finance, auth, supplier extranet |
| Workspace type checks | 14/14 tasks passed |
| Workspace lint | 14/14 tasks passed; existing unused-disable warning in inventory-admin remains |
| Architecture checks | Contracts, no-float, no-silent-fallback, public environment and runtime-role checks passed; 718 files, 13 audited client sites |
| Affected production builds | Admin Next build and API Nest build passed |
| Live Chromium browser flow | Directory/search, all five create steps, actual inactive creation, profile save, memberships, detail tabs, keyboard navigation, 390px layout and cross-origin mutation rejection passed |

Screenshots use disposable local fixtures: [directory](tenant-directory.png),
[overview](tenant-overview.png), [mobile](tenant-mobile.png).

The dedicated role certification covers cross-tenant RLS reads and writes,
audited transactional creation, duplicate identity rejection, idempotent replay,
optimistic concurrency, self-escalation/final-owner protection, membership
revocation, independent compliance review, maker-checker lifecycle requests,
activation readiness and immutable audit data. Application runtime connections
do not use owner credentials. CI provisions and certifies only its disposable
loopback database through `ops:certify-tenant-control`.

## Reproduction

Use the package manager pinned in `package.json`. Run migrations against a
disposable loopback PostgreSQL database named `fbeds_ci` as its owner, then:

```sh
NODE_ENV=test pnpm --filter @bedbanks/api ops:certify-tenant-control --disposable-local
pnpm check:architecture
pnpm type-check
pnpm lint
pnpm --filter @bedbanks/admin-console test
pnpm --filter @bedbanks/admin-console build
pnpm --filter @bedbanks/api build
```

The strict certification command generates credentials in memory and supplies
them only to its child process. Owner fixtures for legacy E2E tests are separate
from this security certification. If using Turbo with externally supplied test
database variables, explicitly forward them (`--env-mode=loose`) or configure
an appropriate allowlist; default strict environment filtering omits them.

## Wider regression run

The full workspace pipeline finished with 13/14 package tasks successful. The
API E2E run initially had 67 passed, ten failed and one skipped suite (667
passed, 28 failed, 18 skipped tests). This broad run is **not certified green**.

It exposed an integration issue introduced by tenant control: the ownership
audit still assumed the tenant-root table could never have forced RLS. That
specific classification now documents and accepts its optional forced scoped
authoring policies. The ordinary API grant list is unchanged. A new unit test
keeps other identity-table exemption checks strict, and the actual
`runtime-rls-probes` E2E suite passed on rerun.

The local harness was also corrected to supply `?schema=public` (an existing
inventory suite appends `&connection_limit=1`), and the development API was
stopped during the inventory rerun to avoid competing background sweepers.
`inventory-runtime-roles`, `inventory-hold`, and `runtime-rls-probes` passed on
that rerun. Across seven rerun suites, 50 tests passed and six failed.

Remaining broad failures are outside the changed tenant flows:

- Search scale, API-role and legacy RLS-role evidence tests hardcode
  `/opt/cursor/artifacts`; it is absent/read-only in this environment.
- Supply fixture sequences change the contract currency to AED but later
  author USD rates, and submit nonzero sold inventory through a path that
  deliberately rejects it. The existing supply validations were not weakened.
- Supplier mutation and hotel-index raw SQL probe fixtures cannot resolve their
  tables after switching to their probe roles (`42P01`); the new tenant
  certification uses separately provisioned restricted roles instead.

These failures remain recorded for follow-up. They are not omitted from the
full-run result, and targeted passing checks do not imply all repository E2E
tests pass.

## Release gates

See [requirement matrix](../../tenant-control-gap-matrix.md) and
[ADR 0042](../../adr/0042-tenant-control-center.md). Secure invitation delivery,
private verified document storage, canonical formal role mutations, member
pagination/search beyond the bounded view, last-activity filtering, supplier
and hybrid entitlements, approved finance reads, complete suspended refund and
cancellation servicing, closure/retention governance and complete WCAG review
remain outstanding. Unsupported actions are visibly unavailable; no fabricated
balances, document upload, invitation delivery or deletion is presented.

No production migration/provisioning, deployment, merge, supplier booking
enablement or payment enablement was executed.
