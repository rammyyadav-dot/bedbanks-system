# ADR 0066: Bedbank checkout, confirmation email outbox, voucher and invoice

Status: Accepted. Partly implemented; the "Not built" section is the honest boundary of what this change delivers.

## Context
The agent checkout held a rate, took the lead guest's first and last name and confirmed. Global bedbanks (TBO, WebBeds, Hotelbeds) collect every guest's name per room, the agency's own file reference, non-binding special requests and an explicit acceptance of the cancellation terms, then land on a confirmation page with the voucher and invoice and send a confirmation email. The platform had no email capability at all.

Constraints: idempotency on booking mutations (6); never log guest PII (7); audit for privileged and financial mutations (8); no placeholder presented as a capability (10); a reviewed migration with rollback notes and forced RLS for any new table; agent booking itself stays gated by `BOOKING_ENABLED` and runs on a privileged path the strict API role does not hold.

## Decision
**Checkout details.** `POST /agent/prebook` accepts, in addition to occupancy:
- `guests`: every guest, per room (`roomNumber` 1..rooms), with title, first and last name; children carry their age, which must equal the searched child ages. The lead guest is the first adult of room 1. Stored as `BookingGuest` rows (new nullable `room_number`).
- `agentRef` (existing `Booking.agent_ref`, ≤ 60 chars) and `specialRequests` (new `Booking.special_requests` JSONB: request codes from a fixed list plus a ≤ 300-character note), both non-commercial: they are not in the commercial snapshot, so they never change price or idempotency equality.
- `termsAccepted: true` is required; acceptance is recorded as an audit event with no guest data.

**Confirmation email: a transactional outbox sent through AWS SES.**
- `BookingEmail` (one row per booking and kind, unique) is inserted in the same transaction that confirms the booking: a confirmed booking always has its email queued; a rolled-back confirmation queues nothing; a retried confirmation cannot queue twice.
- Recipients: the booking agent's account email (from the authenticated session) and up to three CC addresses typed at checkout. No guest email is collected. The row holds addresses only, never the message body.
- `BookingEmailDispatcher` runs only with `EMAIL_DISPATCH_ENABLED=true`, on the booking module's own database role (`BOOKING_OPS_DATABASE_URL`, ADR 0039). It visits tenants through `fbeds_booking_email_due_tenants` (SECURITY DEFINER, tenant ids only), claims rows with `FOR UPDATE SKIP LOCKED`, renders the message from the issued, immutable voucher and invoice (`BookingDocument`), and sends a MIME message with both documents attached through the `EmailSender` port. Retries wait 1, 5, 15 and 60 minutes; a permanent rejection or the fifth failure is `FAILED` with an error code. Failures are logged by code only, never with an address or guest name.
- The SES adapter uses `@aws-sdk/client-sesv2` (`SendEmail`, raw MIME) with the task role's credentials; configuration is `EMAIL_FROM` and `EMAIL_SES_REGION`. With the dispatcher off, rows stay `QUEUED` and the confirmation page says the email is queued, not sent.
- The booking role gains SELECT on `BookingEmail`, UPDATE on its progress columns only (never recipients or keys), and EXECUTE on the due-tenants function. The API runtime role holds nothing on it (privileged path, like `Booking`).

**Documents.** The voucher lists every guest by room, the agent reference, the hotel's address and check-in/check-out times, special requests marked "not guaranteed" and the frozen cancellation terms; it carries no price. The invoice adds the agent reference. Both are issued eagerly right after confirmation so the email and the confirmation page can link them. They remain issue-once and immutable.

**Agent UI.** Checkout is a guided flow on the hotel page: review (hotel, room, board, dates, guests, cancellation deadline, rechecked total, hold timer) → guest names per room → agent reference, special requests and CC emails → terms → confirm. The confirmation page shows the booking and hotel confirmation references, status, guests, voucher and invoice, and the email's true state (queued / not enabled).

## Not built (do not present as capability, invariant 10)
- Guest emails, SMS and WhatsApp notifications.
- PDF rendering: documents are print-ready HTML (attached as `.html`); a PDF renderer is a separate decision.
- Resend / change-recipient actions and an email status column in My bookings (the runtime role cannot read `BookingEmail`; a narrow column grant is a follow-up).
- Client-facing documents with the agent's markup (ADR 0065 keeps markup display-only).
- SES domain verification, DKIM and sending limits are an operations task in AWS; until done, keep `EMAIL_DISPATCH_ENABLED` off.

## Amendment 1 (2026-10-16): industry-standard checkout items

Checked against what Hotelbeds, WebBeds and TBO show at checkout, three items were missing.

- **Estimated arrival time.** Optional, 24-hour `HH:MM` in hotel local time, stored with the special requests (`Booking.special_requests.arrivalTime`, no migration: the column is already a JSON object). The voucher and the email print it as not guaranteed. Admin booking detail now shows the stored requests and arrival time instead of "not stored yet"; the free-text note stays masked without `booking.pii.view`.
- **Duplicate booking warning.** Before a portal prebook, `BookingTransactionService.findDuplicates` looks for an active booking (pending, on request, confirmed, amend or cancel requested) of the same agency, hotel, check-in, check-out and lead guest (case-insensitive), excluding a retry of the same prebook. If one exists, `POST agent/prebook` answers 409 `DUPLICATE_BOOKING_SUSPECTED` with up to three `{ reference, status, createdAt }` in `error.details` (never guest data), before anything is held or charged. The agent books anyway with `acknowledgeDuplicate: true`, which is audited as `booking.duplicate.acknowledged` with the existing references. It is a warning, not a database constraint: only the agent-portal endpoint asks, so admin, manual and future API channels are unaffected, and two concurrent prebooks can both pass.
- **Summary context.** The booking summary adds guest nationality (the rate depends on it), the included promotion, the average per night and how the booking is paid (agency credit). It does not show a tax and fee breakdown: contracted inventory records tax and fees as 0, meaning not modelled, and showing "Taxes AED 0.00" would be false.

Not built in this amendment: lead-guest phone and email (more guest PII to store, mask and retain; a separate decision), supplier rate comments / essential hotel information (no source data in contracted inventory yet), and region-specific identity fields (for example PAN or passport numbers).
