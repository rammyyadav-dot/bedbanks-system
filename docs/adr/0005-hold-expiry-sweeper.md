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

## Restricted role (added)
Existing policies reject every SYSTEM `AuditEvent` insert for roles that respect
RLS. Migration `202609280001_hold_expiry_system_audit_policy` adds one narrow
policy for members of the group role `fbeds_hold_expiry` (tenant in context,
SYSTEM actor, no user, action `inventory.hold.expired`, entity `inventory_hold`)
and excludes those members from the general tenant insert policy, so the role
cannot write USER-type or other audit events. The role and its grants are created
by an owner-run script (`ops:provision-hold-expiry-role`), not by a migration, so
no role or secret enters migration history. See `docs/runbooks/hold-expiry-role.md`.

## Owner actions before enabling
Follow `docs/runbooks/hold-expiry-role.md`: deploy the migration, provision the
role, store `HOLD_EXPIRY_DATABASE_URL` as a secret reference, verify, then enable.

## Rollback
Set `HOLD_EXPIRY_SWEEP_ENABLED=false` and restart. No schema change is involved.

## Addendum: PROCESSING claim (2026-10-02)

A booking attempt now claims its hold before any wallet reservation or supplier call:
`InventoryHoldService.beginProcessing` performs one conditional `UPDATE … SET status='PROCESSING'
WHERE status='HELD' AND expires_at > now()`. The sweeper only expires `HELD` rows, so a claimed hold can no
longer be released mid-checkout, and an already-expired hold can never be claimed. Compensation
(`release`) accepts `HELD` or `PROCESSING`; expiry still accepts only `HELD`.

Order in `SupplierPrebookOrchestrationService`: persist PENDING booking → claim hold → authorize wallet
(inventory-only release if this fails) → supplier prebook (full compensation if this fails).

Known remaining gap: a process crash after the claim leaves a `PROCESSING` hold and, possibly, a wallet HOLD
ledger entry. A reconciliation sweep for stale `PROCESSING` holds is required before booking is enabled.
Migration `202610020001_inventory_hold_processing_state` is additive; PostgreSQL cannot drop enum values, so
rollback means resolving all `PROCESSING` holds and leaving the unused value in place.
