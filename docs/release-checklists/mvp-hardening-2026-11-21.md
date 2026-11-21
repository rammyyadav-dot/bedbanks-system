# MVP hardening implementation and launch roadmap — 2026-11-21

Repository: rammyyadav-dot/bedbanks-system. Baseline: `ac3a54969ffb71253e6f76c922b2729dafe091a1`. Verified implementation review point: `f9e435cfb77c4518e23cc322f3a209d676e5c5d1`, on local branch `fix/mvp-launch-gaps`.

Status: the implementation batch is verified locally. Launch acceptance and persistent-database reconciliation remain open. This report does not authorize deployment or activate booking/payment switches.

## Implemented

- Require explicit inclusive tax and mandatory-fee declarations at rate-plan activation, shared commercial assessment, Agent search/recheck, final offer mapping and transactional stock allocation. Missing or false declarations refuse new sales. Valid synthetic fixtures declare inclusion explicitly; exclusion cases remain covered.
- Restore Finance posting through the existing ledger trigger by granting its restricted principal EXECUTE on the required boolean role predicate. The catalogue verifier checks that dependency. No additional Finance table access or ledger UPDATE/DELETE privilege is granted.
- Revalidate booking membership, revocation, agency scope and operator permission with column-only authorization reads. Preserve transaction isolation through the restricted booking connection. Real PostgreSQL tests cover agency precedence, foreign tenants, formal operator scope and revocation.
- Restore release guardrails: parameterized static savepoints, a narrow exemption for the exact zero-row status privilege probe, scoped uncached API test credentials, a bounded e2e heap, theme tokens, corrected fixtures and portable artifact paths.
- Exercise room-sales rules, allocation, distribution and supplier requests through HTTP as the strict API role. Assert real writes, idempotency, tenant denial and unchanged inventory for an unconfirmed supplier request. Distribution in this workflow remains explicitly simulated.
- Remove temporary booking logins and groups after integration suites so later owner fixtures are isolated. Verify offer expiry with controlled time. Certify opt-in credit concurrency/RLS and tenant control with disposable restricted logins.

Design and rollout details: ADRs 0115–0117, `docs/runbooks/launch-inclusive-pricing.md`, and `docs/LOCAL_SETUP.md`.

## Verification

| Check | Result |
| --- | --- |
| Workspace type checks | 17 tasks passed; changed API test fixtures also type-checked |
| Workspace lint | 16 tasks passed; subsequent fixture edits passed targeted lint |
| Architecture checks | Passed |
| API/Admin affected builds and dependencies | 10 tasks passed |
| Full workspace test task | 16 tasks passed |
| API unit tests | 234 suites, 2,583 tests passed |
| Default API integration run | 131 suites, 1,339 tests passed; two opt-in suites skipped by default |
| Opt-in credit concurrency and forced RLS | 15 tests passed under a restricted disposable test principal |
| Opt-in tenant-control isolation | 18 tests passed with distinct strict API and authoring principals |
| Cross-suite role cleanup | Booking suites passed; catalogue confirmed no leaked booking test login/group; subsequent finance fixtures passed |
| Complete migration replay | All 137 existing migrations applied to disposable PostgreSQL 16 |
| Runtime role certification | Passed on the disposable database |
| Prisma schema drift | No drift after default and opt-in verification |

Disposable PostgreSQL and Redis instances were removed after verification. No persistent database was mutated. No migration file or migration identifier was changed.

The credit concurrency test login deliberately has financial fixture privileges; those tests certify locks and tenant isolation, not production runtime grants. Synthetic suppliers and local HTTP certification do not certify a live supplier or payment provider.

## Launch roadmap

| Priority / gate | Accountable role | Concrete exit criterion |
| --- | --- | --- |
| P0 — persistent migration history | Database owner | Inventory every persistent database; reconcile applied names, checksums and failures. Resolve the `202612200001` collision only after establishing application state everywhere. Allocate a unique identifier only when the affected migration is unapplied everywhere; replay the complete resulting chain and verify drift. Preserve applied history. |
| P0 — inclusive pilot catalogue | Supply and Finance owners | Review supplier net terms, mandatory charges and property-collected disclosures. Record both declarations as true only for verified plans using the audited workflow. Confirm excluded plans remain unavailable for new sales. |
| P0 — restricted-role rollout | Platform / database owner | After migration review, provision and certify Finance-posting and booking-transaction roles with the reviewed contracts. Confirm credentials are distinct and restricted, and tenant policies and forbidden-operation probes pass. |
| P1 — staging acceptance | QA, Operations and Finance | Complete search → recheck → hold → prebook → confirm → documents → cancel/refund with pilot data, real intended role credentials and the intended supplier integration. Prove retries, expiry, stock release, financial tie-out and cross-tenant denial. Record measured load results. |
| P1 — pilot release decision | Product / technical owner | Review the above evidence and operational readiness, then explicitly approve deployment and any booking/payment activation through the existing release process. |

## Material rollout effects

Existing plans with false or unverified inclusion flags become unavailable for new sales. Review the catalogue before rollout; do not mass-set flags merely to restore visibility. The code does not backfill production declarations, reconcile persistent histories, replace supplier connectivity, or clear staging acceptance.
