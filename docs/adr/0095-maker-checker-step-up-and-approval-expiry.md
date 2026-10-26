# ADR 0095: Checker step-up, direct-call guard and approval expiry

## Status
Accepted. Adds migration `202612090001_approval_request_expiry` (enum value and CHECK only; no table, column, index or grant). Not applied to any database in this change: it was not run against PostgreSQL, so it needs the ADR 0013 human decision and a disposable-database run first.

## Context
Maker-checker already exists (ADR 0016, 0017, 0018, 0024, 0067, 0070, 0077, 0093): the approval service and the database forbid a decider who is also the requester, and settlements, funding receipts, reconciliation exceptions, markups, FX rates and agency credit limits each separate maker and checker. Gaps found by inspection:
1. A stolen or left-open session could approve. Nothing re-proved the checker's identity.
2. Execution routes relied only on the service; a route could be added or changed without the approval precondition at the HTTP layer.
3. A request could wait, or an approval sit unexecuted, indefinitely.
4. Audit events carried no client address.

Not found, and deliberately not built: any refund-application, credit-note-application or manual ledger adjustment endpoint (ADR 0054 keeps them blocked on accounting policy and a restricted write role; `refund.*` and `adjustment.*` are still `planned` in the catalogue). No approval threshold is invented (ADR 0016 item 7).

## Decision
1. **Password step-up for checkers.** `@RequireStepUp(action, param)` + `StepUpGuard`: the signed-in checker sends `stepUpPassword` (contract: `@bedbanks/contracts` `STEP_UP_FIELD`). `StepUpService` verifies it against that user's hash (bcrypt, constant-time path for unknown users), throttles failures (5 per account and address, 20 per address, 15 minutes, per process), and audits `step_up.verified`, `.failed`, `.missing`, `.throttled`. The guard deletes the field from the body first, so no handler, log or audit payload sees it. Applied to: markup, FX, agency credit, reconciliation-run approvals; supplier settlement approve; reconciliation exception approve; bank exception resolve; funding receipt post.
2. **Direct-call guard.** `@RequireDualApproval(action)` + `DualApprovalGuard` on execute routes refuses unless `:approvalId` is an APPROVED request for exactly that action, in the session tenant, decided by someone other than the requester. Refusals audit `approval.bypass_refused` with requester (Admin A), decider (Admin B) and caller. The owning service still claims the approval and re-validates domain rules.
3. **Expiry.** New status `EXPIRED`. PENDING requests expire `APPROVAL_TTL_HOURS` (default 72, 1 to 720) after the request; APPROVED ones that long after the decision. A conditional update moves them before any read, decision or execution, so a concurrent decision wins; expiry is audited as `approval.expired` (system actor). Error code `APPROVAL_EXPIRED`.
4. **Audit context.** A request-scoped `AsyncLocalStorage` holds request id and `req.ip`; `AgentAuditService` stamps them on every event written during a request (an explicit payload field wins). Behind a proxy not covered by `trust proxy` this is the proxy address: evidence, never authorisation. Audit writes made directly inside a transaction (settlement, bank exception) do not pass through this service and carry no address yet.
5. **Admin UI.** `useStepUp()` / `StepUpDialog` asks for the password on each approve button above; failures and timeouts render `ErrorState` with the request id and keep the dialog open (final failures such as expiry offer Close only).

## Naming
The spec's `PENDING_APPROVAL` is the existing `PENDING` status; renaming an enum value used by eight modules adds risk for no behaviour. `FINANCE_SUPERVISOR` is not a role: the checker is whoever holds the approve permission (`finance.settle.approve`, `funding.manage`, ...), per ADR 0015.

## Not built
- **TOTP.** It needs encrypted secret storage, enrolment, recovery and an ADR of its own. Password re-verification is the step-up today; it is not a second factor.
- Step-up on promotions, contract, rate-plan, hotel-publication and tenant-lifecycle approvals (the same one-line decorator, but each has its own UI and e2e flows).
- Refund, credit-note application and ledger adjustment write paths (ADR 0054).
- `supplier-terms` has a single actor and no checker.
- Throttle state is per API process, as for sign-in (ADR 0062).

## Consequences
- API clients that approve on the listed routes must send `stepUpPassword`; the Admin UI does.
- Rollback: revert the API and Admin first; the migration is forward-only (statements in its header).
- Tenant index review: the expiry sweep uses the existing `(tenant_id, status)` index.
