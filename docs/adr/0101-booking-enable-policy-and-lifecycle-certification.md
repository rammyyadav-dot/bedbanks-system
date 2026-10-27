# ADR 0101: Booking-enable policy and lifecycle certification

Status: proposed (needs owner acceptance; ADR 0055 #6 reserves the decision to enable booking to the owner)

## Context

`BOOKING_ENABLED` gates the Agent booking routes. The policy was spread over ADR 0006, ADR 0055 #6, `render.yaml`, Terraform defaults and CI checks, and was never written in one place. This ADR collects what the code does today, states the intended policy, and records what the lifecycle suite `apps/api/test/booking-lifecycle-chain.e2e-spec.ts` certifies and what it found.

## What the code enforces today

- `bookingEnabled()` is true only for the exact string `true` (`agent/booking-transaction.service.ts`). Unset, `false`, `TRUE`, `1` and empty all mean off (covered by `agent-transaction-gates.e2e-spec.ts` HOLD-01..05).
- It is process-wide. There is no per-tenant or per-agency switch.
- Off: `offers/:id/hold`, `prebook`, `bookings` (create, list, detail), cancellation quote, `DELETE bookings/:id`, and booking documents answer `503 booking_unavailable`; hold, prebook, create and cancel also write an audited `booking.*.unavailable` event.
- Not gated, by design: `rates/recheck` (allocates nothing, search permission), `DELETE holds/:id` (releases only), `bookings/reconcile-stale`, and the Admin booking module, which has its own switches (`ADMIN_MANUAL_BOOKING_ENABLED`, `ADMIN_SUPPLIER_JOBS_ENABLED`, `ADMIN_BOOKING_OPS_ENABLED`, `BOOKING_JOB_RUNNER_ENABLED`).
- Deployment guards: Terraform default `BOOKING_ENABLED = "false"`; `tools/aws-governance-check.mjs` fails CI if the default changes; `tools/aws-golive-preflight.mjs` refuses `"true"`; `render.yaml` leaves it unset; the strict API runtime role has no grants on booking tables (`runtime-role-contract.ts`).

## Policy

1. **Default off, everywhere, until the owner accepts this ADR for a named environment.** Enabling is an owner decision recorded per environment (ADR 0055 #6), not a code change. No pull request flips a default.
2. **Gates before the flag may be `true` outside a disposable database.** All must hold and be evidenced:
   1. A live, authoritative supplier recheck is configured. the supplier adapter is not the `unconfigured` one (`supplier.name !== 'unconfigured'`); a recheck failure returns `provider_unavailable`, never a stale or zero price (invariant 5).
   2. The API runtime role has a reviewed privilege design for the booking, hold, ledger and document tables (ADR 0039 question 1). Today it has none, so a strict-role deployment cannot book.
   3. The hold-expiry sweeper and `reconcile-stale` run on a schedule, so abandoned holds and prebooks cannot pin inventory or credit.
   4. `pnpm check:architecture`, `pnpm type-check`, `pnpm lint`, `pnpm test` and the lifecycle suite pass on the release commit against disposable PostgreSQL.
   5. The known gaps below are fixed or explicitly accepted by the owner for the environment.
3. **Turning off sales must not strand customers.** `BOOKING_SERVICING_ENABLED=true` serves existing bookings (list, detail, documents, cancellation quote, cancel) while `BOOKING_ENABLED` is off. Servicing is also on whenever `BOOKING_ENABLED=true`. The servicing switch never opens hold, prebook or create. It is off by default and, like the main flag, is an owner decision per environment.
4. **Scope is per environment, not per tenant.** A per-tenant gate is a larger design (RLS, settings, audit) and is not proposed.

## Lifecycle certification

`booking-lifecycle-chain.e2e-spec.ts` runs the real services on PostgreSQL:

| Step | Certified |
| --- | --- |
| Recheck | Allocates nothing; price change, unavailable and expired offers create no hold and no booking (LIFE-01, 02) |
| Hold | Replay returns the same hold; one allocation (LIFE-01); ten agents for the last room give one winner and no negative availability (LIFE-04); a reused key with a different request is refused (LIFE-03) |
| Prebook | Replay returns the same booking, one reservation on the ledger (LIFE-01) |
| Confirm | Held becomes sold once; reservation becomes one debit; 25 concurrent confirms converge (LIFE-01, 05) |
| Documents | Voucher and invoice issued once, immutable, same number on replay; none before confirmation; credit note only after cancellation (LIFE-01) |
| Cancel | Inventory returned once, one refund; 25 concurrent cancels converge on one cancellation; confirm racing cancel never strands a sold room or an unrefunded charge (LIFE-01, 05, 06) |
| Amendment | Stay or occupancy change on an inventory-backed booking is refused with nothing changed and the booking stays cancellable; a pre-existing open request cannot be approved but can be rejected (LIFE-07, 08) |

## Findings (not fixed here)

1. **Stay amendments cannot move inventory (now refused, fail closed).** Approving a date change on a contracted-inventory booking used to rewrite `Booking.checkIn/checkOut/nights` while leaving the inventory nights and `searchSnapshot` (read by the voucher, invoice and cancellation penalty) on the old stay. A stay or occupancy amendment on a booking that has an inventory hold is now refused with `AMENDMENT_INVENTORY_BACKED` at request and at approval (LIFE-07, LIFE-08); guests cancel and rebook. Re-allocating inventory on amendment remains unbuilt. Admin bookings without an inventory hold are unaffected.
2. **Supplier confirmation for non-contracted suppliers is not in the Agent flow.** Agent confirmation is contracted-inventory only (ADR 0006). The Admin supplier queue (ADR 0039 Phase 3) is covered by `booking-supplier.e2e-spec.ts`, behind its own switches and a mock adapter. The chain Agent recheck, hold, prebook, supplier confirmation is not exercised end to end because no live connector exists.

## Rollback

Set `BOOKING_ENABLED` to `false` (or unset it) and restart the API; set `BOOKING_SERVICING_ENABLED=true` to keep existing bookings reachable. No data migration is involved. Existing bookings, holds and ledger entries stay as they are; see policy 3 for what agents can no longer reach.
