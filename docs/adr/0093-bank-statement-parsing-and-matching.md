# ADR 0093: Bank statement parsing and matching (R6, first slice)

Status: **Built: pure parsers and matcher in `@bedbanks/money`. Not wired: no endpoint, table, worker or UI yet.**

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

## Not decided here (needs the owner, and a reviewed migration)
- Persistence: a `BankStatement` / `BankStatementEntry` / `BankMatchFinding` set of tables with tenant RLS, a content hash for idempotent import,
  and the exception workflow reused from ADR 0070. Rollback is dropping the tables. No migration is included in this change.
- The ingestion worker, a `finance.reconcile.run`-guarded import endpoint and the contract in `@bedbanks/contracts` (invariant 4).
- Which bank accounts belong to which tenant and currency, and who may release an unmatched credit from suspense.
- Electronic remittance advice (ERA) per supplier: formats differ by supplier and none is in scope yet.

## Tests
`packages/money/bank-statement.test.ts` and `bank-matching.test.ts`: balance integrity, reversals, bad dates and amounts, XXE refusal,
pending entries, CSV quoting, whole-token matching, duplicates, ambiguity, suspense totals and period handling.
