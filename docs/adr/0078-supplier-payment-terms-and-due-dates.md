# ADR 0078: Supplier payment terms and due dates

Status: **Built.** Writes share the `SUPPLIER_SETTLEMENT_ENABLED` switch (ADR 0077); reads always work. Follows ADR 0076 (posted payables) and ADR 0077 (settlements).

## Why (the bedbank workflow)
A bedbank does not pay a supplier when it books. It pays on **contracted terms measured from the stay**: typically a number of days after the guest's check-out (net 30 is common), sometimes from check-in, and for prepaid or non-refundable rates from the confirmation. Finance runs payables by **due date**, pays the earliest-due items first, and reports what is *overdue*. ADR 0076 aged payables from the first accrual and said so honestly because no terms existed; this ADR adds the terms.

## Decision
1. **`SupplierPaymentTerms`** (migration `202612040001`): per supplier, a basis (`CHECK_OUT`, `CHECK_IN`, `CONFIRMATION`) and whole days 0 to 365. **Append-only** (trigger): the latest row is current and every earlier row stays as history, so a change of terms is a recorded event, never an edit. Setting the terms already in force records nothing. Each change is audited with the previous terms.
2. **Permission `finance.terms.manage`**, a formal role assignment only (granted to no role), separate from proposing and approving settlements.
3. **Due date of a payable** = the booking's check-out, check-in or confirmation (first accrual) date + the supplier's *current* terms, per booking. A supplier with no terms, or a booking with no date for the basis, has **no due date and is never shown as overdue** (bucket "No due date").
4. **Due and overdue view** (`GET /admin/finance/booking-postings/payables/due`): per supplier and currency, buckets Not yet due / 1–30 / 31–60 / 61–90 / over 90 days overdue / No due date, plus an overdue total. Approved settlements (ADR 0077) are applied to the **earliest-due bookings first**, in SQL. Days are whole UTC calendar days.
5. **Terms API** (`GET`/`POST /admin/finance/supplier-terms`): lists every supplier that is owed money or has terms, with what is outstanding per currency, so a supplier owed money with no terms stands out.
6. **Role.** The consumer's narrow role gains SELECT and INSERT on the table and column-level SELECT of `Booking.check_in` and `check_out` only. Re-run `ops:provision-finance-posting-role` and `ops:verify-finance-posting-role` after migrating.
7. **Admin.** Finance → Supplier settlements gains a Payment terms table with set/change; Finance → Payables gains the Due and overdue section. The older "age since first accrual" section stays: it answers a different question and needs no terms.

## Defaults taken (change here and in the SQL)
- Terms apply to the whole supplier, not per contract, rate plan or market.
- The current terms are applied to every open booking (a change of terms re-dates open payables). The history is kept, but each booking's due date is not frozen at confirmation.
- A booking's dates are its current check-in and check-out, so an amendment of dates moves its due date.
- No grace period, no business-day calendar, no weekend or bank-holiday roll.
- Terms live in the system as an agreed fact; this ADR does not read them from the supplier contract.

## Not built
- Per-contract or per-rate-plan terms; terms frozen per booking at confirmation; a payment run proposal ("pay everything due this week"); supplier invoices and invoice-level matching (ADR 0054/0070 territory); early-payment discounts; supplier statement due dates; notification of overdue payables.

## Verification
Terms validation unit tests (4 groups). PostgreSQL e2e (in `booking-finance-posting`, now 27): no terms means nothing overdue; terms refused without the switch, invalid, or for an unknown supplier; set, idempotent, history kept; each basis puts bookings in the right bucket; an approved payment clears the earliest-due booking first; longer terms move due dates; the confirmation basis needs no stay dates; the audit trail records previous terms; history cannot be edited or deleted even by the owner; tenant isolation; unavailable role. Role certification covers the new grants and probes.
Not run: CI, a browser, a production-shaped database.
