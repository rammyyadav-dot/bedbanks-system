# ADR 0083: Feed stock promotion: room-wide stock, count meaning, manual closes and omitted nights

Status: Accepted (owner decisions 3a, 3b, 3c and 4 of 2026-10-21). The rules and profile declarations are built; promotion itself is not.
Date: 2026-10-21

## Context
ADR 0082 settled who owns a feed-managed plan's prices and what a feed price means. Stock needed four more answers before a writer can exist: where a room-wide statement goes, what a feed's number
means against our own sold and held units, what a feed may do to a night a person closed, and what an absent night means. The relevant existing rules are ADR 0030 (a pooled plan's own counters are
ignored; a missing night is unknown, never zero; a supplier night without an expiry is stale), ADR 0036/0037 (pool capacity, `sold + held <= capacity`, capacity edits never revive stale nights).
Each decision below was put to the owner with options; the recommended option was chosen each time.

## Decisions (owner)
**3a. Room-wide stock goes to the pool, else it is blocked.** A statement with no rate plan code is shared physical stock, so it sets the capacity of the one inventory pool that all the room's
feed-managed plans belong to. If any such plan is outside a pool, the plans sit in different pools, a pool is not ACTIVE, or there are no plans, the statement is blocked (`NEEDS_POOL`) and the
offending plans are listed for a person. It is never copied to each plan, so stock cannot be sold twice.

**3b. The count's meaning is declared per profile and required.** An ingest profile must declare `allotmentSemantics`:
- `REMAINING`: units still sellable on the supplier's side. The counter written is `sold + held + count`, so we can never sell more than the supplier has.
- `TOTAL`: the counter written is `count`; a count below `sold + held` is refused (`COUNT_BELOW_COMMITTED`), never clamped, and nothing sold or held is deleted around it.
Undeclared means stock from that source is never promoted (`COUNT_SEMANTICS_UNDECLARED`). Counts are integers 0..9999 and the same rule applies to a plan night or a pool night.

**3c. A person's close is sticky.** The feed may close more nights, but never reopens a night whose current row was last written by a person (source `ADMIN`) and is stop-sold or mode `CLOSED`, until
a person reopens it. The night is skipped, not the batch. It uses the provenance the row already carries; no schema change. A close the feed made itself, or one from another source, is not protected.
Emergency stop-sells therefore stay possible and are not undone within one feed cycle.

**4. Omitted nights are closed inside the declared window.** An ingest profile declares `coverageDays` (1..730), how far ahead a complete feed reaches. After a batch passes the ADR 0082 guard,
previously promoted nights inside `[today, today + coverageDays]` that the complete feed no longer mentions are closed (mode `CLOSED`, source supplier feed). Nights beyond the window, in the past, already
closed, or any night when `coverageDays` is undeclared are never closed on a guess. Independently, every promoted availability row must carry `fresh_until` (ADR 0030 #7), so a feed that stops arriving
fails closed by expiry whatever else happens. A held, partial or failed batch closes nothing.

## What is built
- `mapping/stock-promotion-rules.ts` (pure, no I/O, no clock): `planStockCount` (3b), `routeRoomWideStock` (3a), `mayFeedWriteNight` (3c), `omittedNightsToClose` (4).
- `IngestProfile.allotmentSemantics` and `coverageDays`, validated at registration; both optional, neither defaulted.
- Tests cover every block reason, the exact boundaries (window ends, cap of 9999, `count == sold + held`), and the negative cases (unpooled, split pools, inactive pool, feed-made closes, undeclared coverage).

## Not built (invariant 10: do not present as capability)
- **Promotion.** No process calls these rules and nothing writes `DailyAvailability`, `InventoryPoolDay` or `DailyRate` from observations. The writer still needs the narrow promotion role, an idempotent
  audited transaction (advisory lock per hotel, like Quick Update and the capacity editor), a place for held and blocked items with a review view, and the Admin copy that tells mapping reviewers that approval
  hands the plan to a feed.
- **Pool capacity writes are a hard dependency.** The pool capacity editor refuses to create nights (ADR 0037); promotion creates nights, which is exactly the "independently controlled authoring workflow" that
  ADR names, so it must set provenance (supplier feed) and `fresh_until` itself and must respect `sold + held <= capacity` with the same guarded UPDATE.
- Manual allotment-count edits on a feed-managed plan are still not refused (only prices are, ADR 0082); a person editing a count would be overwritten by the next feed.
- Per-plan restrictions the feed sends (minimum stay, closed to arrival or departure) are carried in observations but their promotion rules are not decided here.
- The first batch after approval compares against whatever rows exist, hand-edited ones included, through the same 30% and 20% guard; no separate rule for that is decided.

## Consequences
- A source without `allotmentSemantics` can still be ingested and resolved, and its prices can be promoted, but its stock cannot. Onboarding a source requires someone to establish what its number means.
- A manual close outlives feed cycles until a person reopens it; operators must reopen deliberately, and the Admin calendar should say when a night is held closed by a person.
- Closing omitted nights shortens the window in which a stale night can sell from the freshness window to one feed cycle, for sources that declare coverage.

## Rollback
Remove `stock-promotion-rules.ts` and the two optional profile fields. No schema, data or grant change.

## Verification
`mapping/stock-promotion-rules.spec.ts` (12 tests) and the profile cases in `supplier-ingest/supplier-ingest.worker.spec.ts`. The full API unit suite and `pnpm check:architecture` pass.
