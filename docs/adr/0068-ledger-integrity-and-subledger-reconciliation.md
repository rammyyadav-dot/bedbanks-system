# ADR 0068: Ledger integrity check and sub-ledger reconciliation

Status: **Built (read-only check, two defect fixes, no schema change).** Follows the "Not done / next" list of ADR 0062.

## Context
ADR 0062 made `ledger-core.ts` the only writer of `LedgerEntry` and enforced the sign rules at every append. It left open "a check that the
ledger sum equals reconciliation figures per account". Until now nothing compared the ledger to the records that cause postings (bookings,
cancellation records, funding receipts), so a break between them could only be found by reading individual bookings. A CFO audit of the
finance, credit and reconciliation code (docs/finance-cfo-audit-2026-10-17.md) also found two defects, fixed here.

## Decisions
1. **Rules are pure, in `@bedbanks/money`** (`ledger-integrity.ts`, `checkLedgerIntegrity`): bigint minor units, no I/O, no clock (the caller
   passes `now`), per-currency totals only. It decides nothing and moves no money; each finding names a rule, the records and the amounts.
2. **Rules checked** (severity in brackets):
   - Entries: sign and non-zero per kind, entry currency equals account currency, account exists [critical].
   - Accounts: balance below minus the credit line [warning, because ADR 0024 decision 8 lets a limit be lowered below commitments].
   - Booking postings, folded by `booking:<id>` reference and idempotency key: one account per booking; released + settled never above
     reserved; settle-release equals the DEBIT; no DEBIT without a HOLD; refunds never above the charge [critical]; a reservation older than
     the stale threshold with no outcome [warning].
   - Ledger to bookings: booking exists; reserved and charged amount and currency equal the booking total; a booking in a charged state
     (CONFIRMED, AMEND_REQUESTED, CANCEL_REQUESTED, CHECKED_OUT, NO_SHOW) was charged; a charge only on a charged or cancelled booking; no
     money left reserved on a FAILED, REJECTED or CANCELLED booking; a charged CANCELLED booking has a cancellation record and exactly its
     refund [critical].
   - Ledger to funding receipts, both ways: each POSTED receipt has its CREDIT (amount, currency, account, `funding:<id>` reference); each
     funding CREDIT has a POSTED receipt pointing at it [critical].
   - Roll-forward per currency: balance = funding credits + other credits + refunds - charges - open reservations, with the POSTED receipt
     total beside the funding credits.
3. **Endpoint** `GET /admin/operations/finance/ledger-integrity` (`finance.read`, tenant RLS, contract `LedgerIntegrityReport`). One read
   transaction; no write, lock, grant or schema change. `staleMinutes` (5 to 10080, default 60) tunes the stale-reservation warning.
   Verdict: CLEAN, WARNINGS, ISSUES (any critical) or INCOMPLETE.
4. **No partial verdicts.** Above 50,000 entries per tenant the scan is capped and the verdict is INCOMPLETE with no findings. A partial
   ledger would report false breaks (a settlement past the cut-off looks like an unsettled reservation) or hide real ones. A paged or
   per-account scan is the next step once a tenant approaches the limit. At most 500 findings are listed; counts are always complete.
5. **F1 fixed: finance dashboard credit line.** `financeSummary` computed available credit and "overdrawn" from `Wallet.credit_limit`, which
   is always 0 on agency accounts (ADR 0028 slice 3). Every agency using its approved credit was reported overdrawn, and available credit was
   understated by the whole credit line. The wallets list already resolved the agency limit; both now share `creditLineResolver`
   (`agent/agency-account.ts`), which follows the same rule as the binding authorization.
6. **F2 fixed: no settlement of a released reservation.** Confirmation converted the HOLD into RELEASE + DEBIT without checking whether the
   authorization had already been released (`:release`, posted by compensation or reconciliation). Booking and journal states normally make
   the two exclusive, but nothing at the ledger level did; if both happened the ledger would show HOLD, RELEASE, RELEASE, DEBIT, a confirmed
   stay at a net charge of zero. Confirmation now refuses with 409 `Financial authorization was released` and changes nothing.

## Not done
Items 1 to 3 below are resolved by ADR 0069 (decided as global bedbanks run them).

- **Booking-ops cancellations post no refund** (audit finding F3). Operator `confirmCancellation` and the supplier runner's
  `systemCompleteCancellation` move a ledger-charged booking to CANCELLED without a cancellation record or a REFUND, so the agency stays
  charged and the charge keeps ageing towards the 30-day refusal. The lifecycle states this on purpose ("does not pay a refund or settle
  the ledger"), but no later step posts the refund and, until this check, nothing reported the booking. The check reports each one as `CANCELLED_REFUND_NOT_POSTED`. A fix needs
  decisions: who posts the refund (the booking-ops role has no ledger grant, ADR 0032), from which penalty (the `BookingFinanceEvent`
  CANCELLED penalty, which may be undetermined), and with what approval.
- Database-level guards (sign CHECK per type, entry currency equal to wallet currency, same-tenant wallet reference, an immutability
  trigger). They need a reviewed migration; see the audit, F4.
- A scheduled run. The background role deliberately has no ledger access; scheduling needs a decision on which role runs it.
- An Admin page. The contract is in place for one.

## Verified
`@bedbanks/money` tests (21, of which 11 new), API unit suite (1423 passed, 3 skipped), type-check, lint, `check:architecture`, and against a
local PostgreSQL 16 with every migration applied: new e2e `ledger-integrity` (5: every seeded break and only those, roll-forward, tenant
isolation with a clean verdict, RBAC and input, F1) and a new F2 case in `booking-confirmation`; both new tests were shown to fail with their
fix removed. The 15 finance-related e2e suites pass (102 tests). Full e2e: 86 of 92 suites pass (883 tests, 18 skipped); the 5 that fail (`booking-ops-queue`, `booking-ops-role`, `hotel-search-index`, `rate-plan-clone-role`, `sandbox-content-staging`) fail on `main` without this change too, and need CI-only settings here (`MAPPING_DATABASE_URL`, a database named `fbeds_ci`, separate role credentials). Not run: browser, CI.

## Rollback
Revert the commit. Nothing is stored, so there is nothing to migrate back.
