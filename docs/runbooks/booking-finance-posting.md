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
- `BookingFinancePosting.status`: `POSTED` (ledger and payable written), `SKIPPED` (moves no money; `reason` says why), `REVIEW_REQUIRED` (nothing written; `reason` says what to fix).
- Audit events `booking.finance.posted` and `booking.finance.review_required` (SYSTEM actor) carry the legs and amounts, never guest data.
- Reasons you will see in review and what to do: `NO_WALLET` open the agency's account; `NO_AGENCY` the booking has no agency, set it through the booking record (Finance decision); `PAYMENT_MODE_UNKNOWN` / `NET_UNKNOWN` complete the booking's payment mode or net; `NO_SUPPLIER` the booking has no supplier organization; `REFUND_WOULD_DECREASE` a decision would refund less than was already refunded (a person decides, nothing is taken back automatically); `HOLD_AMOUNT_DIFFERS` an on-request hold was taken for another amount than the confirmation; `AMENDMENT_NEEDS_LEDGER_ADJUSTMENT` an amendment changed the total of a booking already charged (adjustments are not booked automatically; Finance decides); `REFUND_EXCEEDS_CHARGE`, `EVENT_INCONSISTENT` stop and investigate: do not force. The ledger integrity report will also show any difference between a booking's total and its charge.
- A review is retried every five minutes once its cause is fixed. Later events of the same booking wait behind it, by design.

## Roll back
Set the flags to anything but `true` (non-destructive; events simply accumulate). Ledger entries already appended are immutable and are never deleted: correct a wrong posting with a reviewed compensating entry. To remove the role: `deprovisionFinpostRole` (see `database/finance-posting-role.ts`). To drop the tables, follow the migration header, only while the worker is stopped.
