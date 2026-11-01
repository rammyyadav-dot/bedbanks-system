# Rate plan lifecycle: issue 304 evidence and release verdict (2026-10-11)

Scope: fBeds only (no UAEWB or fabBeds data, credential or project involved). Baseline: `origin/main` = `a44b83c616bcdc30efcd5d50274ae199a50e164c` (clean tree, no `AGENTS.md`; `CLAUDE.md` governs). Branch `claude/awesome-galileo-xuxzwv`. All database evidence is from a **disposable local PostgreSQL 16.15 + pgvector** created for this session; no hosted, persistent or production database, credential or secret was accessed.

## Verdict: CONDITIONAL
Code and disposable-database evidence is complete for the items implemented. Release to a strict hosted environment is **not certified**: hosted certification, operator provisioning, the clone writer decision and the four-eye decision are open and need people.

## Gap matrix
| # | Item (issue 304) | State | Evidence |
|---|---|---|---|
| A1 | Provision `fbeds_rateplan_ops` per strict environment | OPEN (operator) | Procedure: `docs/runbooks/rate-plan-ops-role-certification.md`; CLI `ops:verify-rate-plan-ops-role` (21 probes, passes as the lifecycle login, fails as the runtime login) |
| A2 | Store `RATE_PLAN_OPS_DATABASE_URL` | OPEN (operator) | Same runbook; fail-closed 403 without it proven by smoke phase A |
| A3 | Hosted / production-clone certification | OPEN, NOT VERIFIED | Runbook + evidence record template only |
| B1 | Clone writer decision; hide or explain Clone | DONE in code (explain/disable); writer decision RECOMMENDED, awaits owner | ADR 0041 Amendment 3 s1; capability route; browser 12/12 and 11/11 |
| B2 | Boot smoke covers rate plan routes and the role | DONE | `ops:strict-role-boot-smoke` 42/42 (was 14); found and fixed a real defect (below) |
| B3 | Admin keeps structured `error.details` | DONE | `ApiResponseError.structuredDetails`; admin unit tests 80/80; browser check with injected 409 |
| C1 | Four-eye approval | OPEN; assessed, proposal only | ADR 0041 Amendment 3 s5. Not implemented: no approved authorization design |
| C2-C5 | Promotions, derived rates, plan-level overrides, calendar grid/wizard, per-plan cancellation | OPEN, untouched | Out of this mission; each needs a pricing policy and reviewed migration |
| D | CI intermittent failure | CLASSIFIED | below |

## Defect found and fixed
A rejected lifecycle credential answered `500 INTERNAL_SERVER_ERROR` instead of the documented sanitized `503 RATE_PLAN_OPS_UNAVAILABLE` (the first-use check mapped only `RuntimeRoleViolation`). No write occurred and nothing leaked, but the contract was broken. Fixed in `rate-plan-ops-database.ts` (any first-connection failure is the same 503, the client is discarded and retried); regression spec added; smoke phase C passes.

## Test evidence (exact SHAs, disposable PostgreSQL 16.15)
| Check | Result |
|---|---|
| Baseline `a44b83c`: `prisma migrate deploy` of 65 migrations, `migrate status`, `migrate drift` | success; up to date; no drift |
| Baseline `a44b83c`: API e2e (80 suites) | 79 passed, 1 skipped, 730 tests passed, 0 failed |
| Strict-role certification (`certify-disposable-runtime-role`), tenant-control certification | pass (36 forced-RLS tables, 12 probes); 18/18 |
| Branch `43afb7c` + fix `b2e5a48`: `pnpm type-check`, `pnpm lint` | 14/14 and 14/14 tasks |
| `pnpm check:architecture` | pass |
| API unit (jest) | 100 suites, 1071 tests passed |
| API e2e on the branch | 79 passed, 1 skipped, 730 tests passed, 0 failed (identical to baseline) |
| Admin unit tests | 80/80 |
| Boot smoke on the strict login, 3 boots | 42/42 |
| Browser, owner-connected API (`verify-rate-plans.cjs`) | 35/35 |
| Browser, strict login + lifecycle role (`verify-rate-plans-strict.cjs`, `LIFECYCLE_ROLE=configured`) | 12/12 |
| Browser, strict login without lifecycle role (`LIFECYCLE_ROLE=absent`) | 11/11 |

Not run: the other browser suites listed in the issue (Agent MVP at 100 hotels, home search); `pnpm build` and `pnpm test` as a single turbo invocation (the same API unit and e2e suites and the Admin tests ran individually); anything on Node 24 (the sandbox has Node 22.22.0; CI uses 24).

## CI analysis (logs and exact SHAs)
- `main` at `a44b83c`: CI run 1272 **success**; `d9cebb9` (#302) run 1261 **success**.
- Failing `main` pushes (`0fe05d7` #299, `a195f5e` #301, `4e02e6e` #300, `3236966` #303) fail at `pnpm -r test` (verify) and `test:e2e` (migration job), **not at build** (build is skipped after a test failure). The log of run 38135258194 (`3236966`) shows the same 7 failures in both jobs: 6 in `Supply HTTP authorization boundaries` and 1 in `Authoritative Dubai one-hotel agent search`, which are the date-stale fixtures ADR 0041 documents and PR #302 fixed. The failures are deterministic, reproducible and not infrastructure; `3236966` was merged without the #302 fix.
- The issue's "`610e6f0` failed at `pnpm -r build`" claim is **not verifiable**: I could not read that run's log, and the build step cannot run when the test step fails. It stays an open question; the evidence points to the same test failures, not a build flake.
- The sandbox cannot re-run jobs on `main`; CI for the branch is reported on the pull request.

## Not done on purpose
No merge, deploy, live booking or payment activation, RLS change, financial privilege change, new rate-plan model, or hosted/production access. Clone was not given a writer. Four-eye approval was not implemented.
