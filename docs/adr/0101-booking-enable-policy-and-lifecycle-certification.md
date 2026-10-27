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
3. **Turning it off must not strand customers.** Today the flag also closes booking list, detail, documents, cancellation quote and cancel. If it is switched off after bookings exist, agents cannot read their vouchers or cancel; they must go through the Admin module. Before first enablement the owner must choose one of: (a) accept this and document the fallback, or (b) split the flag into "create new bookings" and "serve existing bookings". Recommended: (b), as a separate reviewed change. It is not made here.
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
| Amendment | Open request blocks agent cancellation; a price change on a ledger-charged booking is refused and leaves the request open; a same-price change is applied once and bumps the version once (LIFE-07) |

## Findings (not fixed here)

1. **Stay amendments do not move inventory or the document snapshot.** Approving a date change on a contracted-inventory booking rewrites `Booking.checkIn/checkOut/nights` but leaves the inventory nights sold unchanged (an extended stay still holds the original nights, LIFE-08a) and leaves `searchSnapshot`, which the voucher, invoice and cancellation penalty read, on the old dates (LIFE-08b). The two `it.failing` tests state the required behaviour and will turn red when this is fixed, prompting removal of the marker. Interim safe option for the owner: refuse approval of stay or occupancy changes on bookings that have an inventory hold, until re-allocation is built.
2. **Supplier confirmation for non-contracted suppliers is not in the Agent flow.** Agent confirmation is contracted-inventory only (ADR 0006). The Admin supplier queue (ADR 0039 Phase 3) is covered by `booking-supplier.e2e-spec.ts`, behind its own switches and a mock adapter. The chain Agent recheck, hold, prebook, supplier confirmation is not exercised end to end because no live connector exists.
3. **The enable flag couples creation and servicing** (policy 3 above).

## Rollback

Set `BOOKING_ENABLED` to `false` (or unset it) and restart the API. No data migration is involved. Existing bookings, holds and ledger entries stay as they are; see policy 3 for what agents can no longer reach.
