# Runbook: rate plan activation approval (ADR 0057, S5)

Activating a rate plan needs a second person: one user with `supply.rates.manage` files a request bound to exactly what they reviewed, a **different** user with the same permission approves it, and the approved request is applied once. Suspension stays single-actor.

## The switch
`RATE_PLAN_ACTIVATION_APPROVAL` on the API process, read on every request.

| Value | Meaning |
|---|---|
| unset, empty or `required` | Approval is required. `POST /supply/rate-plans/:id/activate` answers `409 RATE_PLAN_APPROVAL_REQUIRED`. **This is the default.** |
| `off` | An explicit operator decision: activation is a single-actor action again. Every such activation records `activation: { mode: "off" }` in its audit event, so the bypass is visible afterwards. |
| anything else (`false`, `disabled`, a typo) | Treated as `required`. A misspelling never weakens the control. |

`GET /supply/rate-plans/capabilities` reports the effective mode (`activationApproval`), which is how the Admin chooses between "Activate" and "Activation approval".

## Before enabling it for a tenant (staffing check)
Under `required`, **a tenant with a single `supply.rates.manage` holder cannot activate any plan.** Before it is switched on in an environment:
1. List the users holding `supply.rates.manage` per tenant (Admin > Users and roles). Every tenant that activates plans needs at least two.
2. For a tenant that has one, either grant a second person the permission, or run that environment with `off` until staffed. There is no per-tenant switch; the variable is per API deployment.
3. Tell the rate managers: the requester cannot approve their own request, and approval is void if anyone changes a price, a term, or loads another night after the request.

## How a plan goes live
1. **Request** (Rates plan list > Activation approval): the plan must pass every readiness check now. The request records the plan version and a fingerprint of its terms and rates.
2. **Decide**: a different manager approves or rejects with a note. If the plan changed since the request, approval is refused (`RATE_PLAN_CHANGED_SINCE_REQUEST`) and the requester files again.
3. **Apply** (anyone with the permission, including the requester): readiness is re-run, the fingerprint re-checked, and the status written on the lifecycle role, once. Changed content gives `RATE_PLAN_CHANGED_SINCE_APPROVAL`; a failed check gives `RATE_PLAN_NOT_READY`. In both cases nothing is written and the plan stays as it was. A request that can never succeed is superseded automatically when a new one is filed.

## What is and is not enforced
- Enforced in the service and the database: requester != approver (service check and a database `CHECK`), single use (conditional claim), tenant isolation (forced RLS), the status write only on the narrow lifecycle role.
- **Not** enforced by the database: a holder of the lifecycle credential can still write `status` directly (ADR 0057 decision D3). Protect that credential accordingly.
- The approval fingerprint covers plan terms and every dated rate of the plan occupancy from the request day. It excludes stock counters and the contract's own rules (those are re-checked by readiness at apply).

## Rollback
Set `RATE_PLAN_ACTIVATION_APPROVAL=off` and redeploy; no data change. Open requests stay in the approvals list and can be ignored or withdrawn.

## Verification
`apps/api/test/rate-plan-approval.e2e-spec.ts` (20 tests, two users plus read-only and other-tenant users) and phase D of `pnpm --filter @bedbanks/api ops:strict-role-boot-smoke` (the whole flow on the strict runtime login with the lifecycle role). The older browser harnesses under `tools/admin-ops-verify` activate as one user and must be run with `RATE_PLAN_ACTIVATION_APPROVAL=off`.
