# Runbook: booking finance posting (ADR 0076)

Posts the money facts of Admin-originated bookings to the agency account and to what is owed to suppliers. Off until you turn it on. It never opens an agency account, never changes a booking and never deletes or edits a ledger entry.

## Enable (order matters)
1. **Migrate** with the owner credential: `pnpm --filter @bedbanks/api prisma:migrate:deploy` (applies `202612010001_booking_finance_posting`). Never `prisma migrate dev`.
2. **Provision the role** (owner credential; idempotent; prints no secret):
   ```
   PROVISION_DATABASE_URL=<owner url> BOOKING_FINANCE_POSTING_LOGIN_PASSWORD=<32+ char URL-safe secret> \
   pnpm --filter @bedbanks/api ops:provision-finance-posting-role
   ```
3. **Store** `BOOKING_FINANCE_POSTING_DATABASE_URL` (that login and password, same host and database) in the secret manager. It must differ from `DATABASE_URL`.
4. **Certify** as the login itself: `BOOKING_FINANCE_POSTING_DATABASE_URL=<url> pnpm --filter @bedbanks/api ops:verify-finance-posting-role`. Continue only on `Result: OK`.
5. **Before the first run, check the agencies.** Every agency that makes Admin bookings needs an open account in the booking currency (it opens when its first funding receipt is posted, ADR 0028). Otherwise its events go to review (`NO_WALLET`) and wait.
6. **Dry look first:** with the flags still off, read what is waiting: `SELECT type, count(*) FROM "BookingFinanceEvent" e WHERE NOT EXISTS (SELECT 1 FROM "BookingFinancePosting" p WHERE p.event_id = e.id) GROUP BY 1` (as the owner, per tenant). Agree with Finance that these are the bookings to charge.
7. **Set** `BOOKING_FINANCE_POSTING_ENABLED=true`, then `BOOKING_FINANCE_POSTING_WORKER_ENABLED=true` (optional `BOOKING_FINANCE_POSTING_WORKER_INTERVAL_MS`, default 30000, minimum 5000). Restart the API. The API refuses to start with the worker enabled and no distinct role URL.

## Reading the result
Finance → Booking revenue shows sales, refunds, supplier cost and indicative margin per currency for a period, by agency and by supplier. It is dated by posting date and covers only the bookings this consumer posted.
Finance → Booking postings shows the counts, every event that needs a person (with what to do), what is waiting, and why events were skipped. It needs `finance.read`. The notes below are the same information from the database.
- `BookingFinancePosting.status`: `POSTED` (ledger and payable written), `SKIPPED` (moves no money; `reason` says why), `REVIEW_REQUIRED` (nothing written; `reason` says what to fix).
- Audit events `booking.finance.posted` and `booking.finance.review_required` (SYSTEM actor) carry the legs and amounts, never guest data.
- Reasons you will see in review and what to do: `NO_WALLET` open the agency's account; `NO_AGENCY` the booking has no agency, set it through the booking record (Finance decision); `PAYMENT_MODE_UNKNOWN` / `NET_UNKNOWN` complete the booking's payment mode or net; `NO_SUPPLIER` the booking has no supplier organization; `REFUND_WOULD_DECREASE` a decision would refund less than was already refunded (a person decides, nothing is taken back automatically); `HOLD_AMOUNT_DIFFERS` an on-request hold was taken for another amount than the confirmation; `AMENDMENT_NEEDS_LEDGER_ADJUSTMENT` an amendment changed the total of a booking already charged (adjustments are not booked automatically; Finance decides); `REFUND_EXCEEDS_CHARGE`, `EVENT_INCONSISTENT` stop and investigate: do not force. The ledger integrity report will also show any difference between a booking's total and its charge.
- A review is retried every five minutes once its cause is fixed. Later events of the same booking wait behind it, by design.

## Roll back
Set the flags to anything but `true` (non-destructive; events simply accumulate). Ledger entries already appended are immutable and are never deleted: correct a wrong posting with a reviewed compensating entry. To remove the role: `deprovisionFinpostRole` (see `database/finance-posting-role.ts`). To drop the tables, follow the migration header, only while the worker is stopped.

## Supplier settlements (ADR 0077)
Records payments made to suppliers outside the system against the posted payables. Moves no money. Off until `SUPPLIER_SETTLEMENT_ENABLED=true` (reads always work).
1. Migrate (`202612030002_supplier_settlements`), then **re-run** `ops:provision-finance-posting-role` and `ops:verify-finance-posting-role`: the role gains the settlement table.
2. Grant `finance.settle.propose` and `finance.settle.approve` in Roles & Permissions to different people (the proposer can never approve their own).
3. Set `SUPPLIER_SETTLEMENT_ENABLED=true`. Finance → Supplier settlements: choose a supplier and currency that still has an amount owed, enter the amount paid, the date, the bank reference, and propose. A different person approves or rejects (with a reason).
4. Paid and Outstanding appear on Finance → Payables; aging applies approved payments to the oldest bookings first.
A wrong *approved* settlement cannot be edited or deleted; raise it with engineering for a reviewed correction.

## Supplier payment terms and due dates (ADR 0078)
1. Migrate (`202612040002_supplier_payment_terms`) and **re-run** `ops:provision-finance-posting-role` and `ops:verify-finance-posting-role` (the role gains the terms table and the booking date columns).
2. Grant `finance.terms.manage` to whoever agrees terms with suppliers.
3. Finance → Supplier settlements → Payment terms: for each supplier set the number of days and what it counts from (check-out, check-in or confirmation). Suppliers with money owed and no terms are marked "No terms set": their payables have no due date and are never shown as overdue.
4. Finance → Payables → Due and overdue shows what is not yet due and what is overdue, by supplier and currency, with approved payments applied to the earliest-due bookings first.
Terms are history: change them and the old terms remain recorded; open payables are re-dated by the current terms.
