# Exact implementation certification

Tested implementation: `ceac745a7757cd207845001650d12e82ef894649`.

This evidence was generated after committing that implementation, with a clean worktree and no subsequent application changes. The commit adding this report contains documentation and evidence only; it is not a newly tested implementation revision.

Local release-gate verdict: **PASS** within the verification scope below. Hosted authentication and production database readiness: **NOT VERIFIED**. No production deployment, merge, live supplier activation, booking/payment enablement, or RLS weakening occurred.

| Gate | Observed result |
|---|---|
| API/Admin type-check and lint | PASS; one pre-existing API unused eslint-disable warning, zero errors |
| API/Admin production builds | PASS |
| API unit tests | 90 suites passed; 963 tests passed, 3 skipped in 1 skipped suite |
| Admin unit tests | 74 passed |
| Agent unit tests | 108 passed |
| Selected API integration tests | 15 suites, 208 tests passed |
| Real-stack Admin browser journey | 26/26 checks passed |
| Responsive layout | PASS at 320, 390, 768, 1280 and 1440px |
| Accessibility | axe passed on hotel profile and linked operational summaries |
| Runtime role and RLS | Verified fbeds_api_login, non-superuser, no BYPASSRLS; restricted-role integration tests passed |
| Migration replay and drift | All 64 migrations replayed on fresh disposable PostgreSQL 16 database; no schema drift |
| Prisma schema validation/status | PASS; schema valid, no pending migrations |
| Architecture/schema guards | PASS |

Integration scope: runtime-role, Supply HTTP boundaries and mapping governance, hotel commercial/setup/readiness/images, strict-role hotel/commercial/workflow/replay, inventory search/recheck and pool lifecycle, 100-hotel Agent search and transaction gates. This is the selected regression scope, not a claim that every repository integration suite ran.

The browser used the production Admin build, real Nest API and restricted PostgreSQL role. It created a hotel, saved and reloaded validated content, created/archived/restored a room, saved amenities, uploaded and decoded an image, completed all 12 publication requirements, rejected self-approval, approved with a second person and published. It also verified protected-column denial, non-sellability without commercial supply, archive preservation, duplicate conflicts, read-only boundaries, five widths and axe checks. Screenshots use synthetic disposable data.

Results logs retain command headings and summaries; verbose expected-denial traces, runtime startup logs and seed credentials are excluded. API/Admin unit skip counts are reported explicitly. Commands and implementation matrix are in [the implementation report](../../../enterprise-hotel-overview-certification.md).

Remaining limits: destination suggestions cover existing tenant properties, exact normalized duplicate detection does not perform fuzzy merging, and no hosted/production certification is asserted.
