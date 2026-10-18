# Finance, credit and reconciliation: CFO audit (2026-10-17)

Scope: every path that writes or reads money in `apps/api` (ledger core, booking authorization, confirmation, cancellation, compensation,
reconciliation, funding, agency credit, aging, Admin finance reads), the money package, and the finance migrations. Method: code and
migration reading, then tests against a local PostgreSQL 16 with all migrations applied. Fixes and the new check are in ADR 0068. The target
operating model is in `docs/finance-credit-reconciliation-operating-model.md`.

## Verdict
The posting core is sound: one writer, integer minor units, sign rules at every append, idempotency keys unique per account, a row lock
on every reservation, fail-closed credit checks, no currency conversion, and separation of duties on funding enforced by the database.
The weak points are at the edges: one dashboard showed the wrong credit position, one ledger state was guarded only by business state,
operator cancellations leave refunds unposted, and the database does not itself enforce the ledger's rules. Until today nothing tied the
ledger to bookings and receipts.

## Findings

| # | Severity | Finding | Status |
|---|---|---|---|
| F1 | High | Finance dashboard used `Wallet.credit_limit` (always 0 on agency accounts) as the credit line, so every agency using approved credit was reported overdrawn and available credit was understated by the full line. `operations-finance-audit.service.ts` | **Fixed**, shared `creditLineResolver`; e2e shown to fail on the old code |
| F2 | High | Confirmation settled a reservation without checking it had not been released; if compensation or reconciliation had released it, the stay would be confirmed at a net charge of zero. `booking-confirmation.service.ts` | **Fixed**, 409 and no change; e2e shown to fail on the old code |
| F3 | High | Operator `confirmCancellation` and supplier-runner `systemCompleteCancellation` cancel a ledger-charged booking with no cancellation record and no REFUND. The agency stays charged; the charge keeps ageing to the 30-day hold refusal. Documented in the lifecycle as intended, but no later step posts the refund. | **Fixed** (ADR 0069): credited automatically per the effective penalty; undecided penalties wait for a decision; sweep for anything missed |
| F4 | Medium | The database does not enforce the ledger's own rules: no CHECK for sign or zero per type, nothing ties entry currency to wallet currency, a ledger row's wallet can belong to another tenant (a foreign key ignores RLS), and append-only rests on there being no UPDATE/DELETE policy, so the owner role can still change rows. ADR 0028 2.3 proposed a trigger; none exists. | **Fixed** (ADR 0069): migration `202611210001_ledger_integrity_guards` |
| F5 | Medium | No reconciliation of the ledger to bookings, cancellations or receipts existed (ADR 0062 "next"). | **Built**: `GET /admin/operations/finance/ledger-integrity` |
| F6 | Low | Receivables ages at most 500 agency accounts and says nothing when it stops; one query per account. `operations-transactions.service.ts` | Open: add `scanCapped` like Markets |
| F7 | Low | `AgentFinanceService.assertFunds` is unused by product code, sums the ledger in application code (outside the single-writer check, which only matches `aggregate`/`groupBy`) and checks the house account, which is never charged. Two e2e tests use it to pin that. | Open: remove, and point those tests at prebook |
| F8 | Low | `Wallet.cached_balance` is never maintained (known, ADR 0062). Nothing reads it. | Open: drop in a reviewed migration |
| F9 | Info | Credit terms are global constants (notice 7 days, refusal 30), one limit currency per agency, no temporary increase, no review date. | Business decision |

### Migration for F4 (built as `202611210001_ledger_integrity_guards`, ADR 0069)
```sql
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_sign_by_type" CHECK (
  ("type" IN ('CREDIT','RELEASE','REFUND') AND "amount_minor" > 0) OR ("type" IN ('DEBIT','HOLD') AND "amount_minor" < 0)) NOT VALID;
ALTER TABLE "LedgerEntry" VALIDATE CONSTRAINT "LedgerEntry_sign_by_type"; -- existing bad data stops the migration
-- BEFORE INSERT trigger: the wallet exists in the same tenant and has the same currency.
-- BEFORE UPDATE OR DELETE trigger: raise, for every role (append-only even for the owner); a DELETE only with fbeds.ledger_erasure = 'on'.
```
Rollback: drop the constraint and triggers. Tenant-index review: none needed (no new index). Run the integrity check first; `NOT VALID`
keeps the migration safe on existing data.

## Controls verified as working
| Control | Evidence |
|---|---|
| One ledger writer; sign, zero, ISO currency checked on append | `ledger-core.ts`, `check:ledger-single-writer` |
| Idempotent postings; reuse with different intent is 409 | `@@unique([walletId, idempotencyKey])`, `assertSame*` in authorization and `LedgerService` |
| Reservation is the binding spend check, serialised | wallet `FOR UPDATE`, ledger sum, `canSpend`; e2e "25 simultaneous confirmations" |
| Hold-time early check fails closed | `assertAgencyCredit` returns 503 when unreadable |
| Credit-limit change is maker-checker | ADR 0024, `credit_limit.approve` |
| Funding: declarer, verifier, compliance and poster separated; above threshold two people | CHECK constraints in `202610220001_agency_funding_receipts` |
| Refund never above the charge | `refundWithin` in cancellation |
| Tenant isolation of ledger and wallets | forced RLS; e2e `tenant-finance`, `ledger-integrity` LI-03 |
| No FX anywhere in money paths | `check:no-float`; per-currency totals only |

## Tests run
Money package 21/21. API unit 1423 passed, 3 skipped. Type-check, lint, `check:architecture`: pass. PostgreSQL e2e, finance scope: 15
suites, 102 tests, all pass, including the new `ledger-integrity` suite and the F2 case. Full e2e: 86 of 92 suites pass (883 tests, 18 skipped); the 5 that fail (`booking-ops-queue`, `booking-ops-role`, `hotel-search-index`, `rate-plan-clone-role`, `sandbox-content-staging`) fail on `main` without this change too, and need CI-only settings here (`MAPPING_DATABASE_URL`, a database named `fbeds_ci`, separate role credentials). Not run: browser, CI.
