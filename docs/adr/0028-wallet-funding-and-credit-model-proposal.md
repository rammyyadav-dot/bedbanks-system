# ADR 0028: Wallet funding and credit model (PROPOSED, not accepted, nothing built)

## Status
**Proposed.** A design for the owner to accept, change or reject. It changes how money is modelled, so it needs finance and legal review before any code. No migration, code or payment-provider integration exists for it, and booking stays disabled (`BOOKING_ENABLED`) until the go-live gates in `docs/bedbank-operating-model.md` are met.

## 1. What exists today (facts from the code)
- **`Wallet`** is one row per **tenant and currency** (`@@unique([tenantId, currency])`), with a `creditLimit` and a `cachedBalance`. It is not per agency.
- **`LedgerEntry`** is append-only and signed, with types CREDIT, DEBIT, HOLD, RELEASE, REFUND, a currency, an `idempotencyKey` unique per wallet and a `reference`. A reused key with different intent is a 409.
- **Balance** = the sum of entries. **Available credit** = `wallet.creditLimit + balance`. A booking authorisation locks the wallet row (`FOR UPDATE`), re-reads the balance and posts a negative `HOLD` only if available credit covers it ("Insufficient wallet credit" otherwise). Confirmation posts `RELEASE (+X)` then `DEBIT (-X)`; cancellation posts a `REFUND` for the refundable part.
- **Funding:** nothing posts a `CREDIT`. There is no top-up, receipt, payment link or provider integration in the code.
- **Supported settlement currencies (14):** AED, USD, EUR, INR, GBP, SAR, QAR, OMR, KWD, BHD, SGD, AUD, CAD, JPY. No conversion exists.
- **A second, separate "credit" concept** exists since ADR 0024: a per-agency **credit limit** that caps the holds an agency can place. It does not touch the wallet.

### The model gap this proposal resolves
In a bedbank the money relationship is **between the bedbank and each agency**: each agency prepays or buys on credit terms. Today one wallet serves a whole tenant, so one agency can spend funds another agency paid, and "Insufficient tenant credit" is a tenant-wide message. There are also two unrelated credit numbers (`Wallet.creditLimit` and the agency limit). This ADR proposes one account per agency and one credit concept.

## 2. Proposed model

### 2.1 Agency account
One **agency account** per agency and currency, extending `Wallet` with an `agencyId` (unique on tenant, agency, currency). The existing tenant-level rows (agency null) become the **house account** used for platform-level postings and migration; they are no longer spendable by agents.

Each account has a **mode**:
| Mode | Spendable amount | Typical agency |
|---|---|---|
| PREPAID | `balance` (cannot go below zero) | New or small agencies |
| ON_ACCOUNT | `balance + creditLine` | Approved agencies on payment terms |

`available = balance + creditLine` (creditLine is 0 for PREPAID). **Reserved** funds (open holds) are already inside `balance` as negative `HOLD` entries, so available is never double-spent.

### 2.2 One credit concept
Recommended: the per-agency **credit limit of ADR 0024 becomes the account's `creditLine`**, and the hold-ceiling check is replaced by the available-funds check (a hold is placed only if `available >= amount`). This removes the second number. Maker-checker for changing it stays. Alternative (not recommended): keep both, as an exposure ceiling for ON_ACCOUNT agencies and a separate wallet; this is more complex and lets the two disagree.

### 2.3 Ledger rules (invariants)
1. Append-only; entries never updated or deleted (database trigger, as for documents).
2. Signed integer minor units; one currency per account; no FX.
3. Balance is always the sum of entries; `cachedBalance` is a derived value verified by a nightly check, never authority.
4. Every posting has an idempotency key and a business reference (receipt, booking, adjustment id).
5. No posting may take a PREPAID account below zero or an ON_ACCOUNT account below `-creditLine`.
6. Every posting writes an audit event with ids and amounts, never payer personal data or card data.

### 2.4 Posting table
| Event | Entry | Sign | Notes |
|---|---|---|---|
| Funds received and verified | CREDIT | + | reference = receipt id |
| Hold or prebook | HOLD | - | reserves; fails if not available |
| Hold released or expired | RELEASE | + | returns the reservation |
| Booking confirmed | RELEASE (+X), DEBIT (-X) | net 0 | reservation becomes a charge |
| Cancellation | REFUND | + | `cancellable - penalty`, from the contract policy |
| Correction | ADJUSTMENT (new) | +/- | maker-checker, reason required |
| Payment reversal or chargeback | REVERSAL (new) | - | links to the original receipt |

## 3. Funding workflows

### 3.1 Bank transfer (recommended first path; no provider needed)
State: **DECLARED -> VERIFIED -> POSTED**, or REJECTED, or REVERSED.
1. The agency (or finance on its behalf) declares a transfer: amount, currency, bank reference, date, payer name. A unique constraint on (tenant, bank reference, amount, currency) rejects duplicates.
2. Finance **verifies** it against the bank statement (a second person from the one who declared it).
3. **Posting** creates the CREDIT. Amounts above a **threshold** need a second approver (maker-checker, an approval-only key such as `funding.approve`).
4. Only **POSTED** funds count. A declared but unverified transfer never increases available funds, so a booking cannot rely on money not yet received.
Cash and third-party payers are flagged for compliance review (see section 7).

### 3.2 Card or payment link (later, needs a provider)
State: **CREATED -> AUTHORIZED -> CAPTURED -> POSTED**, or FAILED, CANCELLED, REFUNDED. Webhooks are idempotent and verified; the CREDIT is posted only on a verified capture; provider fees are a decision (absorb, or surcharge shown as a separate line). Card data never touches fBeds (hosted fields or redirect only).

### 3.3 Credit terms (ON_ACCOUNT)
- Set by an approved request (maker-checker): credit line, currency, **payment terms** (for example net 14 days), invoicing cycle (per booking, weekly or monthly) and an optional review date or expiry.
- Charges accrue as DEBITs; the agency settles by funding the account. **Aging** buckets (current, 1-14, 15-30, 31+ days overdue) are computed from the oldest unpaid DEBIT.
- **Overdue rules (proposed defaults):** at 1 day overdue send a notice; at 8 days new holds are refused with `AGENCY_CREDIT_OVERDUE`; at 30 days the agency is suspended through the existing suspension flow. Existing confirmed bookings are never cancelled by these rules.
- **Temporary increase** with an expiry date; reverts automatically.

## 4. Refunds
Default: **back to the agency account** as a REFUND (instant, no payment-provider cost). Refund to the original source (bank or card) is a separate finance action with approval and is allowed only up to what was funded by that source. A refund is never larger than the amount debited for that booking.

## 5. Visibility and reporting
- Agent app: balance, credit line, available, reserved, recent entries, statement (PDF), outstanding invoices, a clear refusal reason when funds are short, and a low-balance warning at a set share (default 20 percent of the credit line or one average booking).
- Admin: per-agency account, ledger, aging, receipts queue, daily cash position, unmatched receipts, reconciliation to bank, exports for accounting.
- Statements are generated from the ledger only and carry the same figures as the screen.

## 6. Edge cases and rules
| Case | Rule |
|---|---|
| Partial payment | Posts what was verified; the rest stays outstanding |
| Overpayment | Posts in full as balance; refund only on request with approval |
| Duplicate bank reference | Rejected at declaration |
| Wrong currency | Rejected; no conversion; finance contacts the agency |
| Funds arrive after a hold expired | Credited as balance; the hold is not revived |
| Suspended agency with a balance | Balance frozen for new spend, still refundable and still shown |
| Agency closed | Balance refunded or transferred by finance with approval, then the account is closed |
| Chargeback | REVERSAL; may push the account negative; triggers a review and can suspend |
| Backdated entry | Not allowed; corrections are new ADJUSTMENT entries |
| Concurrent bookings on the last funds | Row lock on the account; exactly one succeeds |

## 7. Controls and compliance (decisions for finance and legal)
- Segregation of duties: declarer, verifier and approver differ above the threshold; all enforced by the service and by approval records.
- Limits: a maximum single receipt, a daily total per agency, and a hold on first-time large receipts.
- AML and sanctions: payer name matching against the agency, third-party and cash handling, and screening policy are **owner and legal decisions**; this ADR does not set them.
- Tax and invoicing (VAT, tax invoice numbering) are separate; this model only provides the amounts and references.
- Retention of receipts and proof of transfer, and who may see payer details.

## 8. Build plan (each slice small, reviewed, behind flags, no live money until the last)
1. **Agency accounts, read-only:** schema for agency accounts and migration of the tenant wallet to the house account; statement and balance views; no posting change.
2. **Manual funding:** receipt declaration, verification, posting with thresholds and maker-checker; unmatched and duplicate handling; full e2e.
3. **One credit concept:** convert the agency credit limit into the credit line; available-funds check replaces the hold ceiling; payment terms and aging.
4. **Overdue controls:** notices, hold refusal, suspension hooks.
5. **Payment provider:** payment links, verified webhooks, fees.
6. **Refund to source, reconciliation to bank, accounting export.**
Each slice ships with tests for concurrency (one winner on the last funds), idempotency, tenant isolation, permissions and audit, and a browser check.

## 9. Decisions needed from the owner
1. **Account model:** one account per agency (recommended) or keep a tenant-wide wallet?
2. **Credit concept:** merge ADR 0024's limit into the account's credit line (recommended) or keep two numbers?
3. **Funding methods for launch:** bank transfer only (recommended), or also card or payment link, and which provider?
4. **Credit terms:** payment terms offered, overdue day thresholds (7 and 30 proposed), who approves a credit line.
5. **Approval threshold** for large receipts and adjustments (amount per currency).
6. **Provider fees:** absorb or surcharge.
7. **Refund default:** to the account (recommended) with refund-to-source by finance approval.
8. **Compliance:** AML, sanctions, cash and third-party payer policy; retention.
9. **Currencies at launch** from the 14 supported (AED and USD only is simplest).

## 10. Consequences if accepted
Two to four migrations over the slices (agency accounts, receipts, payment intents, adjustment and reversal ledger types), several approval-only permission keys, new Agent and Admin screens, and a change to the hold authorisation check. Nothing changes until slice 1 is built; no money moves until slice 2 and the go-live gates. Rollback per slice is a feature flag plus a forward migration; ledger rows are never deleted.
