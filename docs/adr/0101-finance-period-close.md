# ADR 0101: Finance period close

Status: accepted for build, off by default (`FINANCE_PERIOD_CLOSE_ENABLED=true` turns closing on; preview and list always work). Builds operating model section 9 (R1 to R4 gate, control totals, lock).

## Decision
1. **A period is one calendar month in UTC**, `[first of month, first of next month)` on a ledger entry's `immutable_at`. Months close in order with no gap: the first close is the month of the earliest entry, each next one starts where the last ended. A month closes only once it has ended, with a 5 minute grace so a posting still committing at midnight is not missed.
2. **The integrity gate.** Closing runs the ledger integrity report (R1 to R4, ADR 0068, 0094). A critical finding (`ISSUES`) or an incomplete scan refuses the close. Warnings (credit control, timing) do not block and are recorded with the count.
3. **Control totals.** Per currency, never added across currencies: opening (all entries before the month) + movement (entries inside it, by type with counts) = closing (all entries before its end). If the three reads disagree the close is refused (`FINANCE_PERIOD_CHANGED`), not stored. The newest hash chain link of every wallet is stored with the close so it can be copied outside the database (ADR 0094).
4. **The lock.** `FinancePeriodClose` is append-only for every role. A `BEFORE INSERT` trigger on `LedgerEntry` refuses an entry dated before the end of the tenant's latest closed period (one lookup on `(tenant_id, period_end)`). A closed month is never reopened; a late correction is posted in the open month as an ADJUSTMENT, REVERSAL or REFUND (ADR 0100, 0095).
5. **One privileged action, audited.** `finance.period.close` (S3), granted to no role by the migration; reads need `finance.read`. It is a single-person action by design (it posts nothing and changes no balance), recorded as `finance.period.closed` with the month, verdict and per-currency totals. Closing is idempotent by month: a repeat is refused as already closed.

## API
`GET /admin/finance/periods`, `GET /admin/finance/periods/preview?month=YYYY-MM` (writes nothing), `POST /admin/finance/periods/close` with `{ month, note? }`. Contract in `@bedbanks/contracts` (`finance-periods.ts`). Admin screen: Finance, Period close.

## Migration `202612150001_finance_period_close`
Table with CHECKs (month boundaries, verdict, note), append-only trigger, forced row-level security, the lock trigger, one permission. Tenant-index review: `tenant_id` leads both indexes; no foreign-key column lacks one. Classified finance-gated. Rollback is in the migration header (drops the lock and discards the close records, so export them first).

## Risks accepted
- The integrity report and the totals are read in separate transactions. An entry committed between them with an `immutable_at` inside the month would be caught by the totals tie-out only if it changed the closing figure; the grace period and the per-tenant advisory lock on closes (not on postings) narrow this but do not remove it. A transaction open for more than the grace period when the month ends could still commit an entry the trigger then refuses; the poster sees an error and posts it in the open month.
- The lock is on `immutable_at`, which the database sets at insert. A deliberately backdated insert by a database owner is refused by the trigger unless the owner disables it; the hash chain and the stored chain heads are the detection for that.

## Not built
- **Reopening** a closed month (deliberately absent), a **second approver** for the close, and **step-up** on it.
- **R5 stalled-attempt sweep, receivables ageing snapshot and supplier accrual snapshot** are not part of the close record; only the ledger is.
- **Chart of accounts and general-ledger export (R8)**: control totals are by ledger entry type and currency, not by GL account. Needs the owner's chart of accounts and format.
- **Revenue, margin and payable reports** are not period-locked.
- **Scheduled or automatic close.**
- A browser test of the Admin screen.

## Verification
Money package 71 tests (month ranges across a year end, ordering, grace, gate, tie-out and refusal of totals that do not tie). PostgreSQL 16 with pgvector: `finance-period.e2e-spec.ts`, 8 tests (flag, preview, validation, close with totals and chain heads, database lock at the month boundary to the millisecond, immutability, ordering and not-yet-ended, integrity gate). Admin: type-check, lint, 229 tests. Full API unit and finance e2e regressions, `check:architecture`, lint and type-check: see the commit. Not run: CI, strict-runtime-role suites, a browser.
