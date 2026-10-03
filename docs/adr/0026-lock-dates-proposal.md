# ADR 0026: Lock Dates and Apply & Lock (PROPOSED, not accepted, nothing built)

## Status
**Proposed.** Written for the owner to accept, change or reject. Quick Update (ADR 0021) deliberately has no lock because the meaning was never defined. Nothing here is built.

## Context
The mission asked for "Lock Dates" and "Apply & Lock" in Quick Update without saying what a lock does. Choosing a meaning is a business decision.

## Proposed decisions (defaults to confirm)
1. **Meaning:** a lock is a hotel-level freeze on **supplier-synced** changes for chosen stay dates. While a date is locked, a supplier connector or import may not overwrite the rate, allotment or restrictions of that hotel for that date. Manual changes by people with the normal permissions are still allowed and are audited as usual. A lock never stops search, hold or booking.
2. **Scope:** per hotel and per stay date range (up to 365 nights per lock), covering all rate plans of the hotel or a chosen subset. No overlapping locks for the same plan and date.
3. **Who:** creating a lock needs `supply.rates.manage`; removing one needs the same permission plus a reason. Locks have an optional expiry date.
4. **Apply & Lock:** Quick Update applies its changes and creates a lock for the same dates and plans in one transaction, with one idempotency key and one audit event.
5. **Data:** table `RateLock` (tenant-scoped, forced RLS): hotel, plan ids, date range, reason, created by, expires at, released at and by.
6. **Enforcement point:** the supplier-sync write path (when a live connector exists). **Today no connector writes rates, so a lock would have no effect on any existing flow.** Building it before a connector exists would be a placeholder, which the repository rules forbid presenting as a capability.

## Decisions needed from the owner
Confirm the meaning above (or define another), and whether this should wait until the first live connector writes rates.

## Consequences if accepted
One migration and a small service and UI. Recommendation: wait for the first live rate-writing connector, then build the lock where it is enforced.
