# Commercial rules: occupancy, inclusive-price and mandatory-supplement gap audit

**Date:** 2026-10-30 · **Scope:** rate-plan occupancy, `taxesIncluded` / `feesIncluded`, and contract supplements, from authoring to Agent search, recheck and hold.
**Method:** code reading of the current branch only. No database was available and no tests were run, so every finding is *code-verified*, not reproduced.

## What exists (not re-audited here)

Commercial rules, audit, build, promotions, derived rates, markup basis points, market and nationality controls, guest price lines, cancellation sets and restrictions exist in code. This audit covers only the three gaps below.

## Gap 1: occupancy consistency: partly enforced, with holes at write time

Already enforced:

| Where | Rule | Reference |
|---|---|---|
| Rate plan update | `1 <= occupancy <= room.maxOccupancy` | `apps/api/src/supply/supply.service.ts` (`updateRatePlan`) |
| Activation readiness | `OCCUPANCY_VALID` | `apps/api/src/supply/rate-plan-activation.ts:97` |
| Search pre-filter | room `maxAdults`, `maxChildren`, `maxOccupancy` vs the party | `apps/api/src/agent/contracted-inventory.adapter.ts:264-267` |
| Pricing | `OCCUPANCY_UNSUPPORTED` for a party that does not fit the plan or room | `apps/api/src/supply/guest-pricing.ts:41,48` |
| Rate import / Quick Update | per-occupancy rates limited to what the room sleeps | `calendar-import.ts:143`, `quick-update-rules.ts:224` |
| Certification | `OCCUPANCY_EXCEEDS_ROOM` | `apps/api/src/rate-certification/rate-plan-audit.ts:120` |

Gaps:

1. **`createRatePlan` checks only `Number.isInteger(occupancy) && occupancy >= 1`.** It never compares with the room's `maxOccupancy`, unlike `updateRatePlan`. A DRAFT plan can be created over the room limit; it is caught only at activation or by certification.
2. **Room limits can be lowered under live plans.** The room update path (`hotel-rooms.service.ts`, `update`) writes `maxAdults` / `maxChildren` / `maxOccupancy` with no check of the rate plans that use the room. An ACTIVE plan can silently become unsellable (certification reports `OCCUPANCY_EXCEEDS_ROOM` later).
3. **Plan occupancy is never checked against `maxAdults`.** The base party of a plan with `occupancy = 3` in a room with `maxAdults = 2, maxChildren = 1` is only sellable as 2 adults + 1 child. Nothing at authoring time says whether the base party can be formed.
4. **`occupancySplit` in `commercial-assessment.ts` assumes adults fill the base first.** It is an assessment default, not a contract term, and can disagree with how search forms the party.

Proposed fix: one shared `planOccupancyProblems(plan, room)` used by create, update, activation and the room-update path (the room update refuses, or lists affected ACTIVE plans, rather than silently breaking them).

## Gap 2: inclusive-price enforcement: a label, not a rule

`RatePlan.taxesIncluded` and `feesIncluded` default to `false`. They are:

- stored, edited (`RatePlanForm.tsx`) and part of the plan fingerprint and clone (`rate-plan-fingerprint.ts`, `rate-plan-activation.ts`);
- passed through to the offer as `priceIncludes` (`contracted-inventory.adapter.ts:529`) and rendered as text (`apps/agent/lib/pay-at-hotel.ts`);
- gated only on the **supplier-ingest promotion** path: `promotion-rules.ts` refuses an observation whose tax basis is not stated inclusive, and a plan without the flag.

Not enforced:

1. **Pricing, activation and certification never read the flags.** A plan with `taxesIncluded = false` sells at the same total as one with `true`; no tax or fee amount is modelled, so "excluded" has no price consequence.
2. **No activation check** requires the tax and fee basis to be a deliberate decision (the defaults are silent `false`).
3. **Reconciliation assumes all-inclusive net (ADR 0029, `packages/money/src/reconciliation.ts:153`)**, so a plan marked `false` conflicts with the finance assumption without anything saying so.

Decision needed before code: is the platform's rule "every sellable plan is all-inclusive" (then enforce `true`, or refuse), or are excluded taxes and fees to be modelled (then add a tax/fee line type, amounts in minor units plus currency, and a payable-at-hotel split)? Per CLAUDE.md this needs an ADR in `docs/adr`.

## Gap 3: mandatory supplements: exist, but are not a general mechanism

What is real: `ContractSupplement` (`BOARD` and `COMPULSORY`) is validated (`supply/supplements.ts`), versioned through contract amendments (`contract-approval.service.ts`) and priced by the evaluator after the promotion and before the markup (`contracted-sellability.ts:311`, via `stay-snapshot.ts:145`). `EventSupplement` (ADR 0089) adds approved, event-linked fixed and percentage charges. The offer lists both inside the total.

So the statement "not established by child-policy fields alone" holds, but compulsory supplements are not absent. What is missing:

1. **Child-policy fields do not carry mandatory charges.** `ChildPolicy` bands price children only (`guest-pricing.ts`); a mandatory per-person charge must be a `ContractSupplement`.
2. **No market, nationality, age or payment-location scoping.** A supplement applies to every party; it cannot be restricted to a market, charged at the hotel, or limited to a party type beyond `PER_ADULT` / `PER_CHILD` / `PER_PERSON` / `PER_ROOM`.
3. **No percentage kind on `ContractSupplement`.** Only `EventSupplement` has `PERCENTAGE`.
4. **`amountMinor` must be greater than zero** (`supplements.ts`, `MINOR`), so a deliberately free or waived mandatory item cannot be recorded.
5. **ADR 0057 still says supplements are "not done"** (line 93). ADR 0067 superseded that; the older text should be amended so readers are not misled.

## Recommended order

1. Gap 1.1 and 1.2 (small, local, tests): shared occupancy check on create and room update.
2. Decide the tax/fee policy (Gap 2) in an ADR before any schema change.
3. Gap 3.2 to 3.4 only after the Gap 2 decision, since payable-at-hotel and tax-type charges share the same model.
4. Amend ADR 0057 line 93.

## Not verified

No test or build was run, no database was queried, and live data was not inspected. Line numbers refer to the current branch and may drift.
