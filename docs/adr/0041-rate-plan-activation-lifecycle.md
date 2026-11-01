# ADR 0041: Rate plan activation readiness and lifecycle routes

## Status
Accepted for API and Admin code. Amendment 1 (bypass closure) implemented and certified on disposable PostgreSQL only; blocker 1 is resolved in code by Amendment 2 (operator provisioning and hosted certification remain). No schema, migration, grant, permission-catalogue or runtime-role change. ADR 0032 (privileged rate writes) and ADR 0014 (one sellability evaluator) are unchanged.

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
1. ~~No privileged writer for rate-plan status.~~ Resolved in code by Amendment 2 (narrow `fbeds_rateplan_ops` role). Clone still needs a privileged writer.
2. Pre-existing: `supply.e2e-spec` date-stale fixtures (6 tests).
3. Not run: browser automation of the Rate Plans tab, Quick Update and Calendar journeys; Agent exclusion of suspended plans is covered by the migrated search suite (`rate plan inactive`) and not by a browser.
4. Four-eye approval, promotions, derived rates and plan-level market overrides remain unbuilt.
5. Hosted/persistent databases were not touched; no production certification.

## Amendment 2: narrow lifecycle role (blocker 1 resolved in code)

### Decision
Activation and suspension run as a dedicated login, `fbeds_rateplan_ops` (member of the NOLOGIN group `fbeds_rateplan_status`), not as the strict API runtime role. ADR 0032 and the runtime role's grants are unchanged. The pattern is the booking-ops role (ADR 0039): a separate credential, `RATE_PLAN_OPS_DATABASE_URL`, used by one code path only.

### Exact privileges (`database/rate-plan-ops-role.ts`, the single statement of them)
| Object | Privilege |
|---|---|
| `RatePlan` | `UPDATE (status, updated_at)` and `SELECT` |
| `RoomType`, `BoardBasis`, `Contract`, `SupplierHotelMapping`, `CancellationPolicy`, `DailyRate`, `DailyAvailability` | `SELECT` (readiness inputs; the ORM reads whole rows) |
| `Hotel` | `SELECT (id, tenant_id, time_zone)` only |
| `AuditEvent` | `INSERT` only (not readable; written with `createMany`, so no row is read back) |
| everything else | nothing: no INSERT/DELETE of a rate plan, no write to rates, availability, contracts, inventory, bookings, users |

Role attributes: NOSUPERUSER, NOBYPASSRLS, NOCREATEROLE, NOCREATEDB, NOREPLICATION, owns no table. Forced RLS still applies; every use sets `app.current_tenant_id` in its transaction.

### Behaviour
- `RATE_PLAN_OPS_DATABASE_URL` set and different from `DATABASE_URL`: activate and suspend run on it, Serializable, after the application permission check on the HTTP client. The readiness evaluator and the conditional write are unchanged, so the gate cannot be skipped on this path.
- Not set: unchanged behaviour (HTTP client). Under a strict runtime login the database refuses with 403 `RUNTIME_ROLE_OPERATION_PROHIBITED`; in a disposable owner environment it works.
- Set but unreachable, refused or missing a grant, or failing the restricted-identity check: sanitized 503 `RATE_PLAN_OPS_UNAVAILABLE`. It never falls back to the HTTP client and returns nothing from the URL or the database error.
- **Clone stays on the HTTP client.** It inserts a row, which this role must not do, so under the strict login it remains refused. Moving clone onto a separate narrow grant is a separate decision.
- Provisioning is owner-run and idempotent: `pnpm --filter @bedbanks/api ops:provision-rate-plan-ops-role` (same remote-target confirmation as the other roles). No migration was needed. Rollback: `deprovisionRatePlanOpsRole`, unset the URL.

### Evidence (disposable PostgreSQL 16)
- `verifyRatePlanOpsRole` reports ok: not superuser, no BYPASSRLS, owns 0 tables, no table-wide write anywhere, INSERT only on `AuditEvent`, UPDATE only on `status`/`updated_at`, no column write outside `RatePlan`/`AuditEvent`, audit log unreadable, `Hotel` limited to three columns. Provisioning twice converges.
- Probes as the role, each refused by the database: update `RatePlan.code` and `currency`, delete a `RatePlan`, update `DailyRate`, `DailyAvailability` and `Contract`, read `AuditEvent` and `users`, read `Hotel.name`. With another tenant's context a status update matches 0 rows; without tenant context 0 rows are visible.
- Strict API (`fbeds_api_login`) with the role configured: activate 201 (audit row has the actor, request id and before/after), suspend 201, stale version 409 `RATE_PLAN_CHANGED`, a plan without rates 409 `RATE_PLAN_NOT_READY` and stays DRAFT, clone refused. Without the URL, activate is still 403.
- Unit: `rate-plan-ops-database.spec.ts` (configuration, sanitized 503 on an unreachable credential, grant list has exactly one UPDATE and one INSERT).

### Remaining
Operator action to enable it in an environment: provision the role, store `RATE_PLAN_OPS_DATABASE_URL`, deploy. Not exercised here: hosted or persistent databases, production-clone compatibility, browser journeys. The `PATCH` bypass remains closed independently of this role.

## Not decided here
Promotions, derived rates and per-plan market overrides are not built. Four-eye approval is assessed in Amendment 3 and **not** implemented: it needs an owner decision.


## Amendment 3: environment capability, clone decision, error propagation, boot smoke, four-eye assessment (issue 304)

### Status
Items 1 to 4 are implemented (API route, contract, Admin, tests). Item 5 is a **proposal only**: nothing in it is built, and it needs an explicit owner decision before any code. No schema, migration, grant or runtime-role change. ADR 0032 and Amendment 2's grants are unchanged.

### 1. Clone stays unavailable in strict environments (decision)
Clone inserts a `RatePlan` row. `fbeds_rateplan_ops` must not insert, and widening `fbeds_api` is excluded by ADR 0032. **Decision: clone is unavailable under the strict runtime login until a separately approved, narrowly scoped, audited writer exists.** The alternatives, for that future decision:

| Option | Cost | Verdict now |
|---|---|---|
| Add `INSERT` on `RatePlan` to the lifecycle role | A role that can insert plans can also insert an ACTIVE one unless a trigger or CHECK forces DRAFT on insert; needs a reviewed migration | Rejected for now |
| New role `fbeds_rateplan_clone`: `INSERT` on `RatePlan` plus audit, source `SELECT`, with a reviewed `BEFORE INSERT` trigger forcing `status = DRAFT` for that role | One more credential, migration and rollback note | Candidate, needs approval |
| Leave clone out of strict environments | Operators use "Create Rate Plan" | **Chosen** |

The refusal stays database-enforced (`403 RUNTIME_ROLE_OPERATION_PROHIBITED`, sanitized, audited, nothing written). It is not enforced by the new capability route; the route only lets the Admin say so before the click.

### 2. Capability route
`GET /supply/rate-plans/capabilities` (`supply.rates.read`) returns `{activate, suspend, clone}`, each `{available, reason}`. It is derived from the runtime identity's real privileges (`has_column_privilege(..., 'RatePlan', 'status', 'UPDATE')`, `has_table_privilege(..., 'RatePlan', 'INSERT')`) and whether `RATE_PLAN_OPS_DATABASE_URL` is configured; the pure decision is `rate-plan-capabilities.ts`. Reasons: `LIFECYCLE_ROLE_NOT_PROVISIONED`, `STRICT_ROLE_NO_WRITER`. It reports no credential, host or role name. "Configured" does not prove the lifecycle role is reachable; a configured but unusable role still answers a sanitized `503 RATE_PLAN_OPS_UNAVAILABLE` at use. A failed probe is an error, not "available". The Admin disables the control with the reason as tooltip and a notice, and fails closed (disabled) while the lookup is pending or failed. The API stays the only authority.

### 3. Structured error details
The Admin client now keeps object-valued `error.details` as `ApiResponseError.structuredDetails` next to the unchanged string `details`. `readinessFailuresFromError` validates the shape and the dialog lists the server-rejected checks immediately, still refreshing the live checklist.

### 4. Boot smoke
`ops:strict-role-boot-smoke` now boots the real API three times: (A) ordinary restricted role only: activate, suspend, clone fail closed with typed sanitized 403, nothing written, no status audit; `PATCH status`, 401, 403, tenant 404 and missing version behave; (B) lifecycle role provisioned and verified (role verifier plus 21 `ops:verify-rate-plan-ops-role` probes) and configured: activate and suspend succeed with exactly one audit event, authorization and tenant isolation still apply, a plan without rates is `409 RATE_PLAN_NOT_READY` with structured checks, stale versions are `409`, clone stays refused; (C) a rejected lifecycle credential gives sanitized `503` and no fallback write.

### 5. Four-eye activation: assessment and proposal (not implemented)
**Existing subsystem (ADR 0016, used by ADR 0018, 0020, 0022).** `ApprovalRequest` is tenant-scoped with forced RLS and is already in the strict runtime role's write set; a database CHECK forbids decider = requester; one-way state machine with a single-use `execute` claim; audit events; catalogue-bound actions of class S2/S3 only. Reuse is possible without new tables and without widening `fbeds_rateplan_ops`: approval state lives on the runtime connection, the status write stays on the lifecycle connection.

**Gaps that block a direct reuse (each needs a decision or work):**
1. No catalogue key. Precedent: `markup.activate` and `hotel.activate` are `approvalOnly` S3 keys refining `supply.rates.manage`. A key such as `rate_plan.activate` would be a contracts change.
2. Two connections, so the claim and the status write are not one transaction. `ApprovalService.execute` claims APPROVED to EXECUTED first and releases it if the action throws, which is safe only because the transition is idempotent and version-checked, as it is here. Needs an explicit test.
3. Binding to what was reviewed (ADR 0022 pattern): store `updatedAt`; changed after request means it cannot be approved, changed after approval means it cannot be applied (409); readiness is re-run at apply, so approval never waives a check.
4. The existing `POST .../activate` must stop being a one-actor path where the policy applies (as ADR 0022 closed `to: COMPLETE`). That is a behaviour change for every suite that activates through the route.
5. Database-level enforcement: the approval is application-level. A holder of the lifecycle credential can still write `status` directly. A trigger requiring an approved request would close it but is a migration and a grant change; it is not proposed here.
6. The plan has no creator column. "The creator cannot approve" can be enforced as requester not equal to approver (already guaranteed by service and CHECK). Enforcing it against whoever created or last edited the plan would need the audit trail or a new column, and is a policy choice.

**Owner decisions required before any code:**
- Scope: always required (as hotel publication), or a per-tenant setting (a settings schema change), or only above a threshold. fBeds has defined no threshold.
- Consequence to accept: with "always required" a tenant with one holder of `supply.rates.manage` cannot activate a plan (the same consequence as ADR 0022).
- Who may approve: any other holder of `supply.rates.manage`, or a dedicated approver permission.
- Suspension stays single-actor (it only removes exposure), unless the owner decides otherwise.
- Whether the lifecycle role's direct-write exposure (point 5) is acceptable.

**Proposed shape if accepted:** request (`supply.rates.manage`, version bound) then decide by a different user, then apply on the lifecycle connection through `ApprovalService.execute`, with readiness re-run, `supply.rate_plan.status_changed` carrying the approval id, approver and executor. Tests: self-approval refused (service and CHECK), stale version on approve and on apply, double apply, concurrent apply, tenant isolation, strict-role boot smoke (A/B/C) extended with the approval path.

### Remaining after this amendment
Operator provisioning of `fbeds_rateplan_ops` and `RATE_PLAN_OPS_DATABASE_URL` in each strict environment; hosted certification by procedure (`docs/runbooks/rate-plan-ops-role-certification.md`); the clone writer decision; the four-eye decision above.
