# ADR 0093: Bank statement parsing and matching (R6, first slice)

Status: **Built: pure parsers and matcher (`@bedbanks/money`), tables with RLS and immutability triggers, import and exception endpoints, narrow-role grants. Behind `FINANCE_RECONCILIATION_ENABLED`. No UI, no scheduled or automatic bank feed, no ERA, no ledger posting.**

## Finding
The operating model lists R6 (receipts and supplier payments to the bank statement) as PROPOSED and says it needs a statement format. Supplier
invoice statements are already matched and queued (ADR 0070) and supplier settlements are recorded (ADR 0077), but nothing reads what the bank
actually moved. Finance has been told the formats are MT940, camt.053 and CSV.

## Decision
1. `bank-statement.ts` parses MT940, camt.053 and a strict CSV into one canonical `ParsedBankStatement`. Integer minor units as bigint; the
   currency exponent comes from `minorUnitExponent`; no float, no thousands separators, no extra fraction digits.
2. It fails closed with stable `BankStatementError` codes whose messages never echo statement content (account numbers and remittance text are
   personal data). MT940 and camt.053 statements must satisfy `opening + movements = closing` or are refused (`BALANCE_MISMATCH`). CSV has no
   balances, so that check does not apply to it.
3. camt.053 uses a small in-house reader. A `DOCTYPE` or `ENTITY` anywhere refuses the file, which removes external-entity and entity-expansion
   attacks; nesting depth, file size (10 MB) and entry count (50,000) are capped. Only booked entries are read.
4. `bank-matching.ts` matches movements to expected payments (supplier settlements are money out, funding receipts are money in) by an exact
   reference **token**, then exact direction, currency and amount. A reference inside a longer token never matches, references shorter than 6
   characters never match, and a payment is consumed by one clean match only. Everything else is a typed finding: `AMOUNT_MISMATCH`,
   `CURRENCY_MISMATCH` (no variance computed, nothing converted, ADR 0029), `DIRECTION_MISMATCH`, `AMBIGUOUS_REFERENCE`, `DUPLICATE_ENTRY`,
   `DUPLICATE_PAYMENT`, `UNMATCHED_ENTRY` (the suspense list) and `EXPECTED_NOT_ON_STATEMENT`.
5. The matcher classifies only. It posts nothing, pays nothing and edits nothing, in line with P8 (a break is a finding, never auto-corrected).

## Persistence and API (migration `202612080001_bank_statement_reconciliation`)
- `BankStatement`, `BankStatementEntry`, `BankMatchFinding`: tenant-led indexes, composite tenant foreign keys, forced RLS. A statement and its entries are immutable by trigger. A finding's facts
  are immutable; only `OPEN -> RESOLVED` is allowed, once, and nothing is ever deleted. CHECK constraints enforce positive minor units, ISO currency, `variance = bank - expected`, and that
  the closer is not the importer.
- Privacy: the account number is kept only as `SHA-256(tenant | account)` and its last four characters. No remittance text, payer name or raw file is stored. Statement content is not
  written to logs or errors.
- Import is synchronous: parse, match and write happen in ONE tenant transaction (statement, entries, findings, audit event). Matching is in-memory and bounded, so there is no queue.
  Idempotent on `requestId`; the same content under another `requestId` or number is refused (`BANK_STATEMENT_DUPLICATE_CONTENT`); a reused `requestId` with other content is `BANK_REQUEST_REUSED`.
- Expected payments: APPROVED `SupplierSettlement` (money out) and DECLARED / VERIFIED / POSTED `FundingReceipt` (money in), loaded for the statement period plus or minus 60 days. More than
  20,000 in that window is refused (`BANK_EXPECTED_SET_TOO_LARGE`) rather than truncated. A payment already matched by an earlier statement counts as consumed.
- Narrow role (`fbeds_recon_ops`): INSERT on the three tables, UPDATE only of the resolution columns, column-level SELECT of settlement reference, amount, date and status. The role
  keeps **no** grant on `FundingReceipt` (an existing test forbids it); receipts are read through the tenant-filtered `SECURITY DEFINER` function `fbeds_bank_expected_receipts`, which returns
  reference, amount, currency, value date and status only. **Operator step: re-run the role provisioning after this migration** (`provision-reconciliation-role`), then `verify-reconciliation-role`.
- API (`/admin/finance/bank-reconciliation`): `GET statements`, `GET statements/:id`, `GET exceptions` need `finance.read`; `POST statements` needs `finance.reconcile.run`;
  `POST exceptions/:id/resolve` needs `finance.reconcile.resolve` and a different person than the importer. Resolutions are `EXPLAINED`, `BANK_CORRECTION_REQUESTED`,
  `INTERNAL_CORRECTION_REQUESTED`: statements of what was done elsewhere. Nothing posts to `LedgerEntry` or `Wallet`.

## Not built (needs the owner, or its own change)
- A UI for the queue, and an automatic bank feed or SFTP pull. Today a person uploads the file.
- Electronic remittance advice (ERA): formats differ by supplier and none is chosen.
- Which bank accounts belong to which tenant and currency (any account in a file is accepted for the tenant that imports it), and the suspense process for an unmatched credit.
- Posting anything from a finding (for example a bank fee, or an unidentified credit) to the ledger: needs ADJUSTMENT / REVERSAL entry kinds and a chart of accounts (operating model section 11).
- Re-matching an old statement after a payment is recorded later. Matching happens once, at import.
- Currencies outside the platform's supported exponent table are refused (`BANK_STATEMENT_UNSUPPORTED_CURRENCY`).

## Tests
- `packages/money`: `bank-statement.test.ts`, `bank-matching.test.ts` (parsers: balance integrity, reversals, bad dates and amounts, XXE refusal, pending entries, CSV quoting; matcher: whole-token matching, duplicates, ambiguity, suspense totals, period handling, earlier-statement consumption).
- `apps/api/src/finance-reconciliation/bank-import.spec.ts`: validation, account hashing, content hash, stable 422 codes, contract parity.
- PostgreSQL: `test/bank-reconciliation.e2e-spec.ts` (import, idempotency, duplicates, immutability, tenant isolation, separation of duties, ledger untouched) and `ROLE-BANK` in `test/finance-reconciliation-role.e2e-spec.ts` (the same flow as the narrow login, plus role certification).
