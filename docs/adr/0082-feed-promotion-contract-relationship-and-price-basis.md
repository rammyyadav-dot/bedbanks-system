# ADR 0082: Feed promotion: relationship to the contract, price basis and tax

Status: Accepted (owner decisions 1, 1b, 2 and 2b of 2026-10-21). Rules and the single-writer guard are built; promotion itself is not.
Date: 2026-10-21

## Context
ADR 0081 resolves ingested observations to canonical plans. Writing them into `DailyRate` is the step that makes feed data sellable, so it needs decisions about who owns a plan's prices and
what a feed price means. These four were put to the owner with options; the recommended option was chosen each time.

## Decisions (owner)
**1. Feed-managed plan.** A plan whose supplier rate plan mapping is APPROVED (MAPPED) is *feed-managed*: the feed is the single writer of its nightly prices, promotion overwrites them, and manual
edits to those prices are refused. The mapping is the flag, so there is no new column: approving the mapping hands the plan to the feed, reopening it hands the plan back. A PENDING or REJECTED
mapping manages nothing. Rejected alternatives: fill-gaps-only (a supplier price change would never arrive) and per-batch approval (a person in the loop for every feed).

**1b. Hold the batch.** A feed batch is held whole, and nothing from it is promoted, when any night moves by more than **30%** against its currently promoted price, or when more than **20%** of
previously promoted future nights are absent from it (an empty batch against existing nights is a 100% drop). A first price is not a move. Exactly 30% and exactly 20% pass. This is deliberately
stricter than the 50% confirmation guardrail for manual edits (ADR 0067 F-13): a person confirming a manual edit sees the numbers, while nobody watches a feed. A held batch goes to a person.

**2. NET only.** Promoted rates are written with `amountBasis = NET`, so they sell only after an ACTIVE markup rule applies (ADR 0018). A feed can never publish an agent-facing SELL price. An ingest
profile must declare `amountBasis: 'NET'` to be promotable (never defaulted); a profile that declares `SELL` is refused at registration; an undeclared profile can ingest and resolve but never promote.

**2b. Explicit, tax-inclusive, AED.** Consistent with ADR 0029 (net rates are all-inclusive; AED at launch), a rate is promotable only if the observation states `taxesIncluded = true`, the plan is flagged
`taxesIncluded`, the currency is an enabled settlement currency and equals the plan's, and the net is positive. Unstated or tax-exclusive is blocked, never converted or guessed, and no tax line is created.

## What is built
- `mapping/promotion-rules.ts` (pure): `checkRatePromotable` returns the first broken rule in a fixed order (`BASIS_NOT_NET`, `TAX_NOT_STATED_INCLUSIVE`, `PLAN_TAX_FLAG_NOT_SET`, `CURRENCY_NOT_ENABLED`,
  `CURRENCY_NOT_PLAN_CURRENCY`, `NET_NOT_POSITIVE`); `evaluateBatchGuard` and `FEED_BATCH_GUARD` implement 1b with BigInt integer maths.
- `supply/feed-managed.ts`: `assertRatesNotFeedManaged` refuses (409 `RATE_PLAN_FEED_MANAGED`, naming the plans, nothing written) on both manual price-write paths: the rate calendar apply/preview/import
  (`SupplyService`) and Quick Update (`HotelQuickUpdateService`, preview and apply). A spec scans the source tree and fails if any other `DailyRate` write path appears without the guard
  (the preview-fixtures CLI is the one listed exemption).
- `IngestProfile.amountBasis` and its registration rules.

## Not built (invariant 10: do not present as capability)
- **Promotion.** Nothing writes `DailyRate` from observations; no process calls `checkRatePromotable` or `evaluateBatchGuard`. It still needs the narrow promotion role with read access to observations
  and mappings and write access to the rate and availability tables, an idempotent audited writer, a place for held batches and their review, and an Admin view.
- **Availability single-writer.** Only *price* edits are refused on a feed-managed plan. Manual allotment, stop-sell and restriction edits are not yet restricted, because an emergency stop-sell must stay
  possible and the rule for reconciling a manual close with the next feed statement is decision 3 (room-wide allotments, pools, restrictions), not yet made.
- **Nights a later feed omits (decision 4)** beyond the 20% hold: not decided.
- A plan whose price a person needs to change must have its mapping reopened first; there is no per-night override.
- Existing hand-edited rows on a plan that later becomes feed-managed are overwritten by promotion; whether to require an empty or reconciled calendar before approving the mapping is not decided.

## Consequences
- Approving a rate plan mapping now has a commercial effect (it locks hand pricing of that plan). Reviewers of mappings (ADR 0004, 0081) should be told. The mapping response and Admin copy do not say so yet.
- A contract stays the commercial container: it must still be ACTIVE (maker-checker, ADR 0067) for its plans to sell, and NET rates still need an active markup rule.

## Rollback
Remove the two guard calls, `feed-managed.ts`, `promotion-rules.ts` and the profile basis check. No schema or data change.

## Verification
`promotion-rules.spec.ts` (rule order, every block, 30% and 20% boundaries, empty and first batches), `feed-managed.spec.ts` (source scan), `ingest-profile` cases in `supplier-ingest.worker.spec.ts`,
and `test/supplier-rate-plan-mapping.e2e-spec.ts` RPM-02b (only an approved mapping manages a plan; reopening and other tenants do not). Calendar and Quick Update unit and e2e suites still pass.
