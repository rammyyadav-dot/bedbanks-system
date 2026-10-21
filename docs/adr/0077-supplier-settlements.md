# ADR 0077: Supplier settlements

Status: **Built, writes off by default** (`SUPPLIER_SETTLEMENT_ENABLED`). Follows ADR 0076 (posted supplier payables) and ADR 0054 (payables, blocked on accounting policy).

## Finding
The system could say what it owes each supplier (ADR 0076) but not that anything had been paid. Payables only grew; aging could not shrink; nobody could see what was still outstanding.

## Decision
1. **A settlement records a payment made outside the system** (bank transfer, card, netting) against a supplier's posted payables. It moves no money and posts nothing to the agency ledger. Integer minor units in the payable's currency, never converted or added across currencies.
2. **Maker-checker, enforced twice.** `finance.settle.propose` proposes; a *different* person with `finance.settle.approve` approves. The service refuses the proposer (`SETTLEMENT_SELF_APPROVAL`, 403) and a database CHECK makes an approval by the proposer impossible even for the owner. A rejection needs a reason and may come from any approver; it frees the amount. Both permissions are formal role assignments only (granted to no role by the migration).
3. **A payment can never exceed what is owed.** Under a per-supplier-and-currency advisory lock, a proposal is accepted only if amount ≤ posted payables − (approved + still-pending settlements). Counting pending ones means two proposals cannot overpay together. The check is repeated at approval, because reversals can lower what is owed after a proposal.
4. **Idempotent and not repeatable.** `requestId` makes a proposal idempotent (same key and content returns the same settlement; same key and different content is `SETTLEMENT_IDEMPOTENCY_CONFLICT`). `(tenant, supplier, payment reference)` is unique, so one real payment cannot be recorded twice (`SETTLEMENT_DUPLICATE_REFERENCE`). The payment date cannot be in the future.
5. **Immutable once decided.** A trigger forbids deleting a settlement and changing a decided one; the amount, supplier, currency, date, reference and proposer never change after proposal.
6. **Audit.** `finance.settlement.proposed|approved|rejected`, USER actor, with supplier, currency, amount, reference and request ids; no free text.
7. **Same narrow role as the consumer** (`fbeds_finpost_ops`): SELECT, INSERT and UPDATE of the decision columns only on `SupplierSettlement` (not the amount or identity). The API role has no grant on these tables by design. Re-run `ops:provision-finance-posting-role` and `ops:verify-finance-posting-role` after migrating.
8. **Effect on the views.** Posted payables gain *Paid* and *Outstanding* (balance − approved payments; negative means the supplier has been paid more than is posted). Aging applies approved payments to the **oldest bookings first** (FIFO, in SQL), then buckets what remains.

## Defaults taken (owner decisions, change here and in the service)
- Settlement currency is the payable's currency; there is no FX and no cross-currency netting.
- No payment terms and no due dates exist, so aging is the age of what is owed, never "overdue".
- No approval threshold: every settlement needs a second person.
- Payments are applied to a supplier's oldest bookings first; per-booking allocation is not recorded, so a payment cannot be tied to a specific booking or supplier invoice.
- Writes are off until `SUPPLIER_SETTLEMENT_ENABLED=true`; reads always work.

## Not built
- Per-booking or per-invoice allocation, supplier invoices, payment terms and due dates, partial reversal of an approved settlement (a wrong approved payment needs a reviewed correction, not an edit), bank file export, and any real payment initiation.
- Comparison of the old booking-net accrual (ADR 0054) with the posted payables.
- Overpayment corrections: if reversals later make payments exceed what is posted, Outstanding goes negative and is shown as such; nothing is clawed back automatically.

## Verification
Validation unit tests (7). PostgreSQL e2e (in `booking-finance-posting`, now 26): propose, replay, idempotency conflict, duplicate reference, overpayment guard counting pending proposals, unknown supplier, wrong currency, future date, self-approval refusal, approval by another person, double decision, rejection with reason freeing the amount, audit trail, database immutability and self-approval CHECK (as owner), Paid/Outstanding, FIFO aging, filters, tenant isolation, disabled writes, unavailable role. Role certification covers the new grants and probes. Full suites and builds: see the PR.
Not run: CI, a browser, a production-shaped database.
