# ADR 0072: Booking amendments

Status: **Built** (branch `claude/booking-amendments`). Extends ADR 0039 (Admin booking module, spec workflow E). Resolves audit finding F4
(`docs/booking-module-audit-2026-10-18.md`): an approved amendment used to change the status and nothing else.

## Context
Before this change `requestAmendment` carried only a free-text reason, and `approveAmendment` moved the booking back to Confirmed with a new version
while changing no date, room, guest or price. The spec says: names and special requests go to the supplier directly; dates, room or occupancy are a
re-price, shown with the difference; approval updates the booking, bumps the version and invoices or credits the difference; rejection leaves the
booking as it was.

## Decisions

**1. Two kinds of request.** A *structured* amendment changes the **stay dates** and/or the **occupancy of its rooms** (adults, children, child ages).
It is dates and head counts only: no guest personal data is stored in it, audited or logged. Everything else (guest names, special requests) stays a
*free-text* request: the note goes to the supplier directly, approval only records it, and nothing is applied (exactly as before). Names are not
structured because a proposal would put personal data in a second store.

**2. The price is recorded by a person, the arithmetic is the system's.** There is no live supplier or rate engine behind the Admin, so the approver
records the price the supplier confirmed (new sell, optional new net, optional new free-cancellation deadline). The system computes the signed
difference (integer minor units, `BigInt`, no floating point), validates everything again, and applies it. Re-pricing from the rate plan is **not**
built: it needs the supplier or the contract engine and a quote the approver could compare against.

**3. One transaction.** `act` prepares the amendment, calls `transitionBooking` (the only status writer), then applies the decision, all in the same
write transaction under a row lock on the booking: the stay, nights, the occupancy, the sell, net and markup, the deadline, the amendment row, the
`BookingEvent` (with the amendment id and the difference) and the audit event commit together or not at all. Approval bumps the version once.
Two approvals at once: one applies, the other is told the booking changed (409). A replayed idempotency key neither prepares nor inserts anything a
second time; the fingerprint now covers the structured body, so the same key with a different body is `IDEMPOTENCY_CONFLICT` (existing fingerprints are
byte-for-byte unchanged).

**4. What the approval does to each fact.**
- Net and markup: a given net recomputes the markup (`sell - net`); no net makes both **unknown (null)**, never carried over stale. An approver without
  `booking.view.net` cannot see the net, so for them it becomes unknown; the dialog says so.
- Free-cancellation deadline: the recorded one wins; if the dates changed and none was recorded it becomes **unknown (null)**; if the dates did not
  change it is kept. The frozen cancellation rules are relative to check-in and keep working on the new dates.
- Per-room prices become unknown (they would no longer add up to the new total).
- Guests: named guests are not changed. If occupancy rose, the extra person has no name yet; names are updated through the supplier, outside this module.
- Documents already issued (voucher, invoice) are issue-once and immutable: they are **not reissued**. The amendment row lists which ones were left
  untouched and the screen says so. Revised documents are not built.
- Money: an `AMENDED` event is written to the append-only money outbox with the new sell, the new net and the signed `adjustment_minor`, "awaiting
  Finance booking". A zero difference is not a money fact and writes none. **Nothing is posted to the ledger, a wallet or a balance.**

**5. Ledger guard (fail closed).** ADR 0069's cancellation settlement credits an agency from the booking total and caps the refund by what was charged.
If an amendment changed the total of a booking that is held or charged on the agency ledger without a matching ledger adjustment, a later cancellation
would refund the wrong amount, and the ledger integrity checks compare against the booking total. The ledger adjustment (debit an increase, credit a
decrease, with credit-limit rules) is a finance decision that is not built. So: **a price-changing approval is refused (409
`AMENDMENT_LEDGER_ADJUSTMENT_REQUIRED`) on any booking the ledger holds an entry for**, and nothing changes; a same-price amendment is allowed; the
approver can reject instead. If the ledger cannot be asked, a price change is refused too (`AMENDMENT_LEDGER_UNVERIFIABLE`). Bookings the ledger never
saw (manual and non-ledger bookings, the normal Admin case while `BOOKING_ENABLED=false`) are fully supported.
The question is answered by `fbeds_booking_has_ledger_entries(booking_id)` (migration `202611250003`): SECURITY DEFINER, one boolean, scoped to the
current tenant by `fbeds_current_tenant_id()`, no tenant argument, no amount or wallet returned, EXECUTE granted to the booking role only. The booking
role still cannot read the ledger. (A first version asked on the API connection and failed closed always: under the strict runtime role the ledger is
unreadable by design. The end-to-end test found it.)

**6. The booking role's grants widen, deliberately and narrowly.** Previously the role could not write a price. Now (owner-run provisioning, re-run
`ops:provision-booking-ops-role`): `UPDATE` on `Booking(check_in, check_out, nights, total_minor, net_minor, markup_minor, cancel_deadline)`,
`BookingRoom(adults, children, child_ages, sell_minor, net_minor)` and `BookingAmendment`'s decision columns; `INSERT`/`SELECT` on `BookingAmendment`.
Still denied: currency, payment, frozen cancellation terms, supplier, hotel, agency, reference, keys, the amendment's proposal and before-state, every
delete, the ledger, wallets and the money outbox's update. The guard is in code: `booking-amendment.spec.ts` (AM-12) scans the API source and fails if
any file other than `booking-ops/booking-amendment.ts` writes those columns on an existing booking; the existing status-writer scan still holds. The two
role tests that asserted "the role can never write `total_minor`" (`BO-E04`, `BF-E07`) now assert the new exact boundary instead. **Reviewers: this is the
one place this change widens a privilege.** A SECURITY DEFINER apply function would keep the column grants closed at the cost of re-implementing the
validation in SQL; that was weighed and not chosen.

**7. Permissions: unchanged.** `booking.amend` (operator request, approve, reject) and `booking.amend.request` (an agency user may request on their own
booking, never approve). The structured parts are only accepted with `requestAmendment` / `approveAmendment` (any other action refuses them).

**8. Data.** Migrations `202611250001` (enum value `AMENDED`, alone because PostgreSQL cannot use a new enum value in the transaction that adds it),
`202611250002` (`BookingAmendment`: forced RLS, tenant-leading indexes, one open amendment per booking by partial unique index, decision CHECKs;
`BookingFinanceEvent.adjustment_minor` required for `AMENDED` and forbidden otherwise), `202611250003` (the function). Rollback notes are in each file.

## Not built (each is explicit, none is pretended)
Ledger adjustment of a price change (finance decision, see 5); re-pricing from the rate plan or the supplier; supplier amend calls; revised vouchers and
invoices; structured guest-name changes; changing the room type or board; an amendment of a booking that is not Confirmed.
