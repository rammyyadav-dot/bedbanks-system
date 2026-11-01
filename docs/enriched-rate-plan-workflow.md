# Enriched rate plan workflow — implementation checkpoint

This is an incomplete implementation checkpoint, not a release certificate.

## Baseline

- Source: `883d9b3` (main at the initial audit), clean working tree before this task.
- Branch: `feat/enriched-rate-plan-workflow`.
- Authoritative schema: `apps/api/prisma/schema.prisma`.
- Runtime controls: ADR 0003, ADR 0032 and `runtime-role-contract.ts`.
- Existing shared sellability: `supply/contracted-sellability.ts`, consumed by Agent search and rate certification.
- Existing read-only audit/simulation: ADR 0033 and `rate-certification/`.
- Existing inventory pools: `RatePlan.inventoryPoolId`, `InventoryPool`, `InventoryPoolDay`; pool capacity has a separate restricted-role workflow.
- Existing Admin routes: `/rates/plans`, `/rates/plans/new`, `/rates/plans/:id`, `/rates`, and rate certification.
- Existing lifecycle enum: DRAFT, ACTIVE, SUSPENDED, EXPIRED. There is no approval-bound rate-plan revision lifecycle in this baseline.

## Requirement matrix

| Requirement | Status | Evidence / remaining work |
|---|---|---|
| Canonical hotel/contract/room/board rate model | Partial, existing | One room assignment per RatePlan; shared pools exist. Multi-room plan assignments require a reviewed model change. |
| Approval, versioning, scheduled publication | Missing | Existing direct status editor is not an approval workflow. Requires immutable revisions, content-bound approvals, runtime gates and migration certification. |
| Guided six-stage setup | Partial, existing | Basic RatePlanForm exists. Full workspace/tabs and incomplete draft support remain. |
| Standalone pricing and shared sellability | Implemented in baseline; not recertified here | Existing evaluator and integer minor-unit pricing. |
| Derived rates, inheritance and cycle detection | Missing | No new alternate pricing engine was introduced. |
| Occupancy/child/board enrichment | Partial, existing | Room capacities and contract child policies exist. Full requested child/extra-bed/meal calculations are not certified here. |
| Inventory pools and restrictions | Partial, existing | Pool capacity, stop sell, stay restrictions, arrival/departure flags and inventory modes exist. Requested complete policy coverage not certified. |
| Cancellation/recheck enrichment | Partial, existing | Existing canonical services retained; terms-changed/version-bound offer extension remains. |
| Portfolio server pagination/search | Implemented in this branch | Tenant-scoped count + page in RepeatableRead; stable code/id order; filters and bounded input; Admin paging. |
| Atomic calendar edits | Implemented; DB execution unverified | Rates + availability validate and save in one Serializable transaction; legacy batch paths reuse it. |
| Preview/stale-cell checks | Implemented | Preview is read-only; new apply route requires explicit expectedUpdatedAt on every cell; null means expected absence. Updates advance timestamps monotonically. |
| Strict role authoring | Blocked by existing design | ADR 0032 explicitly keeps RatePlan/DailyRate/DailyAvailability writes privileged. No grants or startup guards were changed. Preview is not permission to apply. |
| Import/dedup/error files | Missing | Not implemented. |
| Simulation/monitoring | Partial, existing | Read-only certification/simulation reused conceptually; no draft simulation or new alert jobs. |
| Browser/database certification | Not executed | No valid disposable DB/session fixture available in this runtime. Added strict-role regression coverage for CI. |

## Calendar contract

`POST /supply/calendar/preview` and `POST /supply/calendar/apply` accept up to 366 **total** rate/availability cells, not 366 of each. Both enforce the relevant application permissions. Apply does not acquire another database identity or grant privileges.

Each row supplies `expectedUpdatedAt` (ISO timestamp or null). Missing, stale or mismatched versions are rejected on the new endpoints. Existing single/bulk endpoints preserve their request shape, but now use the same validation and transaction. These compatibility endpoints do not require a version, so full stale-write protection is limited to the new review/apply route.

Rules added:
- Strict YYYY-MM-DD date validation; invalid calendar days are not normalized.
- Positive PostgreSQL-bigint monetary bounds; malformed input returns 400, not an uncaught BigInt conversion error.
- Currency must match both plan and contract; occupancy must match the plan.
- Dates must be inside the contract.
- Duplicate batch cells rejected.
- No authored sold/held inventory; existing committed stock is preserved.
- Omitted restrictions preserve current values rather than silently reopening sales.
- Pooled local allotment changes rejected; capacity remains in its canonical pool workflow.
- All validation precedes writes; rates, availability and audit events share one transaction.
- Serialization/unique-key conflicts return `CALENDAR_CHANGED` (409); database denials stay observable.
- Audits record before/after commercial values and request ID. No guest data is included.

The UI previews only changed cells, displays human-readable prices/conditions, invalidates review when edited, and applies the exact reviewed payload. It does not silently retry an uncertain write. Repeating a successful versioned apply is rejected as stale.

This does **not** add publication approval, derived rates, new inventory allocation, booking or payment capabilities.

## Verification evidence

Local commands (pnpm 10.4.1; dependency installation used the pinned lockfile):

| Check | Result |
|---|---|
| API unit suite | 1,013 passed; 3 existing skips across 92 passing suites |
| Focused calendar/input/rate validation tests | 54 passed initially; final calendar/input rerun: 50 passed |
| Admin unit suite | 74 passed |
| API type check | Passed on final code |
| Admin type check | Passed |
| API lint | No errors; 1 pre-existing warning in inventory-admin.service.ts |
| Admin lint | Passed |
| Architecture guards | Passed |
| Schema source-of-truth guard | Passed |
| API production build | Passed |
| Admin production build | Passed on final code |
| PostgreSQL replay/drift/RLS/HTTP E2E | NOT RUN locally |
| Authenticated browser | NOT RUN |

The strict-role addition in `rate-certification.e2e-spec.ts` checks preview, portfolio paging, cross-tenant rejection and unchanged data after prohibited apply. It must execute on disposable PostgreSQL in CI; source presence is not certification.

Local PostgreSQL package setup failed because the container cannot change OS identities. Creating a new empty Neon PostgreSQL 16 test project was rejected with `action restricted; organization is managed by Vercel`. No Neon project or database was created or changed.

## Release gates

No schema, migration, grants, booking flags, production environment or deployment was changed. No merge is authorized. Before operational rate authoring is released, complete the versioned approval architecture and explicit runtime-write contract, then pass fresh migration replay, restricted-role security tests, transaction rollback/concurrency tests and authenticated browser journeys. The current branch is reviewable groundwork only.
