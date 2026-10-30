# ADR 0105: Booking exception resolution overrides

Status: **Proposed.** Nothing in this ADR is implemented. It exists so an owner can accept, change or reject the design before any code or migration is written.

## Context
Operations can see booking anomalies (`bookingAttention`, the Operations queue) and act on the ordinary lifecycle (confirm via supplier answer, cancel, reconcile, amend). There is no way for a supervisor to resolve a case the normal path cannot, such as a supplier that confirmed by phone, a hotel overbooking that needs a different property, or a goodwill refund. Doing those by editing rows would break invariants 6 and 8 and the single status writer (`transitionBooking`).

## Proposal
Three supervised actions, each a named `transitionBooking`/ledger action, never a free status edit:

1. **Manual confirm**: records that the hotel confirmed outside the system. Requires the hotel confirmation number, evidence note and reason code. Moves `PENDING_SUPPLIER`/`ON_REQUEST` to `CONFIRMED` through the existing confirm path (same debit, hold-to-`CONFIRMED`, voucher issue), flagged `manual=true` in the `BookingEvent`.
2. **Reject and re-route**: moves the booking to `REJECTED`/`FAILED` with the existing compensation (wallet release, inventory release) and records the replacement booking reference when one is made. It does not rebook automatically.
3. **Administrative refund**: a ledger adjustment through the existing single-writer ledger adjustment service (ADR 0100), never a direct ledger insert. Bounded by what the booking was charged.

Controls shared by all three:
- New permissions, one per action, not granted to any existing role by default.
- Maker-checker using the existing approvals service (ADR 0095) for refunds and manual confirm; a supervisor cannot approve their own request.
- Mandatory `reasonCode` from a fixed list (`SUPPLIER_CONFIRMED_OFFLINE`, `HOTEL_OVERBOOKED`, `GUEST_NAME_CORRECTION`, `PAYMENT_TIMEOUT_RESOLVED`, `GOODWILL`, `OTHER` requiring a note) and the acting user id, both written to the immutable `BookingEvent` and an `AuditEvent`.
- Idempotency key per request (invariant 6); money in integer minor units with ISO currency (invariant 3).
- No guest PII or supplier payload in the reason note (invariant 7); the note is length-limited and masked without `booking.pii.view`.

## Consequences
- Needs a reviewed migration (reason code and override columns or a `BookingOverride` table with forced RLS and tenant indexes), rollback notes, and contract envelopes in `@bedbanks/contracts` before any admin UI.
- Force-confirm can create a confirmed booking the supplier does not know about. Hence the evidence requirement, the checker, and the `manual` flag surfaced on the voucher decision for Operations.

## Open questions for the owner
Which roles hold each permission; whether manual confirm needs a checker or only a reason; the final reason-code list; refund ceilings.

## Alternatives rejected
A generic "set status" endpoint (bypasses invariants 6 and 8 and the finance consequences of each status).
