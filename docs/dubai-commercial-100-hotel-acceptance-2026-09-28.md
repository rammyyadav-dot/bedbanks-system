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
5. AgentModule binds `UnconfiguredSupplierAdapter`. No internal 100-hotel search adapter was introduced or live supplier contacted. Admin eligibility is explicitly not an Agent offer/search certificate.

## Acceptance matrix

| Requirement | Expected evidence | Current result |
| --- | --- | --- |
| 100 hotels, seven dates | 100 eligible each date, 700 rates and availability rows | Expanded E2E; CI pending |
| Stop-sell middle day | Exactly 90 eligible; adjacent day 100; reopening restores 100 | Expanded E2E; CI pending |
| Supplier suspension | Zero eligible; restore returns 100 | Expanded E2E; CI pending |
| Mappings | 100 approved hotel/room mappings; reopened contract mapping rejected | Expanded E2E; CI pending |
| Rate semantics | NULL, missing rate and currency mismatch rejected | Expanded E2E; CI pending |
| Inventory | Missing/fully committed inventory rejected; sold/held preserved | Expanded E2E plus existing concurrency suite; CI pending |
| Tenant/RBAC/audit | No foreign object disclosure; unauthorized mutations rejected | Expanded and existing supply/RLS suites; CI pending |
| Validity and occupancy | Inclusive endpoints; outside dates and unsupported occupancy rejected | Expanded E2E; CI pending |
| Actual Agent search, filters, pagination | Real 100-hotel canonical offers | BLOCKED: adapter unconfigured |
| Seven-night stay restrictions | Every night and applicable stay/release rules enforced | NOT CERTIFIED: diagnostic endpoint is single-date |
| Search cache invalidation after commercial edits | Authoritative offers reflect changes | NOT CERTIFIED: no internal offer path wired |
| Admin contracts | API read replaces mock list | Implemented; authenticated browser NOT EXECUTED |
| Operator create/edit workflow and refresh | Browser acceptance plus human review | NOT EXECUTED |
| Source snapshot preservation | Real clone fingerprints unchanged | NOT EXECUTED |
| Runtime HTTP role / restore | Independent deployment and recovery evidence | BLOCKED, outside disposable acceptance |

## Verification log

Local API/Admin type checks, API/Admin lint and schema guard: execution in progress; final results to be recorded after CI. Earlier baseline success is not counted as changed-head acceptance. Exact CI SHA, command timestamps and observed metrics will be appended after the branch run.

## Performance and limitations

The suite emits aggregate HTTP timings only, no credentials or fixture identifiers. Concurrency is 10 for sellability; other reads/setup are sequential. Measurements are shared-runner observations, not a load-test SLA. There is no approved performance budget and no invented pass threshold. Runner CPU/memory/architecture and command timestamps are recorded by CI.

The current supplier adapter is unconfigured; the expanded suite invokes supply/identity endpoints only. Existing isolated concurrency tests exercise hold services without enabling deployed booking. This is not a proof of all possible outbound effects across the whole application. Browser and human operational sign-off remain absent.

## Next gates

Review the bounded fixes and CI evidence; implement and certify an authoritative internal Agent search path and applicable stay restrictions before claiming 100-hotel search acceptance. Complete isolated authenticated browser/operator acceptance. Separately provision the protected clone runner, certify migration/preservation/RLS, trace the deployed API role, and demonstrate backup/PITR restore. A clone runner pinned to the earlier application baseline cannot certify these changed application files without a reviewed baseline update.

No merge, deployment, Production migration or booking activation is authorized by this report.
