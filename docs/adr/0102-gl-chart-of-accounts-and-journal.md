# ADR 0102: General-ledger chart of accounts and derived journal

Status: accepted for build, writes off by default (`FINANCE_CHART_ENABLED=true`; reads always work). Builds the chart of accounts that operating model R8 and ADR 0101 named as missing.

## Decision
1. **The agency ledger stays the book of record.** The chart and journal change no ledger entry and no balance. The journal is a derived, read-only double-entry view of one closed month for the accountants.
2. **A chart per tenant.** `GlAccount` (code, name, type ASSET, LIABILITY, EQUITY, REVENUE, EXPENSE). Code, name and type never change and an account is never deleted (trigger, every role); it can only be deactivated, and not while a current mapping uses it. `finance.chart.manage` (S3), granted to no role by the migration.
3. **Movement categories.** Every ledger entry falls in one category, decided by what the posting code writes: `FUNDING_RECEIVED`, `PAYMENT_REVERSAL`, `OTHER_CREDIT`, `COMMISSION_PAYOUT`, `RESERVATION` (HOLD and RELEASE), `BOOKING_CHARGE`, `BOOKING_REFUND`, `CREDIT_NOTE`, `ADJUSTMENT`. An entry of an unknown kind is counted as unmapped and reported, never silently booked.
4. **Versioned mapping.** `GlCategoryMapping` says which (debit, credit) pair a category posts to for a **positive** stored amount; a negative amount posts the other way. Append-only: a change is a new version, the highest is current, setting the same pair again changes nothing. The two accounts must differ, be active and belong to the tenant.
5. **Default chart (a starting point for review).** 1000 Bank, 1900 Unclassified (suspense), 2100 Agency account balances, 2110 Agency reservations in progress, 2200 Booking proceeds not yet earned, 6100 Agency commission, 6200 Credit notes and goodwill, 6900 Agency account adjustments. The agency balance is a liability of the bedbank; a negative balance is a receivable shown net on the same account. Created by an explicit, idempotent "initialize" action.
6. **The journal.** `GET /admin/finance/journal?month=YYYY-MM` for a month that is **closed** (ADR 0101), per currency, gross (positive and negative amounts of a category are separate lines, so a reservation and its release both show), with totals by account. It reports `balanced` (debits equal credits in every currency), `tiesToClose` (entry count and signed sum per currency equal the totals recorded at close), the unmapped entry count, and how many credits sit in suspense. It refuses if any category lacks a mapping, or the month has more than 500,000 entries.
7. **Reproducibility.** The journal is recomputed on each read from the locked month using the current mapping versions, and says which versions it used. A later mapping change therefore changes the journal for old months; the versions are kept so the earlier result can be explained, but earlier journals are not stored.
8. **Audit.** `finance.chart.initialized`, `account_created`, `account_deactivated`, `mapping_set` (ids, codes, versions only).

## API
`GET /admin/finance/chart`, `POST /chart/initialize`, `POST /chart/accounts`, `POST /chart/accounts/:accountId/deactivate`, `POST /chart/mappings`, `GET /journal?month=`. Contract: `@bedbanks/contracts` (`chart-of-accounts.ts`). Admin: Finance, Chart of accounts.

## Migration `202612160001_gl_chart_of_accounts`
Two tables with CHECKs, composite foreign keys to the same tenant's accounts, immutability triggers, forced row-level security, one permission. Tenant-index review: `tenant_id` leads every index. Classified finance-gated. Rollback in the migration header (discards the chart and mapping history; export first).

## Needs your accountants before it is relied on
- **The default accounts and pairs are an engineering proposal, not accounting advice.** In particular: the agency balance as a liability, charges credited to "proceeds not yet earned" (no revenue recognition), commission and credit notes as expense (not contra-revenue), a negative adjustment against the same expense account whatever its reason (a bank fee and a goodwill debit are not distinguished), and unclassified credits in suspense.
- **Revenue, supplier cost, margin, VAT and the supplier side** are not derived from the agency ledger and have no accounts or journal lines.

## Not built
- A specific accounting package format and posting to an accounting system. A generic CSV export exists (ADR 0103).
- Stored (frozen) journals per closed month; a second approver for chart changes; reactivating an account; account hierarchy or parent accounts; multiple charts per tenant; a journal for an open month.
- A browser test of the Admin screen.

## Verification
Money package 77 tests (classification, gross journal, balance per currency, agency account net equals the ledger sum, unmapped entries counted, default chart integrity). API unit tests including input validation. PostgreSQL 16 with pgvector: `finance-chart.e2e-spec.ts`, 9 tests (flag, initialize and its repeat, tenant isolation, open month refused, closed-month journal balanced and tied to the close record, versioning and idempotent re-set, mapping and deactivation rules, incomplete mapping, immutability for any role). Admin: type-check, lint, 229 tests. Not run: CI, strict-runtime-role suites, a browser.
