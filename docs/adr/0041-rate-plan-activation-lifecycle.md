# ADR 0041: Rate plan activation readiness and lifecycle routes

## Status
Accepted for API and Admin code. No schema, migration, grant, permission-catalogue or runtime-role change. ADR 0032 (privileged rate writes) and ADR 0014 (one sellability evaluator) are unchanged.

## Context
`PATCH /supply/rate-plans/:id` accepted any `status`, so a plan with no rates, an expired contract or no inventory could be made ACTIVE by one request, and the Admin form offered the same dropdown. There was no clone, no readiness checklist, and status changes left no before/after audit.

## Decision
1. **Pure evaluator.** `supply/rate-plan-activation.ts` decides readiness from plain facts (no database, no clock). Checks: lifecycle state, contract mapped to the room's hotel, contract ACTIVE, contract dates, plan/contract currency, room active, occupancy within room capacity, board active, stay rules, cancellation rule for refundable plans, future rates present, no missing nights between first and last rated night, every rate classified NET/SELL, every rate in the plan currency, positive amounts, and inventory linkage (future availability rows or a shared pool). Unknown is never ready.
2. **Routes.** `GET rate-plans/:id/readiness` (`supply.rates.read`); `POST rate-plans/:id/activate|suspend|clone` (`supply.rates.manage`). All are tenant-scoped, return 404 for another tenant's plan, and live in `@bedbanks/contracts`.
3. **Optimistic concurrency.** Activate and suspend require `expectedUpdatedAt`; the write is a conditional `updateMany` on id, tenant, status and version. A mismatch is `409 RATE_PLAN_CHANGED`; a failed checklist is `409 RATE_PLAN_NOT_READY` with the failed checks; a disallowed transition (including reactivating EXPIRED) is `409 RATE_PLAN_TRANSITION_NOT_ALLOWED`.
4. **Audit.** Each transition writes `supply.rate_plan.status_changed` with request id, before/after status and reason (suspension requires one), in the same transaction. Denials reuse the existing `permission.denied` event.
5. **Clone** copies the commercial shape into a new DRAFT within the same hotel; it never copies status, rates, availability or pool membership. A duplicate code on the contract is `409 RATE_PLAN_CODE_EXISTS`.
6. **Admin** gets a hotel-scoped Rate Plans tab (search, status filter, status counts, paging, activate/suspend/clone). The rate plan form no longer edits status.

## Known gap (deliberate)
`PATCH rate-plans/:id` still accepts `status` for compatibility: about ten existing e2e suites seed plans through it, and they cannot be re-run without a disposable PostgreSQL. Closing the API bypass (reject `status` on PATCH, migrate those fixtures to the lifecycle routes) is the next step. Until then the readiness gate is enforced for the Admin UI path only, not for a direct API caller with `supply.rates.manage`.

## Not decided here
Four-eye approval for activation (the existing approvals module has not been reviewed for this entity), promotions, derived rates and per-plan market overrides are not built.
