# ADR 0115: Enforce all-inclusive launch rates at activation and sale

Status: Accepted implementation of ADR 0029's existing launch policy.

## Problem

The contracted adapter quotes zero separate tax and mandatory-fee amounts. Rate plans already declare `taxesIncluded` and `feesIncluded`, but activation and the shared stay evaluator did not require those declarations. A directly authored exclusive rate could therefore be offered without the missing charges being calculated.

## Decision

Both existing declarations must be explicitly true. Missing, false and unknown values fail closed. Draft authoring remains possible with the current false defaults; authoring is not approval to sell.

- Rate-plan readiness blocks activation and returns actionable checks. Both direct activation and approval-based activation consume that readiness result.
- `StayPlanInput` and `ContractedStaySnapshot` require both declarations, so a narrow loader cannot silently omit them. The shared evaluator refuses non-inclusive plans with `TAX_BASIS_NOT_INCLUSIVE` or `FEE_BASIS_NOT_INCLUSIVE`. Search, recheck, diagnostics and certification consume the same decision.
- The final offer mapping check and the transactional stock-reservation query independently require both declarations. A flag change before allocation is read cannot leave a new hold or changed stock. Existing idempotent hold replay and booking servicing retain their original semantics.
- The Agent still shows separately disclosed charges collected by the property, such as Tourism Dirham. They are not added to the bedbank's net or sell total. Setting the declarations asserts the supplier net includes all charges the bedbank owes; it must not conceal separately collected local charges.
- Admin uses the shared contract's reason wording. There is no new API route or database column.

## Rollout

No migration, automatic backfill or production activation is part of this change. Existing false/unverified plans become unavailable for new sales and must be reviewed against supplier contracts by supply/finance owners. Never mass-set the flags to true merely to recover search results. Prepare the catalogue review before deployment; a reduced sellable catalogue is intentional fail-closed behavior.

Do not infer legal approval for VAT, invoice wording, margin tax or privacy. Those remain owner decisions. Booking/payment feature switches remain unchanged.

## Verification

Tests cover missing/exclusive values, activation refusal without writes, inclusive positive controls, withdrawal after a declaration changes, and PostgreSQL allocation refusal without leftover holds or stock changes. Existing valid test fixtures explicitly declare inclusion rather than depending on database defaults. Cross-tenant and agency assertions remain enabled.

## Recovery

No persistent schema or history changes need reversal. If unexpected exclusions occur, stop new sales and inspect the flags and supplier terms; retain servicing of existing bookings. Reverting the application change would restore the previous policy gap and requires an explicit release decision, not a data rewrite.
