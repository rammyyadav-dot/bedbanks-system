# Booking concurrency foundation

Baseline: `d2cb4062dd1ce545434b056af927acd07b8ce806` after PR #83 and successful post-merge CI run 36170612740.

This foundation is deliberately non-bookable. Public recheck, prebook and booking routes remain unavailable while the supplier adapter is unconfigured.

| Concern | Current implementation | Verified gap | Control in this change |
| --- | --- | --- | --- |
| Rate recheck | Public route returns unavailable | Live supplier authority is absent | Hold service is internal only; no display offer can create a hold |
| Idempotency | Booking and ledger have scoped keys | Inventory holds had no durable key or request fingerprint | Unique tenant/key plus SHA-256 commercial request fingerprint |
| Atomic allocation | Availability stored allotment and sold | No held quantity or concurrent conditional update | Ordered nightly conditional updates in one tenant transaction |
| Inventory hold | None | No durable non-bookable reservation | `InventoryHold` and nightly allocation records |
| Hold release/expiry | None | No safe restoration workflow | State-guarded, idempotent release and bounded expiry batches |
| Tenant isolation | RLS and `withTenant` exist | Hold tables did not exist | Forced RLS on both new tables and server-derived tenant context |
| Cache | No authoritative shared cache | No cache contract or key policy | Tenant/version-scoped port with safe no-op implementation |
| Redis/locks | None | No approved infrastructure or fencing ownership | Interface only; PostgreSQL remains authoritative |
| Supplier confirmation | Unconfigured adapter | No live supplier API | Deferred; no fabricated confirmation |

## Atomicity model

Each hold first claims its tenant-scoped idempotency key, then increments `DailyAvailability.held` for every service night in ascending date order with a conditional `UPDATE`. The predicate requires `sold + held + requested <= allotment` and no stop-sell. Any missing or insufficient night throws and rolls back the entire transaction, including the hold, night records and prior increments.

Release changes only an active `HELD` row. The winning transaction restores each recorded night exactly once; retries observe a terminal state and perform no inventory mutation. Database constraints prevent negative values or `sold + held` exceeding allotment.

Manual release records the authenticated user. Expiry records a system actor and therefore may only be invoked by the governed restricted background role; it is not registered as a scheduled process in this milestone.

## Cache classification

| Data | Policy |
| --- | --- |
| Hotel content, destinations, board catalogue | Cacheable with tenant/version keys and bounded TTL |
| Search availability and rate offers | At most short-lived hints; never booking authority |
| Permissions, inventory decisions, holds and bookings | Authoritative database reads for decisions |
| Credentials and raw supplier payloads | Never cached by this boundary |

## Redis decision

Status: `INTERFACE ONLY`.

Redis is deferred until multi-instance duplicate work, rate limiting or expiry-worker coordination is demonstrated and an owner approves infrastructure, secret references, fencing semantics and operations. Redis expiry must never restore inventory; durable PostgreSQL state does that.

## Release limits

- No live supplier connector or authoritative rate recheck.
- No public hold endpoint.
- No booking, payment, cancellation or confirmation activation.
- Migration certification is limited to disposable PostgreSQL until the database inventory and owner release checklist are approved.
