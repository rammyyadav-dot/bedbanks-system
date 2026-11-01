# ADR 0016: Maker-checker approval request foundation

## Status
Accepted as a foundation. No controller, route, role grant or department consumes it yet. Applying its migration to any persistent environment needs the ADR 0013 human decision, because the migration carries a conditional `GRANT` for the API runtime role (same pattern as `SupplierMutation`).

## Context
S3 actions (refund and adjustment approval, credit limits, reconciliation resolution, connector booking activation, role assignment) need a second person. Building one mechanism per department would drift. An approval must also never stand in for domain validation.

## Decision
1. **One table, `ApprovalRequest`,** tenant-scoped with forced RLS. It stores the permission key of the action, the entity, an idempotency `request_id`, a reason, minimal before and proposed state, the requester, the decider, the decision time and reason.
2. **Integrity in the database as well as the service.** A CHECK forbids the decider being the requester, and requires a decider and time for APPROVED and REJECTED. `(tenant_id, action, request_id)` is unique so repeats are idempotent.
3. **A one-way state machine.** PENDING moves once to APPROVED, REJECTED or CANCELLED through a conditional update; concurrent decisions yield exactly one winner. A repeat of the same decision by the same user is a safe no-op. Only the requester can cancel.
4. **Audit.** `approval.requested`, `.approved`, `.rejected`, `.cancelled` and `.denied` (self-approval attempts) are recorded through the existing audit service, which redacts credentials and PII.
5. **State hygiene.** Stored state is sanitised, bounded in size and may not contain fractional numbers (money is integer minor units).
6. **Scope of the service.** It guarantees separation of duties, idempotency, the state machine and audit. It does not check that a caller holds a permission and does not execute the action. The owning controller enforces the permission; the owning canonical service re-validates the domain rules when it acts on an APPROVED request. Only S2 and S3 catalogue actions can be requested.
7. **Thresholds are configuration, not code.** No monetary approval threshold is hard-coded; fBeds has not defined any.

## Alternatives rejected
- Per-department approval tables: drift and inconsistent audit.
- Executing the action inside the approval service: moves domain authority out of its owner.
- Service-only separation of duties: a direct database write could bypass it.

## Consequences
- The first consumer (for example refunds) adds its own controller, permission guard, validation and tests, and calls this service.
- Rollback is a later forward migration (statements are in the migration header). Nothing reads the table today, so removal has no runtime effect.
- Tenant index review: `(tenant_id, status)` for queues and `(tenant_id, entity_type, entity_id)` for an entity's history.
