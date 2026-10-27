# ADR 0100: Ledger adjustments and payment reversals

Status: accepted for build, off by default (`LEDGER_ADJUSTMENTS_ENABLED=true` turns writes on). Closes the "ADJUSTMENT and REVERSAL" item of the finance operating model (section 11, item 2) and the entry kinds ADR 0028, 0054, 0062 and 0093 left undecided.

## Why
The ledger could only move money through bookings, cancellations, credit notes, commission payouts and posted funding receipts. Finance had no governed way to take back a payment the bank recalled, book a bank fee, or allocate a credit sitting in suspense. Each of those would have meant editing a row (forbidden, ADR 0069) or a hand-written SQL insert. This adds the two missing entry kinds behind the same maker-checker flow as credit notes (ADR 0095 B) and commission payouts (ADR 0098).

## Decision
1. **Two entry kinds.** `ADJUSTMENT` is a reasoned correction that credits or debits an agency account (non-zero, either sign). `REVERSAL` takes back a received payment and is always negative. The database sign rule `LedgerEntry_sign_by_type` now covers both, for every role, the owner included.
2. **One record per posting.** `LedgerAdjustment` is PROPOSED by one person and APPROVED or REJECTED by a different one (CHECK, not only service logic). Approval appends exactly one ledger entry in the same transaction and links it (unique), so a record can never be posted twice. Once decided a row never changes and is never deleted (trigger).
3. **A reversal is tied to its receipt.** It names a POSTED funding receipt of the same agency, account and currency, and the total reversed (approved plus still-waiting proposals) can never exceed what the receipt paid. This is enforced by the service under the receipt row lock at proposal and again at approval, and re-checked by the daily integrity run. Lock order is receipt, then wallet, as the funding post does.
4. **Reasons belong to a kind.** Adjustment: `BANK_FEE`, `UNIDENTIFIED_CREDIT_ALLOCATED`, `CORRECTION`, `GOODWILL`. Reversal: `PAYMENT_RECALL`, `CHARGEBACK`, `DUPLICATE_PAYMENT`. A free-text note (3 to 500 characters, no personal data) is mandatory.
5. **Keys and references.** Adjustment: key and reference `adjustment:<id>`. Reversal: key `funding:<receipt>:reversal:<id>`, reference `funding:<receipt>`. A replayed `requestId` returns the same proposal; reuse with different intent is 409.
6. **Integrity.** The daily run (R1 to R4) gains `ADJUSTMENT_WITHOUT_APPROVAL` (an ADJUSTMENT or REVERSAL entry with no approved record of the same kind, account and amount) and `REVERSAL_EXCEEDS_RECEIPT`, both critical. The per-currency roll-forward gains `adjustmentsMinor` and `reversalsMinor`.
7. **Aging.** A REVERSAL, and a negative ADJUSTMENT, is a new charge dated when posted; a positive ADJUSTMENT pays the oldest charges like a CREDIT. A recalled payment therefore makes the money owed again and the age counts from the recall, not from the original charge. That is a simplification (FIFO keeps no per-payment record); an owner decision is needed if the original age must be restored.
8. **Permissions.** `finance.adjustment.propose` (S2) and `finance.adjustment.approve` (S3), granted to no role by the migration. Reads need `finance.read`.
9. **Audit.** `finance.ledger_adjustment.proposed|approved|rejected` with ids, kind, reason, currency, direction, amount and (on approval) the balance after. No payer or guest data.

## API
`GET /admin/finance/ledger-adjustments` (filters `status`, `kind`, `agencyId`), `POST` to propose, `POST /:adjustmentId/approve`, `POST /:adjustmentId/reject` (reason required). Routes and types are in `@bedbanks/contracts` (`ledger-adjustments.ts`). Tenant comes from the session only.

## Migrations
- `202612140001_ledger_adjustment_entry_kinds`: adds the two enum values only (a new value cannot be used in the transaction that adds it).
- `202612140002_ledger_adjustments`: re-creates `LedgerEntry_sign_by_type` (NOT VALID, then VALIDATE: existing data stops the migration if it breaks the rule; the ledger is locked for the scan, so run in a quiet window), creates the table with CHECKs, the account-consistency and immutability triggers, forced row-level security, and the two permissions. Tenant-index review: `tenant_id` leads every tenant index; the `wallet_id` and `funding_receipt_id` indexes exist only for foreign-key maintenance. Classified finance-gated in the runtime-role contract; no role is granted the table.
- Rollback: the header of the second migration. Enum values cannot be dropped and are harmless unused. Posted entries stay (append-only); restore the old sign CHECK only if none were posted. Disable by unsetting the flag.

## Risks accepted
- An approved debit may take an account below its credit line. A payment that really was recalled must be bookable; it surfaces as `ACCOUNT_OVER_CREDIT_LINE` (warning) and the aging.
- Adjustments are credit-creating. The control is a second person, the reason and note, the audit event and the daily integrity run. There is **no amount threshold for a second approver tier** yet.

## Not built
- **Admin screen.** The API exists; there is no page, so nothing in the Admin UI claims this capability. The ledger page filter lists the new entry types because it only displays posted entries.
- **House-account adjustments** and bank fees against the platform's own account; only agency accounts are adjustable.
- **Posting from a bank reconciliation finding** (ADR 0093): a bank fee or an unidentified credit is still re-keyed as a proposal by a person; no automatic link.
- **Revenue and margin reports** are not netted for adjustments (as with credit notes, ADR 0095 B).
- **A rendered document** and gapless numbering for adjustments.
- **Withdrawal by the proposer**, an agency-facing view or notification, and a proposal expiry.
- **Period close, chart of accounts and GL export** (operating model R8 and section 9) are still proposed.

## Verification
Money package: 62 tests (sign rules, roll-forward, approval and cap rules). API unit: 203 suites, 2,213 tests. PostgreSQL 16 with pgvector, new suite `ledger-adjustments.e2e-spec.ts` (11 tests: flag off, flow, credit direction, idempotency, separation of duties and immutability, reversal cap, receipt rules, database guards, 8-way concurrency on proposals and 16-way on approvals, approval re-check, integrity report with a rogue entry) plus 73 related finance tests across 11 other suites, all passing (84 in 12 suites together). `check:architecture`, lint (0 errors), type-check (16 packages) pass. Not run: the strict-runtime-role suites that need CI-only role credentials, a browser, CI.
