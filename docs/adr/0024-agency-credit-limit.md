# ADR 0024: Agency credit limit

## Status
Accepted. Adds the reviewed migration `202610140001_agency_credit_limit` (one tenant-scoped table with forced RLS, integrity CHECKs, one index on `InventoryHold`, and a conditional GRANT), applied only to disposable local databases. Stacks on ADR 0020 to 0023.

## Context
ADR 0019 left credit limits out ("nothing here sets a credit limit"). Agencies place holds without any ceiling on what they commit. The platform has no wallet or ledger-backed credit, so a limit here is an exposure ceiling over holds and bookings, not a balance.

## Decisions
1. **What is limited.** One limit per agency, one currency, integer minor units (`bigint`, `limit_minor >= 0`). **Committed** = sum of `sellAmountMinor` of holds created by the agency's current members, in the limit currency, whose status is HOLD_PENDING, PROCESSING or CONFIRMED, or HELD and not yet expired. Holds, not bookings, are summed: a booking draws on one hold, so nothing is counted twice, and cancelling a booking releases its hold.
2. **Where it is enforced.** When a hold is placed (`InventoryHoldService.create`), after the idempotent replay check and before anything is written. A hold that would make committed plus amount exceed the limit is refused with 403 `AGENCY_CREDIT_LIMIT_EXCEEDED` (details: currency and `availableMinor`). Exactly at the limit is allowed. There is no override. Bookings, prebooks and rechecks create no new exposure and are not checked.
3. **Concurrency.** The check, the sum and the insert run in one transaction under a per-agency `pg_advisory_xact_lock`, so concurrent holds serialise.
4. **Who is not limited.** A user in no agency, and an agency with no limit row, are not limited. "No limit" is shown as such in Admin and means nothing is enforced; it is not zero.
5. **Currency.** A hold in a currency other than the limit's is refused, 403 `AGENCY_CREDIT_CURRENCY_MISMATCH`. No conversion is done.
6. **Fail closed.** If the agency, membership, limit or hold sum cannot be read, the hold is refused with 503 `AGENCY_CREDIT_UNAVAILABLE`. This differs from agency suspension (ADR 0020), which lets requests through when its table is unreadable: credit is a money control. Consequence: the migration's grant must be applied (ADR 0013 decision) before this code runs against a persistent database, or agency members cannot place holds.
7. **Changing a limit is maker-checker.** `credit_limit.approve` (already planned in the catalogue) becomes an enforced approval-only S3 key refining `agency.manage`. One request type covers set, change and remove (`limitMinor: null`). Requester and approver differ, one open request per agency, single use, and applying re-checks that the stored limit is still what it was when requested (409 `AGENCY_CREDIT_CHANGED_AFTER_REQUEST`).
8. **Lowering below commitments.** Allowed. Existing holds and bookings are untouched; new holds are refused until commitments fall.
9. **Own controller.** The five endpoints live in `AgencyCreditController`, not `ClientsController`, because the Clients department has no money authority (ADR 0019) and its guard test forbids credit handler names. A new test pins the credit controller to exactly those five handlers.
10. **Audit.** Applying writes `agency.credit_limit.changed` with the approval id, currency, new and previous limit minor units; the reason stays in the approval record.
11. **Membership edge.** Exposure follows current membership. Removing a member removes their holds from the agency's committed total; moving a user to another agency moves their exposure with them. Not addressed here.

12. **Near-limit flag.** The API sets `nearLimit` when committed is at least 80% of the limit (`AGENCY_CREDIT_NEAR_LIMIT_PERCENT`, a fixed default, integer arithmetic on bigint). Admin shows a "near limit" tag. It is display only: it blocks nothing and notifies no one.

## Not built
Per-user limits, multi-currency limits, limits on bookings or confirmed totals separate from holds, configurable thresholds, notifications, wallet or payment-backed credit, an Agent-app message for the refusal (the Agent app shows its generic hold error until a follow-up reads the code).

## Consequences
- Admin Agencies gets a Credit panel (position, request, approve, reject, withdraw, apply).
- Rollback: revert the API first (limits stop being enforced), then a later forward migration may drop `AgencyCreditLimit` and the new index; rows are inert.
