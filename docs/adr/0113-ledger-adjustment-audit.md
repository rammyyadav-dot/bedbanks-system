# ADR 0113: Ledger adjustment audit rigor

Status: accepted. Extends the audit rule of ADR 0100 and the direct B2B adjustment posted by `LedgerService.postB2BLedgerAdjustment`.

## Why
Booking revenue, supplier settlements, credit notes and wallets already post through the append-only ledger. Two adjustment paths did not leave an examiner a complete trail. A maker-checker refusal (the proposer approving their own record, a reversal above the receipt, a request id reused for a different amount) threw inside the transaction, so the audit row rolled back with it. An approved posting was not tied back to its `finance.ledger_adjustment.approved` event by the daily integrity run. The direct B2B post recorded only a successful write: no balance before and after, no replay, and no refusal.

## Decision
1. **Same-transaction events stay.** `finance.ledger_adjustment.proposed`, `.approved` and `.rejected` are still written in the transaction that changes the adjustment. Approval records the proposer, the approver, the idempotency key, the reference, and the account balance before and after. Rejection records the adjustment reason and the decision reason separately. The free-text note stays on the adjustment row and is not copied into the audit payload.
2. **Refusals survive the rollback.** After the detecting transaction rolls back, the service writes one event and then returns the same HTTP error. A proposer deciding their own record is `approval.denied` with reason `SELF_APPROVAL`, so it counts in the audit summary's self-approval attention figure. A reversal over the receipt, a receipt that is not posted or belongs to another account, a missing currency account, and a request id reused for different intent are `finance.ledger_adjustment.denied` with the failure code and the amounts. A repeated presentation of the same proposal is `finance.ledger_adjustment.replayed` and inserts nothing.
3. **Direct B2B adjustments.** `finance.ledger.adjustment_posted` now carries the balance before and after and is passed through the audit sanitiser. The same idempotency key with the same intent appends `finance.ledger.adjustment_replayed` and does not post again. Excess refund, insufficient credit, a key reused for different intent, and a missing or wrong-currency wallet append `finance.ledger.adjustment_denied` after the money transaction rolls back.
4. **Integrity.** When the audit log is loaded, an ADJUSTMENT or REVERSAL entry that matches an approved record but has no `finance.ledger_adjustment.approved` event naming that entry is `ADJUSTMENT_AUDIT_MISSING` (critical). The rule is off when the audit log was not supplied, so existing pure checks stay as they are. The daily report loads those events. The monitor login must be able to SELECT `AuditEvent` as well as `LedgerAdjustment`.

## Not changed
The maker-checker permissions, the sign rules, the reversal cap, and the decision that an approved debit may pass the credit line. There is still no amount threshold for a second approver, and house accounts are still not adjustable.

## Verification
Money package ledger-integrity tests, including a missing and a matching approval audit. API unit: the refusal and replay audits, and the direct B2B post, replay and excess-refund denial. PostgreSQL `ledger-adjustments` e2e asserts the self-approval events and that a clean report stays clean once approval audits name their entries.
