# ADR 0103: General-ledger journal CSV export

Status: accepted for build. No feature flag: it only reads, and the permission gates it. Closes the "file export" item of ADR 0102.

## Decision
1. **A file of a closed month's journal.** `GET /admin/finance/journal/export?month=YYYY-MM&kind=lines|totals` returns a UTF-8 CSV (BOM, CRLF) download. `lines` is one row per journal line, each a balanced debit and credit of the same amount, numbered from 1 within a currency, with the mapping version used. `totals` is one row per currency and account with its debit and credit totals. One file holds all currencies, one currency per row; currencies are never converted or added.
2. **Exact amounts.** Each amount appears twice: in major units as a plain decimal built from the currency exponent with integer arithmetic (no float anywhere), and as integer minor units. A currency outside the platform's exponent table is refused rather than guessed.
3. **Formula-safe cells.** A cell starting with `=`, `+`, `-`, `@`, tab or carriage return is prefixed with an apostrophe, and a cell with a quote, comma or line break is quoted, so an account name cannot execute in an accountant's spreadsheet (the rule the hotel and compliance exports use).
4. **Only a complete journal leaves the building.** The export is refused (409 `FINANCE_CHART_JOURNAL_NOT_EXPORTABLE`, with the problems listed) if any entry could not be categorised, debits differ from credits in any currency, or the totals no longer tie to those recorded at period close. A month that is not closed, or a chart with an unmapped category, is refused as for the journal itself.
5. **Permission and audit.** `finance.journal.export` (S2), granted to no role by the migration `202612170001_journal_export_permission`. Each download writes `finance.journal.exported` with the month, kind, row count, mapping versions, suspense entry count, request id and the SHA-256 of the exact file; the event is written before the file is returned. The hash is also in the `X-Journal-Sha256` response header so the recipient can verify what they received. Responses are `private, no-store`.

## Not built
- **A specific accounting package format** (a vendor import layout, XBRL, SAP/NetSuite/QuickBooks columns). The columns are generic and documented in `@bedbanks/money` (`JOURNAL_LINES_COLUMNS`, `JOURNAL_TOTALS_COLUMNS`); a vendor layout needs the accountants to name the target.
- **Posting to an accounting system**, scheduled or emailed exports, and frozen (stored) files: the file is recomputed on each download from the locked month with the current mapping, so after a mapping change a re-download differs; the audit events keep each earlier file's hash and mapping versions.
- Export of an open month, and of revenue, supplier cost, margin or VAT (no such accounts exist, ADR 0102).
- Streaming for very large months: the journal is aggregated, so the file is small (rows = currencies x categories), but the month itself is capped at 500,000 entries (ADR 0102).
- A browser test of the download.

## Verification
Money package 83 tests (exponent 0, 2 and 3, negative and 18 digit amounts, unsupported currency, hostile cells, quoting, BOM and CRLF, per-currency line numbers, mapping version, empty journal). PostgreSQL 16: `finance-chart.e2e-spec.ts` 11 tests including the export (exact rows after a mapping change, the audit hash equals the SHA-256 of the returned file, an invalid kind, an open month) and the refusal when the journal no longer ties to the close record, which writes no audit event. Admin: type-check, lint, 229 tests. Not run: CI, a browser, the response header through the deployed proxy.
