# ADR 0063: Ledger integrity report

Status: **Built (read-only).** Follows ADR 0062.

## Why
A bedbank holds agency money and owes suppliers, so finance must be able to prove every day that the books add up. Global bedbank practice is a daily control: every account reconciles to its entries, every booking's money trail follows the lifecycle, and nothing is left half-finished. Before this, the Admin could list wallets and ledger rows but nothing checked them against the rules.

## What it checks
`GET /admin/operations/ledger-integrity` (permission `finance.read`, tenant RLS) and the page `/finance/integrity`:
- **Per account:** the balance is the ledger sum (never `cached_balance`). An account below minus its credit line is `ACCOUNT_OVERDRAWN`. Entries whose currency differs from their account are `ENTRY_CURRENCY_MISMATCH`.
- **Per booking** (entries referenced `booking:<id>`): one hold; the release never exceeds the hold; the charge equals the release; at most one charge and one refund; the refund never exceeds the charge; one currency. A hold left open 24 hours or more with no release or charge is a warning (`STALE_AUTHORIZATION`).
- **Control totals per currency:** accounts, balance, credit lines, available, overdrawn count, and entry count and sum by type. Currencies are separate rows and never added.
- **Verdict:** any error is FAIL, otherwise any warning is WARN, otherwise PASS.

The rules are pure functions in `@bedbanks/money` (`ledger-integrity.ts`); the database reads live only in the ledger core (ADR 0062) so the single-writer guard still holds.

## Page features
Findings link to the booking. **Download CSV** builds a file in the browser from the report on screen (verdict, per-currency totals, every finding). Amounts stay exact integer minor units beside their currency; text cells that a spreadsheet could run as a formula are neutralized, plain integers (including negative balances) are left as numbers. Nothing is uploaded and the report holds no guest or agency personal data.

## Deliberately not done
- It never repairs, posts or reverses anything. A finding is for a person to investigate. Corrections need the maker-checker adjustment path that ADR 0028 and ADR 0054 leave undecided.
- It reads at most 20,000 bookings per call and says `truncated` when there are more; a truncated result is not a clearance. A scheduled, stored run with history is built in ADR 0064; alert routing to a person is still an owner decision.
- Supplier payables, bank-statement matching and refund-to-source reconciliation (ADR 0028 slice 6) are separate work and not claimed here.
- Under the ordinary API runtime role the ledger is not readable, so the endpoint answers with the explicit `OPERATIONS_READ_DENIED` error rather than an empty report.

## Verified
Money package tests, API unit tests, Admin tests (CSV safety), Postgres e2e `ledger-integrity` (permission 401/403, each rule, overdrawn account, per-currency totals, tenant isolation, read-only), type-check, lint, `check:architecture`.
