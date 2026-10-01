# ADR 0006: Contracted-inventory booking confirmation

Status: accepted (feature off by default)

## Context
Search, recheck, hold, wallet reservation, prebook compensation and reconciliation existed, but `POST /agent/prebook`
and `POST /agent/bookings` were fail-closed stubs and nothing converted a reservation into a sale.

## Decision
- `BOOKING_ENABLED=true` is required for either endpoint to act. Unset or any other value keeps the previous
  behaviour (audited `booking_unavailable`, HTTP 503). Nothing is enabled in any deployed environment by this change.
- **Prebook** (`POST /agent/prebook`, `booking.prebook`): the client sends only `inventoryHoldId`, an idempotency key,
  occupancy and the lead guest. Offer, dates, rooms, price and currency come from the server-side hold, which must
  belong to the caller; the wallet is the tenant's wallet in the hold's currency. Flow: persist PENDING booking ->
  claim hold (HELD->PROCESSING) -> reserve wallet -> supplier prebook -> durable `booking.prebook.succeeded` marker;
  any failure compensates (ADR 0005).
- **Contracted-inventory prebook** does not re-price (that would count the caller's own hold against the last room).
  It proves the claim: unexpired stored offer + a PROCESSING hold for exactly that offer and search.
- **Confirm** (`POST /agent/bookings`, `booking.create`) is ONE database transaction: lock booking, hold and wallet;
  require the prebook marker, a PROCESSING hold and a matching HOLD ledger entry; move `held -> sold` on every night
  (guarded `held >= qty`); hold -> `CONFIRMED`; post `RELEASE(+X)` and `DEBIT(-X)` (net balance unchanged, history
  shows the reservation became a charge); booking -> `CONFIRMED`; audit `booking.confirmed`. All or nothing, and
  idempotent (confirming a confirmed booking returns it).
- New enum value `InventoryHoldStatus.CONFIRMED` (migration `202610030001`, additive; PostgreSQL cannot drop enum
  values, so rollback leaves it unused).

## Not covered / before enabling anywhere
- Cancellation and refund settlement remain unavailable.
- Voucher/invoice generation, supplier-side confirmation for non-contracted suppliers, and notification are absent.
- Prebooked-but-never-confirmed holds stay PROCESSING; they need a policy (maximum age) before launch.
- The Agent UI does not call these endpoints; booking pages still show the unavailable state.
- Enabling requires production certification gates (RLS runtime check, backups, load test) and human approval.

## Addendum: cancellation and refunds (2026-10-04)
`DELETE /agent/bookings/:id` (`booking.cancel`) and `GET /agent/bookings/:id/cancellation-quote`, both behind
`BOOKING_ENABLED=true` (otherwise audited 503). `BookingCancellationService.cancel` is one transaction over a
CONFIRMED contracted-inventory booking:

- Contract cancellation policy (`CancellationPolicyService`, property time zone) -> integer penalty and refund
  (`floor(total * pct / 100)` or a fixed minor amount, capped at the total; refund = total - penalty).
- Fails closed with 409 and no change when the policy is missing, ambiguous or unevaluable, the stay has started,
  or the booking is not CONFIRMED or was never charged. Refusals are audited (`booking.cancel.refused`).
- Success: sold inventory returned (guarded `sold >= qty`), hold -> `RELEASED`, `REFUND(+refund)` posted to the
  wallet that was debited (no entry when the refund is 0, i.e. the penalty retains the debit), `Cancellation` row,
  booking -> `CANCELLED`, audit `booking.cancelled` (penalty, refund, ids; no guest data).
- Idempotent and race-safe: booking row lock plus a unique index on `Cancellation(booking_id)` (migration
  `202610040001`). Repeats return the original result.

Not covered: refunds to an external payment method (the wallet is the only settlement), supplier-side cancellation
for non-contracted suppliers, partial cancellation, no-show handling, and the Agent UI.
