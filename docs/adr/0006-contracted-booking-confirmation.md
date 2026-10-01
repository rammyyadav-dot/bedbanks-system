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
