# ADR 0017: Reconciliation approval and the governance department summaries

## Status
Accepted. Amends the unmerged migration `202610080001_approval_requests` (ADR 0016) to add the single-use `EXECUTED` state; that migration has been applied only to disposable local databases. ADR 0013 is unchanged: no grant was changed, and the migration's conditional grant still needs the human decision before any persistent environment.

## Context
ADR 0016 built the maker-checker foundation with no consumer. The reconciliation run is the clearest S3 action Admin already exposes. Separately, three departments in the catalogue (Market Operations, System & Reliability, Risk & Compliance) have real data behind them in tables that already exist, while Commercial, Distribution, Clients and Service have no domain model at all.

## Decision
1. **Reconciliation maker-checker is an additive path.** A requester asks (`POST .../reconciliation/approvals`) with a reason and optional run parameters; a different person approves or rejects; anyone holding `booking.reconcile` then executes it once. Execution runs the existing idempotent reconcile with exactly the approved parameters and ignores anything in the execute request. The direct run is unchanged. Making approval mandatory is a policy decision for the business and is not taken here.
2. **Permissions.** Requester, approver and executor all need the existing `booking.reconcile`. `reconciliation.resolve` is catalogued as an `approvalOnly` action (S3) that refines `booking.reconcile`; it is not a grantable permission. Separation of duties is enforced by the approval service and by a database CHECK. A distinct approver permission is the recommended next step once roles are defined.
3. **Single use.** `execute` claims APPROVED to EXECUTED with a conditional update before running, so concurrent callers cannot both run it. If the run throws, the claim is released back to APPROVED and the failure is audited; this is safe only because reconcile is idempotent, which the contract of `execute` states.
4. **Evidence for the approver.** The request records the stalled-hold count a read-only dry run saw at request time. It is evidence, not a promise.
5. **Read-only summaries for three departments, from existing tables only.** Markets (hotels by destination with the Agent-search evaluator's verdicts), Reliability (connectors, windowed connector executions, uncertain supplier calls, stalled holds) and Access review (tenant members, roles and S3 permission holders with flags). They use existing permissions (`supply.hotels.read`, `booking.read`, `audit.read`), return `SectionState` where the runtime role may be denied, and never add currencies or compute rates.
6. **Not built, deliberately.** Commercial promotions (markups are built in ADR 0018), Distribution (markets, channels, rules), Clients (agencies, commercial profiles, credit) and Service (cases) have no schema, no authority and no business rules in the repository. Building pages for them would present placeholders as capability (invariant 10), and inventing pricing or credit rules would put money logic in an unreviewed place. Each needs its own domain decision, ADR and migration first.

## Consequences
- Catalogue modules for Markets, Reliability and Risk are now `live`; the sidebar and dashboard show them. The four undefined departments stay out of the sidebar.
- The Access review flags are evidence for a periodic review, not a verdict; roles are still changed in Roles & Permissions.
- Rollback of the approval consumer: remove the six routes; the table is unused by anything else. The migration rollback notes are in its header.
