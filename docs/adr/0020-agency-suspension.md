# ADR 0020: Agency suspension

## Status
Accepted. Adds the reviewed migration `202610110001_agency_suspension` (one `ALTER TYPE "AgencyStatus" ADD VALUE 'SUSPENDED'`, no table, column, index or grant change), applied only to disposable local databases. It stacks on ADR 0019 and its unmerged migration.

## Context
ADR 0019 left `agency.suspend` (S3) planned: INACTIVE is a directory state that blocks nothing. This slice makes suspension mean something, using the maker-checker foundation (ADR 0016).

## Decisions
1. **Status.** `AgencyStatus` gains `SUSPENDED`. A plain edit (`PATCH`) can only set ACTIVE or INACTIVE, and cannot change the status of a suspended agency, so SUSPENDED is entered and left only through an approved request.
2. **Maker-checker for both directions.** `agency.suspend` is an `approvalOnly` S3 catalogue key refining `agency.manage`. One approval action covers suspend and reinstate (`proposedState.change`). Requester and approver differ (service rule plus database CHECK), an approval is single use, one open request per agency, and execution re-checks that the agency is still in the state it was approved from.
3. **What is blocked.** Members of a suspended agency cannot search, check search status, recheck, hold, prebook or create a booking. Fail closed by handler: `AgencySuspensionGuard` blocks every Agent route unless it opts out with `@AllowWhenAgencySuspended`. Opted out: destinations and facets, releasing a hold, cancelling and reading existing bookings and documents, finance and audit reads. Suspension stops new exposure; it does not strand existing bookings.
4. **Who is affected.** Only users who are members of that agency. Users in no agency, and other agencies, are unaffected. The guard is on the Agent controller only; Admin routes are untouched.
5. **(Superseded by ADR 0031: unreadable agency tables now answer 503 COMMERCIAL_CONTROL_UNAVAILABLE; the text below is the original policy.) Explicit policy when the agency table is unreadable.** If the API database role cannot read `Agency` or `AgencyMember` (ADR 0013), the guard lets the request through and logs a warning, as for distribution restrictions (ADR 0019). Failing closed would stop every agent in the tenant. This is a decision for the business to confirm; the alternative is to fail closed.
6. **Audit.** `agency.suspended` and `agency.reinstated` are written on execution with identifiers only (approval id). The reason lives in the approval record, not the audit payload.
7. **Not built.** Suspending an agency does not cancel holds or bookings, touch credit or wallets, or notify anyone. Suspended members are not signed out.

## Consequences
- `agency.suspend` becomes enforced. The Admin agencies page shows request, approve, reject, withdraw and apply controls, and the summary counts suspended agencies.
- A suspended agent receives HTTP 403 with the error code `AGENCY_SUSPENDED` on new commercial routes. The Agent app maps that code, and only that code, to a dedicated "Your agency is suspended" state for search, recheck, hold and booking, with no retry prompt; any other 403 stays a plain access denial.
- Rollback: reinstate every suspended agency before reverting the API; PostgreSQL cannot drop an enum value, and the unused value is harmless.
