# Finance, credit and reconciliation: operating model

How money works in fBeds, written as an enterprise bedbank finance function would run it. Every rule is tagged:

- **BUILT**: in the code and tested. The reference names where.
- **PARTIAL**: some of it is built; the rest is said.
- **PROPOSED**: not built. Needs an owner decision, and often a migration and an ADR, before anything is written.

Constitution rules that apply throughout: integer minor units plus ISO-4217, never floating point (3); idempotent money mutations (6);
immutable audit events (8); nothing shown as capability that is not built (10). Related ADRs: 0024, 0028, 0029, 0054, 0062, 0068.

---

## 1. Principles

| # | Rule | Status |
|---|---|---|
| P1 | The ledger is the only book of record for agency money. A balance is the sum of its entries; any cached figure is never authority. | BUILT (ADR 0062) |
| P2 | Append-only. A mistake is corrected by a new, reasoned entry, never by editing or deleting one. | BUILT: database CHECK and triggers for every role, the owner included (ADR 0069) |
| P3 | One currency per account. Currencies are never converted, added or netted; every report has one row per currency. Launch currency AED; net rates are tax-inclusive. | BUILT (ADR 0028, 0029) |
| P4 | Every posting has an idempotency key and a business reference (`booking:<id>`, `funding:<receipt id>`). A replayed key with different intent is refused. | BUILT |
| P5 | Money controls fail closed: if a position cannot be read, the spend is refused. | BUILT |
| P6 | Whoever asks is not whoever approves for limits, large receipts and penalty waivers. | BUILT for those three; PROPOSED for adjustments |
| P7 | Every money mutation writes an audit event with ids and amounts, never payer or guest personal data. | BUILT |
| P8 | The ledger is reconciled to the records that caused it. A break is a finding to investigate, never something auto-corrected. | BUILT (ADR 0068) |

## 2. Accounts and entry kinds

**Accounts** (`Wallet`): one **agency account** per agency and currency, opened on first funding or first booking; one **house account**
per tenant and currency for platform postings. A booking is never charged to the house account; a user who belongs to no agency cannot
book (`AGENCY_REQUIRED_FOR_BOOKING`). BUILT (ADR 0028 slices 1 and 3).

**Entry kinds** and their stored sign:

| Kind | Sign | Meaning |
|---|---|---|
| CREDIT | + | Money received (a posted funding receipt) |
| HOLD | - | Money reserved for a booking being made |
| RELEASE | + | A reservation returned, or converted into a charge |
| DEBIT | - | The final charge for a confirmed booking |
| REFUND | + | Part of a charge returned on cancellation |
| ADJUSTMENT | +/- | Correction with a reason, maker-checker. PROPOSED |
| REVERSAL | - | A received payment reversed (bank recall, chargeback). PROPOSED |

## 3. Posting matrix

| Business event | Entries (idempotency key) | Net effect on balance | Status |
|---|---|---|---|
| Funding receipt posted | CREDIT +X (`funding:<receipt>`) | +X | BUILT |
| Prebook authorized | HOLD -X (`booking:<id>:authorize`) | -X reserved | BUILT |
| Prebook failed or compensated | RELEASE +X (`…:authorize:release`) | 0 | BUILT |
| Stalled attempt reconciled | RELEASE +X (`…:authorize:release`) | 0 | BUILT |
| Booking confirmed | RELEASE +X (`…:settle-release`), DEBIT -X (`…:settle-debit`) | stays -X, now a charge | BUILT; a released reservation can no longer be settled (ADR 0068 F2) |
| Cancelled, agent path | REFUND +R (`booking:<id>:cancel-refund`), R = total - penalty from the frozen terms | +R | BUILT |
| Cancelled, operator or supplier path | REFUND +R (`booking:<id>:cancel-refund`), R = total - effective penalty; nothing while the penalty is undecided | +R | BUILT (ADR 0069) |
| Penalty waived after settlement | REFUND +difference (`…:cancel-refund:<new total>`); a higher decision is never clawed back | +diff | BUILT (ADR 0069) |
| Goodwill refund, correction | ADJUSTMENT with reason, two people | +/- | PROPOSED |
| Payment reversed | REVERSAL linked to the receipt; may take the account negative and triggers review | -X | PROPOSED |

Booking ledger invariants, per booking (checked by ADR 0068):
`released + settle-release <= reserved`, `settle-release = charge`, `charge > 0 => reservation existed`, `refunds <= charge`,
`reserved = charge = booking total` in the booking currency, all on one account.

## 4. Order to cash

```
search -> hold -> prebook (authorize) -> supplier prebook -> confirm (settle) -> voucher + invoice
                                                                   \-> cancel (refund by policy) -> credit note
charges age FIFO -> notice at 7 days -> new holds refused at 30 days -> payment received -> applied FIFO
```

1. **Hold** (inventory): early credit check, `available = balance + credit line - pending holds`, under a per-agency advisory lock. A
   refusal is `AGENCY_CREDIT_LIMIT_EXCEEDED` with the available amount; an unreadable position is 503. Overdue at 30 days refuses here
   too. BUILT (ADR 0024, 0028).
2. **Prebook**: the **binding** check. Locks the account row, re-sums the ledger, posts the HOLD only if `balance + credit line` covers
   it ("Insufficient wallet credit" otherwise). Exactly one of two concurrent bookings on the last funds succeeds. BUILT.
3. **Supplier prebook**: an outcome that was not observed (timeout, transport) keeps the reservation and goes to manual review; it is
   never treated as not sent. BUILT.
4. **Confirm**: one transaction, inventory sold, reservation settled to a DEBIT, booking CONFIRMED, audit, confirmation email queued.
   BUILT.
5. **Documents**: voucher, invoice `INV-<ref>`, credit note `CN-<ref>`, frozen at issue. BUILT. Gapless yearly numbering and tax lines
   are PROPOSED (ADR 0054).
6. **Cancellation**: penalty from the terms frozen at booking; unreadable terms go to manual review, never treated as free; the stay
   must not have started. BUILT for the agent path. Operator and supplier cancellations credit the agency automatically per the effective
   penalty; an undecided penalty waits for a person's decision, then settles (ADR 0069).
7. **Aging**: FIFO over settled money only. A DEBIT is a charge dated when posted; a CREDIT pays the oldest charges; a REFUND first pays
   its own booking. HOLD and RELEASE are not aged. BUILT (ADR 0028 slice 4).
8. **Collection**: the agency pays by bank transfer and declares it (section 6).

## 5. Credit management

| Rule | Detail | Status |
|---|---|---|
| Account modes | No credit line = **prepaid** (spend the balance). A credit line = **on account** (balance + line). | BUILT |
| One credit concept | The credit line is the agency's approved limit (ADR 0024), in its currency; another currency counts as zero. | BUILT |
| Setting a limit | Request with reason, a different person approves, applied once; re-checked against the stored value (409 if it moved). | BUILT |
| Lowering below commitments | Allowed; nothing existing is cancelled; new holds refused until it recovers. The integrity check shows it as `ACCOUNT_OVER_CREDIT_LINE` (warning). | BUILT |
| Near limit | 80% of the line used: display tag only. | BUILT |
| Overdue | Oldest unpaid charge 7 days: NOTICE (Admin, Receivables, agent banner). 30 days: new holds and bookings refused. Confirmed bookings are never cancelled by this. | BUILT (global constants) |
| Suspension | Manual maker-checker action; not automatic at any age. | BUILT (ADR 0020) |
| Per-agency payment terms | Net 7 / 14 / 30 per agency, invoicing cycle (per booking, weekly, monthly) | PROPOSED |
| Temporary increase | Raised line with an expiry date, reverting automatically | PROPOSED |
| Credit review | Review date per line; expired review blocks increases, not bookings | PROPOSED |
| Security | Deposit, bank guarantee or credit insurance recorded against the line | PROPOSED |
| Multi-currency lines | One line per currency, never combined | PROPOSED (AED only at launch) |

Credit-control KPIs (PROPOSED for a dashboard; all computable from built data): credit utilisation per agency (charges + reservations over
the line), days sales outstanding, share of receivables in NOTICE and HOLDS_REFUSED, top-10 exposure concentration.

## 6. Funding and cash application

Workflow **DECLARED -> VERIFIED -> POSTED**, or REJECTED. BUILT (ADR 0028 slice 2), behind `FUNDING_ENABLED`, bank transfer only.

- An agency user declares for their own agency only; finance may declare for any agency.
- One live receipt per bank reference + amount + currency (duplicate rejected at declaration).
- Verifier differs from declarer. Above AED 10,000 (and in any currency without a configured threshold) the poster also differs from
  the verifier. Cash deposits and third-party payers need a compliance clearance by someone other than the declarer before posting.
  These are database CHECK constraints, not only service rules.
- Posting opens the agency account if needed and appends one CREDIT keyed `funding:<receipt>`, in one transaction under the receipt
  lock. Only POSTED money is spendable.
- Applied FIFO to the oldest unpaid charges; anything left is prepaid balance. BUILT.

| Case | Rule | Status |
|---|---|---|
| Partial payment | Post what was received; the rest stays unpaid and keeps ageing | BUILT |
| Overpayment | Posted in full as balance; refund only on request, with approval | PARTIAL (refund to bank not built) |
| Wrong currency | Rejected; no conversion | BUILT |
| Funds after a hold expired | Credited as balance; the hold is not revived | BUILT |
| Bank recall or chargeback | REVERSAL linked to the receipt; review; may suspend | PROPOSED |
| Payment link or card | Provider, verified webhooks, fees policy | PROPOSED (slice 5) |
| Unmatched bank credit | Held in a suspense list until matched to an agency | PARTIAL: listed as `UNMATCHED_ENTRY` exceptions (ADR 0093); matching it to an agency and posting it are not built |

## 7. Supplier side (procure to pay)

| Step | Status |
|---|---|
| Accrual: recorded net cost of CONFIRMED and CHECKED_OUT bookings per supplier and currency; unknown net counted apart, never as zero | BUILT read-only (ADR 0054) |
| Supplier statement matching to bookings by reference and exact net; typed findings and a dispute queue | BUILT behind `FINANCE_RECONCILIATION_ENABLED` (ADR 0070); posting and payment not built |
| Supplier payment terms (contract has no field today), payment runs, virtual cards | PROPOSED |
| Cancellation penalties charged by the supplier | PROPOSED |
| Gross margin per booking (sell - net), per currency | PROPOSED (data exists; `booking.view.net` gates net) |

## 8. Reconciliation framework

| Reconciliation | What ties to what | Cadence | Status |
|---|---|---|---|
| R1 Ledger integrity | Every entry obeys sign, currency and account rules | Daily and before close | BUILT (ADR 0068); enforced at insert by the database (ADR 0069); daily run by the monitor (ADR 0069) |
| R2 Ledger to bookings | Reserved and charged amount = booking total; charged states charged; nothing reserved on closed bookings | Daily | BUILT (ADR 0068) |
| R3 Ledger to cancellations | Charged cancellations carry exactly their recorded refund | Daily | BUILT (ADR 0068) |
| R4 Ledger to funding receipts | Each POSTED receipt has its CREDIT and each funding CREDIT its receipt | Daily | BUILT (ADR 0068) |
| R5 Stalled attempts | Reservations and inventory stuck in PROCESSING returned, or sent to manual review | On demand; an attempt is stale after 30 minutes | BUILT as an operator action (ADR 0017 maker-checker optional); not scheduled |
| R6 Receipts and supplier payments to bank statement | Every POSTED receipt and recorded settlement appears on the bank statement; every statement movement is one of them or in suspense | Daily | PARTIAL: file upload (MT940, camt.053, CSV), matching, storage and the exception queue are built behind `FINANCE_RECONCILIATION_ENABLED` (ADR 0093); no UI, bank feed, ERA or ledger posting |
| R7 Supplier statement to accrual | Supplier's bookings and amounts match confirmed bookings and recorded net | Per statement | BUILT behind `FINANCE_RECONCILIATION_ENABLED` (ADR 0070) |
| R8 Ledger to general ledger | Control totals per currency exported to accounting | Monthly | PROPOSED (needs a chart of accounts) |

**Reading the R1 to R4 report** (`GET /admin/operations/finance/ledger-integrity`, `finance.read`):
verdict CLEAN, WARNINGS (credit-control or timing only), ISSUES (a critical break) or INCOMPLETE (scan capped, nothing claimed). The
per-currency roll-forward is `balance = funding + other credits + refunds - charges - open reservations`, with posted receipts beside
funding credits. Each finding carries its rule, account, agency, booking or receipt, and the amounts.

**Break handling** (PROPOSED as a written procedure; detection and the daily run are built):
1. Detect: `LedgerIntegrityMonitor` runs R1 to R4 for every tenant daily and logs ISSUES at error level (the alarm); ISSUES blocks the period close.
2. Triage within one business day: owner by code. Booking codes go to booking operations; receipt codes to the funding desk; entry codes
   to engineering (they mean a rule was bypassed).
3. Resolve with a new, reasoned entry or by finishing the missing step (for example post the refund for `CANCELLED_REFUND_NOT_POSTED`),
   never by editing a row.
4. Evidence: the audit event of the correcting action references the finding code and booking or receipt id.
5. Re-run; the finding must disappear.

## 9. Period close (PROPOSED)

Daily cut-off at 00:00 UTC on `immutable_at`. Monthly close checklist: R1 to R4 CLEAN or every finding explained; R5 run with no stalled
attempts older than the window; receivables aged at the cut-off; supplier accrual snapshot; control totals per currency exported; the
period locked so a new entry dated inside it is refused (entries are never backdated today, so the lock is about late corrections).

## 10. Segregation of duties

| Action | Maker | Checker | Status |
|---|---|---|---|
| Credit line set, change, remove | `agency.manage` | `credit_limit.approve`, different person | BUILT |
| Funding verify / post / compliance | `funding.manage` | different person; second person above threshold | BUILT |
| Penalty waiver | requester | `booking.penalty.waive.approve`, different person | BUILT |
| Reconciliation run | `booking.reconcile` | optional approval, different person (ADR 0017) | BUILT (optional) |
| Ledger adjustment, refund to source, write-off | finance | second finance approver above a threshold | PROPOSED |
| Read finance | `finance.read` | | BUILT |

## 11. Decisions needed from the owner

Decided 2026-10-18 "as per global bedbanks workflow and functioning" and built in ADR 0069: automatic cancellation credits per the
effective penalty (F3), database ledger guards (F4), and a daily read-only reconciliation run. Still open:

1. **Provision the monitor's read-only login** (`LEDGER_INTEGRITY_DATABASE_URL`) and the log alarm on its error lines.
2. **ADJUSTMENT and REVERSAL** entry kinds (goodwill refunds, corrections, payment recalls), threshold for a second approver.
3. **Scheduling R5** (stalled attempts) unattended: it writes SYSTEM audit events, which needs a governed role.
4. **Per-agency terms**, temporary increases, review dates, security.
5. **Chart of accounts and GL export** format; gapless credit-note numbering if a jurisdiction requires it; VAT presentation.
6. **Bank statement import** (format, bank) to build R6, and the suspense process for unmatched credits.
7. **Supplier settlement:** payment terms source, posting of agreed statements, payment method (statement matching is built, ADR 0070).
