# ADR 0005: Inventory hold expiry sweeper

## Context
`POST /agent/offers/:offerId/hold` creates an `InventoryHold` that increments
`DailyAvailability.held`, with an expiry of at most 15 minutes. `expireDue()`
releases due holds and restores inventory, but nothing scheduled it, so an
abandoned hold pinned inventory indefinitely. Expiry records a SYSTEM audit
event, which the ordinary HTTP database role cannot insert (see
`docs/booking-concurrency-foundation.md`).

## Decision
Add `HoldExpirySweeper`, an in-process interval job that calls the existing
`InventoryHoldService.expireDue()` for each active tenant, draining batches of
100 until a batch is not full.

- Disabled unless `HOLD_EXPIRY_SWEEP_ENABLED=true`.
- Requires `HOLD_EXPIRY_DATABASE_URL`, a credential for the governed restricted
  background role, and refuses to start if it equals `DATABASE_URL`. The HTTP
  role is never widened.
- Interval is an integer of at least 5000 ms (default 60000). Passes never
  overlap. A failing tenant is logged (error name only) and does not stop others.
- Release is already atomic, idempotent and tenant-scoped; concurrent sweepers
  are safe because release only acts on rows still `HELD`.

## Consequences
Until an owner provisions the restricted role and enables the job, expired holds
still leak inventory; this ADR removes the code gap, not the operational one.
Multiple API instances each run a sweeper; this is safe but redundant, and a
single scheduler can replace it later without changing `expireDue()`.

## Owner actions before enabling
1. Provision a non-owner, non-superuser role that can read active tenants, update
   hold and availability rows and insert SYSTEM audit events, with RLS behaviour
   certified.
2. Store its URL as a secret reference and set the two variables above.
3. Watch logs for `Hold expiry pass:` lines and failed tenants after enabling.

## Rollback
Set `HOLD_EXPIRY_SWEEP_ENABLED=false` and restart. No schema change is involved.
