# ADR 0095: Dynamic credit risk policy

Status: **Built. Part A: risk policy, enforcement at hold and prebook, finance queue, SHADOW by default. Part B: partial credit notes with maker-checker, off until `CREDIT_NOTES_ENABLED=true`.**

## Finding
Credit control was a hard limit (`balance + credit line - pending holds`) plus two global ageing terms: notice at 7 days, new holds refused at 30 (ADR 0024, 0028). Nothing looked at how close to the
line an agency was running, or at how much of what it owed was already overdue. An agency could sit at 99% of its line with half of it two weeks late and still book until the last minor unit.

## Decision (Part A)
1. **One pure engine** (`@bedbanks/money`, `credit-risk.ts`): `evaluateCreditRisk(position, policy, newAmount)`. Integer minor units as bigint, thresholds in integer basis points, no I/O, no float, no conversion.
   `drawn = max(0, -balance) + pending holds`; `utilisation = drawn / credit line`. States, worst first:
   | State | When | Effect |
   |---|---|---|
   | PAUSED | projected utilisation (with the new hold) at or above 95%; or aged unpaid charges (7+ days) worth 50% or more of the line; or any charge unpaid 30+ days | new holds and bookings refused |
   | MARGIN_CALL | drawn at or above 90% of the line | listed in the finance queue with the payment that restores the account; holds still allowed |
   | WATCH | drawn at or above 80% | listed |
   | OK | otherwise | |
   A prepaid agency (no credit line) has no utilisation and is paused only by the 30-day rule. The payment to restore is the amount that takes the account strictly below the watch level.
2. **Policy values** are `AGENCY_CREDIT_RISK_POLICY` in `@bedbanks/contracts`: 80%, 90%, 95%, 7 days, 50%, 30 days. **They are engineering defaults, not an owner decision.** They are global, not per agency.
3. **Enforced where money is committed, with the existing per-agency lock and fail-closed behaviour.** A new hold (`assertAgencyCredit`) is evaluated with the hold amount, so utilisation is projected. Prebook
   (`bookingAccountFor`) re-checks the overdue rules only, because the hold being booked is already counted and refusing it a moment after accepting it would be wrong. The existing 30-day refusal and the
   funds check are unchanged and still run first.
4. **Shadow by default.** `CREDIT_RISK_ENFORCEMENT=enforce` turns refusals on (403 `AGENCY_CREDIT_PAUSED` with the reasons and the payment to restore). Anything else records what *would* have been refused
   (log line with ids and codes, plus a `credit.risk.would_pause` audit event on holds) and refuses nothing. Recommended rollout: run in shadow for a few weeks, review the audit events and the queue with
   finance, adjust the policy, then enforce.
5. **The finance queue** `GET /admin/operations/credit-risk` (`finance.read`) lists every agency account that is not OK, worst first, with drawn amount, utilisation, overdue ageing, the payment to
   restore and the current mode. Live from the ledger; nothing is stored. Capped at 500 accounts, and it says so.
6. **Aging** now also returns `overdueUnpaidMinor`, the part of the unpaid charges at least 7 days old.

## Limits
- **"Margin call" is a queue entry, not a message.** Nothing is emailed or sent to the agency; the repository has no notification channel for agencies. Finance sees the call in the queue.
- **No stored state.** A transition (OK to MARGIN_CALL) is not recorded when it happens, only when a hold is checked in shadow mode. A stored state history needs a table and a scheduled job.
- **Global thresholds.** Per-agency terms, temporary increases and review dates remain open (operating model section 5).
- **Shadow audit writes share the hold's transaction.** If that insert were refused by the database the hold would fail; the hold path already inserts audit events in the same transaction, so the grant exists.

## Decision (Part B): partial credit notes
Cancellation credits were already automatic (ADR 0069), and the existing `CREDIT_NOTE` document is one per booking and only for a cancelled booking. What did not exist was a controlled way to credit an agency
part of a charge for a booking that stands: the hotel relocated the guest, the supplier failed to deliver a service, a price was wrong.
1. **`BookingCreditNote`** (migration `202612100001_booking_credit_notes`): PROPOSED by one person, APPROVED or REJECTED by another (database CHECK: the decider is never the proposer). Once decided the row is
   immutable and nothing is ever deleted (trigger). Forced RLS; composite tenant foreign key to the booking; permissions `finance.creditnote.propose` and `finance.creditnote.approve`, granted to no role by the migration.
2. **Approval posts exactly one REFUND** to the agency account, in the same transaction that marks the note approved, under the booking row lock then the wallet row lock (the order every cancellation path uses).
   The REFUND is keyed `booking:<id>:credit-note:<noteId>` and the note stores the entry id (unique), so a note cannot be posted twice. It reuses `appendLedgerEntry`, so sign rules, the single-writer check,
   the database guards and the hash chain (ADR 0094) all apply unchanged. No new ledger entry kind was needed.
3. **Never more than the charge.** A proposal may not exceed the charge not yet refunded *less the notes still waiting*; an approval re-checks against the refunds actually posted. Eight simultaneous proposals of 2,000
   against a 10,000 charge: five are accepted, three refused; ten simultaneous approvals post five refunds once each.
4. **Scope.** Only CONFIRMED, CHECKED_OUT and NO_SHOW bookings that were charged on the ledger. A cancelled booking is credited by the cancellation settlement (the integrity rule `REFUND_MISMATCH` compares its refund
   to the cancellation record, so a separate credit would raise a false critical finding). If a booking is cancelled *after* a credit note, the settlement counts the credit as already refunded and tops up only the difference, or
   sends the booking to review if the credit already exceeds what the cancellation would refund.
5. **Numbering**: `CN-<booking reference>-P<n>`, unique per tenant. This is **not** a gapless legal sequence; gapless yearly numbering and tax lines remain open (ADR 0054).
6. **API** `/admin/finance/credit-notes`: `GET` (`finance.read`), `POST` propose, `POST :id/approve`, `POST :id/reject`. Writes answer 503 `CREDIT_NOTES_DISABLED` until the deployment sets `CREDIT_NOTES_ENABLED=true`.
   Every step writes an audit event with ids and amounts, never guest data.

## Not built in Part B
- **Supplier-side recovery.** A service failure usually also earns the bedbank a credit *from the supplier*. That is a supplier payable adjustment (ADR 0076/0077) and is not linked here; finance does it separately.
- **Revenue and payables reports are not netted.** The booking finance events (`BookingFinanceEvent`) have no credit type, so margin and revenue reports do not reflect a credit note. Adding an event type touches the finance consumer and its posting plan and needs its own change.
- **A rendered credit note document** (printable, with tax lines). The record, its number and its ledger entry exist; a document in the style of `CN-<ref>` is not generated.
- **A threshold for a second approver**, withdrawal by the proposer, and an agency-facing view or notification.
- **Credit notes for a cancelled or amended booking, for a pay-at-hotel booking (never charged on the ledger), and in a currency other than the booking's.**
