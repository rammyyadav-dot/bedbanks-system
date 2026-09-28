# Dubai commercial and 100-hotel acceptance — 28 September 2026

**DUBAI PILOT ACCEPTANCE BLOCKED**

Track B: ENGINEERING ACCEPTANCE ONLY — PRODUCTION-CLONE ACCEPTANCE NOT EXECUTED.

## Baseline and environment

Baseline main: `c44e1637eca17f58e484c67e1664958439fbab1a`, PR #139 merged, baseline CI run `36368927962` passed. Working tree was clean. Review branch: `test/dubai-commercial-100-hotel-acceptance`. No historical migration/schema edits, Production migration, credential change or booking activation.

Execution target is the CI job's newly created PostgreSQL 16 service, empty before committed migration replay. The job checks loopback/database identity before migration and records only sanitized runner specifications. There is no Production secret reference. Existing Prisma validate/generate/deploy/status/drift gates run before E2E; a second drift comparison follows E2E. The local workspace has no PostgreSQL or Docker binary; database execution is delegated to this existing CI workflow, not a persistent provider database.

## Dataset and reproducibility

`apps/api/test/dubai-commercial-scale.e2e-spec.ts` uses one uniquely named pilot tenant, one isolated tenant, 100 synthetic pilot hotels, 100 rooms, 100 approved hotel mappings, 100 approved room mappings, 100 active rate plans, 700 SELL rates at 29900 AED minor units and 700 availability rows. One bootstrap contract plus 100 hotel-bound contracts are created. Bulk seed establishes canonical scale data; mapping approval, bound-contract creation/activation, plan reassignment and negative commercial mutations use authenticated HTTP APIs. Existing supply E2E additionally exercises create/update/authorization/audit flows.

Default dates: 2026-11-20 through 2026-11-26, configurable with `DUBAI_ACCEPTANCE_START_DATE` as a validated calendar date. Dates are business-date keys for Asia/Dubai, represented in PostgreSQL at UTC midnight; they are not check-in timestamps. Contract validity is inclusive on both endpoints. Seven individual dates are exercised; this does not prove a seven-night Agent offer. The existing sellability API accepts one date, not a stay duration.

Run-scoped tenant/entity filters clean fixtures after tests, including on assertion failures. Missing setup IDs are guarded before cleanup. CI service destruction is the final isolation boundary. No real customer data is seeded. No 13-row legacy Production baseline is fabricated: a synthetic NULL-basis case tests rejection only; Production preservation remains unexecuted.

## Findings and fixes

1. Existing scale certification tested 100 hotels for only one day. Expanded to seven dates (700 baseline checks) at maximum concurrency 10, with exact negative counts and restoration.
2. Supply sellability accepted suspended suppliers. Added an active-supplier requirement; fixture suppliers now explicitly declare ACTIVE when testing eligible inventory.
3. Supply sellability ignored daily-rate/plan currency mismatch and unsupported occupancy. Added fail-closed reasons and regression cases.
4. Admin Contracts page displayed mock contracts and invented markup/commission fields. It now reads the authenticated existing contracts API, shows persisted commercial fields, and exposes loading, empty and unavailable states. It remains a read-only page, not a complete contract editor.
5. Admin daily-rate types incorrectly excluded NULL basis and the Rates page labeled it NET. The read type now admits NULL and the page displays Unverified; write inputs still require explicit SELL/NET.
6. AgentModule binds `UnconfiguredSupplierAdapter`. No internal 100-hotel search adapter was introduced or live supplier contacted. Admin eligibility is explicitly not an Agent offer/search certificate.

## Acceptance matrix

| Requirement | Expected evidence | Current result |
| --- | --- | --- |
| 100 hotels, seven dates | 100 eligible each date, 700 rates and availability rows | PASS on disposable CI |
| Stop-sell middle day | Exactly 90 eligible; adjacent day 100; reopening restores 100 | PASS on disposable CI |
| Supplier suspension | Zero eligible; restore returns 100 | PASS on disposable CI |
| Mappings | 100 approved hotel/room mappings; reopened contract mapping rejected | PASS on disposable CI |
| Rate semantics | NULL, missing rate and currency mismatch rejected | PASS on disposable CI |
| Inventory | Missing/fully committed inventory rejected; sold/held preserved | PASS on disposable CI, including existing concurrency suite |
| Tenant/RBAC/audit | No foreign object disclosure; unauthorized mutations rejected | PASS on disposable CI, including existing supply/RLS suites |
| Validity and occupancy | Inclusive endpoints; outside dates and unsupported occupancy rejected | PASS on disposable CI |
| Actual Agent search, filters, pagination | Real 100-hotel canonical offers | BLOCKED: adapter unconfigured |
| Seven-night stay restrictions | Every night and applicable stay/release rules enforced | NOT CERTIFIED: diagnostic endpoint is single-date |
| Search cache invalidation after commercial edits | Authoritative offers reflect changes | NOT CERTIFIED: no internal offer path wired |
| Admin contracts | API read replaces mock list | Implemented; authenticated browser NOT EXECUTED |
| Operator create/edit workflow and refresh | Browser acceptance plus human review | NOT EXECUTED |
| Source snapshot preservation | Real clone fingerprints unchanged | NOT EXECUTED |
| Runtime HTTP role / restore | Independent deployment and recovery evidence | BLOCKED, outside disposable acceptance |

## Verification log

Local API/Admin type checks, API/Admin lint and schema guard passed. API unit: 155 passed, 3 skipped. Admin operation tests: 4 passed. Admin server authentication integration: 14 passed. All commands exited 0. Earlier baseline success is not counted as changed-head acceptance. Exact tested SHA, command timestamps and observed metrics follow below.

## Performance and limitations

The suite emits aggregate HTTP timings only, no credentials or fixture identifiers. Concurrency is 10 for sellability; other reads/setup are sequential. Measurements are shared-runner observations, not a load-test SLA. There is no approved performance budget and no invented pass threshold. Runner CPU/memory/architecture and command timestamps are recorded by CI.

The current supplier adapter is unconfigured; the expanded suite invokes supply/identity endpoints only. Existing isolated concurrency tests exercise hold services without enabling deployed booking. This is not a proof of all possible outbound effects across the whole application. Browser and human operational sign-off remain absent.

## Next gates

Review the bounded fixes and CI evidence; implement and certify an authoritative internal Agent search path and applicable stay restrictions before claiming 100-hotel search acceptance. Complete isolated authenticated browser/operator acceptance. Separately provision the protected clone runner, certify migration/preservation/RLS, trace the deployed API role, and demonstrate backup/PITR restore. A clone runner pinned to the earlier application baseline cannot certify these changed application files without a reviewed baseline update.

No merge, deployment, Production migration or booking activation is authorized by this report.

## Initial CI attempt

Commit `33bbb950b94b8d0e4e640a144077c53c48b54d29`, CI run `36407443481`: migration replay/status/drift passed; E2E returned 1 with 75 passing and one failing test. All 700 baseline checks completed. The new mapping test incorrectly reopened a parent with an approved child; the application correctly rejected that transition. The correction asserts that rejection and reopens the child first, restoring parent then child. No governance rule was weakened. The corrected sequence passed in the final code revision below.

## Final code revision evidence

Tested code SHA: `555ba9aef3cb2d4118847e21a953b6086b5c83d7`.

- [Push CI 36407847658](https://github.com/rammyyadav-dot/bedbanks-system/actions/runs/36407847658): SUCCESS.
- [PR CI 36407854205](https://github.com/rammyyadav-dot/bedbanks-system/actions/runs/36407854205): SUCCESS.
- Contract checks `36407854234` and tenant-guard checks `36407854277`: SUCCESS.
- [Draft PR #140](https://github.com/rammyyadav-dot/bedbanks-system/pull/140); no merge performed. This evidence appendix is a subsequent documentation-only commit; the tested application, tests and workflow are unchanged.

All timestamps below are UTC on 2026-09-28. Each command exited 0.

| Command / gate | Start–finish UTC | Result |
| --- | --- | --- |
| Disposable target validation | 10:08:46 | Loopback ephemeral CI target validated |
| API prisma:validate | 10:08:46–10:08:48 | PASS |
| API prisma:generate | 10:08:48–10:08:50 | PASS |
| API prisma:migrate:deploy | 10:08:50–10:08:51 | Committed migration replay PASS |
| API prisma:migrate:status | 10:08:51–10:08:53 | Database up to date |
| API prisma:migrate:drift | 10:08:53–10:08:54 | No difference detected |
| API test:e2e | 10:08:54–10:09:46 | 76 tests, 13 suites PASS |
| API prisma:migrate:drift after tests | 10:09:46–10:09:47 | No difference detected |
| Workspace type-check | 10:09:02–10:09:12 | PASS |
| Workspace lint | 10:09:12–10:09:20 | PASS |
| Workspace tests | 10:09:20–10:10:41 | PASS; API unit 158/158 including Redis cases, API E2E 76/76 |
| Workspace build | 10:10:41–10:11:17 | PASS: website, supplier, Admin, API and Agent |

The full CI build had the required font access. The previous local Google Fonts network limitation did not block this runner. Local Admin authentication integration separately passed 14 tests; local Admin operations passed four tests. Schema integrity and clone-runner guard tests passed in normal CI. No skipped database test is counted as a pass.

### Observed performance

Sanitized runner: Ubuntu/Linux x64, Node v24.21.0, pnpm 10.4.1, four logical CPUs, approximately 16 GiB RAM, PostgreSQL 16. In-process authenticated HTTP tests, maximum sellability concurrency 10.

| Operation | Observed wall time |
| --- | ---: |
| List 100 hotels | 14.84 ms |
| Read rooms for 100 hotels, sequential requests | 1292.87 ms |
| List 100 rate plans | 28.61 ms |
| Read 700 daily rates | 90.19 ms |
| Read 700 availability rows | 81.60 ms |
| 100 sellability requests per date | 633.05–693.57 ms across seven dates |

These are operation/batch timings, not per-request percentiles. The 700 baseline sellability requests all returned the expected HTTP status and eligible result (zero unexpected errors in that baseline). Negative scenarios deliberately expect rejected eligibility or 4xx responses and are not production error-rate measurements. No throughput/SLA claim is made.

### Interpretation and residual gaps

Passing E2E confirms the implemented single-date diagnostic and listed safety cases on disposable engineering data. It does not certify 100 real Agent offers, full-stay restrictions, room-mapping eligibility in every diagnostic path, Dubai timestamp-boundary handling, search pagination/cache invalidation, all-currency UI precision or the complete browser-based commercial editor. These are not waived by green CI.

Test cleanup completed without failures; both CI database services were stopped by their job teardown. There is no retained pilot database or customer dataset. Preservation assertions covered synthetic sold/held values. Source-clone data and the previously observed legacy-rate count were not inspected or changed by this execution.

**DUBAI PILOT ACCEPTANCE BLOCKED** remains the primary verdict. Complete the authoritative internal Agent search/stay path and isolated browser/operator acceptance next; independently close clone, runtime-role and recovery gates before any Production release planning.
