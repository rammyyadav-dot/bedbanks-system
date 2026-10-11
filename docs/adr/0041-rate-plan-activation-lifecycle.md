# ADR 0041: Rate plan activation readiness and lifecycle routes

## Status
Accepted for API and Admin code. Amendment 1 (bypass closure) implemented and certified on disposable PostgreSQL only; **release remains blocked** on blocker 1 below. No schema, migration, grant, permission-catalogue or runtime-role change. ADR 0032 (privileged rate writes) and ADR 0014 (one sellability evaluator) are unchanged.

## Context
`PATCH /supply/rate-plans/:id` accepted any `status`, so a plan with no rates, an expired contract or no inventory could be made ACTIVE by one request, and the Admin form offered the same dropdown. There was no clone, no readiness checklist, and status changes left no before/after audit.

## Decision
1. **Pure evaluator.** `supply/rate-plan-activation.ts` decides readiness from plain facts (no database, no clock). Checks: lifecycle state, contract mapped to the room's hotel, contract ACTIVE, contract dates, plan/contract currency, room active, occupancy within room capacity, board active, stay rules, cancellation rule for refundable plans, future rates present, no missing nights between first and last rated night, every rate classified NET/SELL, every rate in the plan currency, positive amounts, and inventory linkage (future availability rows or a shared pool). Unknown is never ready.
2. **Routes.** `GET rate-plans/:id/readiness` (`supply.rates.read`); `POST rate-plans/:id/activate|suspend|clone` (`supply.rates.manage`). All are tenant-scoped, return 404 for another tenant's plan, and live in `@bedbanks/contracts`.
3. **Optimistic concurrency.** Activate and suspend require `expectedUpdatedAt`; the write is a conditional `updateMany` on id, tenant, status and version. A mismatch is `409 RATE_PLAN_CHANGED`; a failed checklist is `409 RATE_PLAN_NOT_READY` with the failed checks; a disallowed transition (including reactivating EXPIRED) is `409 RATE_PLAN_TRANSITION_NOT_ALLOWED`.
4. **Audit.** Each transition writes `supply.rate_plan.status_changed` with request id, before/after status and reason (suspension requires one), in the same transaction. Denials reuse the existing `permission.denied` event.
5. **Clone** copies the commercial shape into a new DRAFT within the same hotel; it never copies status, rates, availability or pool membership. A duplicate code on the contract is `409 RATE_PLAN_CODE_EXISTS`.
6. **Admin** gets a hotel-scoped Rate Plans tab (search, status filter, status counts, paging, activate/suspend/clone). The rate plan form no longer edits status.

## Amendment 1: generic PATCH bypass closed (P0)

### The vulnerability
Before this amendment, `PATCH /supply/rate-plans/:id` copied `input.status` straight into `tx.ratePlan.update`. Any caller holding `supply.rates.manage` could send `{"status":"ACTIVE"}` and make a plan with no rates, no inventory, an expired contract or no cancellation rule sellable-by-status. The Admin form exposed the same dropdown. `POST /supply/rate-plans` ignored `status` (default DRAFT), and no other application code wrote `RatePlan.status`; the audit of `src/`, `tools/` and `apps/` found no raw SQL writer. The seed tools under `tools/admin-ops-verify` write through the disposable owner client and are not part of the runtime.

### Closed paths
| Path | Now |
|---|---|
| `PATCH rate-plans/:id` with `status` (alone or mixed) | 400 `RATE_PLAN_STATUS_VIA_LIFECYCLE_ONLY`, checked before the permission lookup and any write; no field is applied |
| `PATCH` / `POST rate-plans` with an unknown key (`tenantId`, `inventoryPoolId`, `id`, ...) | 400 `RATE_PLAN_UNKNOWN_FIELD`; keys are never silently dropped |
| `POST rate-plans` with `status` | 400, nothing created |
| Edit of an ACTIVE plan that newly breaks a readiness check (contract, room, board, occupancy, currency, refundable, stay rules) | 409 `RATE_PLAN_NOT_READY`; a check that was already failing does not block an unrelated edit |
| Clone | always DRAFT, no rates, availability or pool |
| Admin form / client type | status removed from the form and from `RatePlanInput` |
| Any new ORM or raw-SQL writer of `RatePlan.status` | fails `rate-plan-status-writers.spec.ts` |

### Lifecycle (schema statuses only; no enum value added)
| From | Action | To | Requires |
|---|---|---|---|
| DRAFT | activate | ACTIVE | all readiness checks pass at commit |
| SUSPENDED | activate | ACTIVE | fresh readiness (nothing is remembered from before suspension) |
| ACTIVE | suspend | SUSPENDED | `supply.rates.manage`, reason of 3+ characters |
| EXPIRED | any | - | refused, 409 `RATE_PLAN_TRANSITION_NOT_ALLOWED`; clone instead |
| ACTIVE / DRAFT | the other action | - | 409 `RATE_PLAN_TRANSITION_NOT_ALLOWED` |

An expired or non-ACTIVE contract fails `CONTRACT_VALID` / `CONTRACT_ACTIVE`. EXPIRED is not written by any application path today.

### Transaction and concurrency
Facts are read and the conditional write is made in one Serializable transaction (`updateMany` on id, tenant, current status and `updatedAt`), so readiness is evaluated against the data that commits. Outcomes: stale `expectedUpdatedAt` or lost race or Prisma `P2034` -> 409 `RATE_PLAN_CHANGED`; failed checklist -> 409 `RATE_PLAN_NOT_READY` with the failed checks in `error.details`; the audit event is written in the same transaction. The exception filter now passes an explicit `details` array through.

### API contract
`GET rate-plans/:id/readiness` 200 `{ratePlanId,status,updatedAt,ready,checks[]}`. `POST .../activate` `{expectedUpdatedAt}` and `.../suspend` `{expectedUpdatedAt,reason}` return 201 with the plan. `POST .../clone` `{code,roomTypeId?}`. Errors: 400 missing version, 403 permission (plus `permission.denied` audit), 404 other tenant, 409 codes above. Audit: `supply.rate_plan.status_changed` with actor, request id, before/after and reason, plus `supply.rate_plan.activated|suspended`.

### Test changes
- Agent-search and transaction-gate suites needed an ACTIVE plan only as a precondition. They now seed it with `test/rate-plan-status-fixture.ts` (owner connection, test-only). `admin-golden-path` activates through the real route after loading rates and inventory. `supply.e2e-spec` asserts the refusal and that nothing is persisted.
- New `rate-plan-lifecycle.e2e-spec.ts` (21 tests on PostgreSQL) covers: PATCH ACTIVE / SUSPENDED refused; mixed body atomic; mass assignment; missing rates, rate gap, expired and suspended contract; reactivation revalidated; clone never active; stale version; read-only user and denial audit; cross-tenant 404 on all four routes; audit content; six simultaneous activations (exactly one wins, one transition event); contract suspended mid-activation; no partial mutation.
- New `rate-plan-lifecycle-strict-role.e2e-spec.ts` boots the real API on `fbeds_api_login`.

### Database certification (disposable PostgreSQL 16.15 + pgvector, never a shared database)
- Fresh `prisma migrate deploy` of every migration: success; `prisma migrate status`: up to date; drift check: none.
- Strict login `fbeds_api_login`: not superuser, no BYPASSRLS, owns 0 public tables, `verifyApiRuntimeRole` ok; no UPDATE on `RatePlan.status`, no INSERT, no DELETE.
- Over that login, readiness reads (200), PATCH with status (400) and cross-tenant (404) work; **activate is refused 403 `RUNTIME_ROLE_OPERATION_PROHIBITED`, sanitized, nothing written, no status audit.**
- Baseline before the change (same database, same date): `supply.e2e-spec` already fails 6 tests (fixtures dated 2026-10-03/05 now return 400). After the change the same 6 fail and nothing else; the other migrated suites pass.

### Remaining release blockers
1. **No privileged writer for rate-plan status.** Under the strict runtime role (ADR 0032) activation, suspension and clone cannot succeed; they work only on a connection with write privilege. A decision is needed: a dedicated narrow role (like hold-expiry) limited to `RatePlan.status`, or an explicit change to ADR 0032. No grant was changed here.
2. Pre-existing: `supply.e2e-spec` date-stale fixtures (6 tests).
3. Not run: browser automation of the Rate Plans tab, Quick Update and Calendar journeys; Agent exclusion of suspended plans is covered by the migrated search suite (`rate plan inactive`) and not by a browser.
4. Four-eye approval, promotions, derived rates and plan-level market overrides remain unbuilt.
5. Hosted/persistent databases were not touched; no production certification.

## Not decided here
Four-eye approval for activation (the existing approvals module has not been reviewed for this entity), promotions, derived rates and per-plan market overrides are not built.
