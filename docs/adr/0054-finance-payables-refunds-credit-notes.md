# ADR 0054: Supplier payables, refunds and credit notes

Status: **Slice 1 (read-only supplier payables accrual) and slice 2 (read-only refund register) built.** Refunds, credit notes and any payables write remain Proposed and blocked on accounting policy and a restricted write role.

## Slice 1 as built
`GET /admin/operations/supplier-payables` (permission `finance.read`, tenant RLS) and page `/finance/payables`: per supplier and currency, the count of CONFIRMED/CHECKED_OUT bookings and the sum of recorded `net_minor`. Bookings with an unknown net are counted separately and excluded, never treated as zero; currencies are never added; cancelled bookings and cancellation penalties are not included. It is an **accrual of recorded cost, not an amount owed**: no supplier invoice, payment or settlement record exists. It posts nothing, adds no table, grant or role, and enables no payment. Under the ordinary API runtime role booking rows are not readable, so the endpoint answers with the explicit `OPERATIONS_READ_DENIED` error rather than an empty list. Verified: Postgres e2e `SUPPLIER-PAYABLES` (403/401, totals, unknown-net handling, cancelled excluded, tenant isolation) and the runtime-role test above. Not run: browser, CI.

## Finding
Receivables, wallets, the ledger and funding receipts exist for reading. By design the ordinary API runtime role has no finance write grants beyond the existing paths (ADR 0042 records that no wallet or ledger grant is given to unrelated roles). Payables, refunds and credit notes are listed `planned` in the contract.

## Requirements the design must meet
- Ledger-backed: every movement is an append-only `LedgerEntry` pair in integer minor units with an ISO-4217 currency (invariant 3). Settled history is never rewritten; corrections are reversing entries with a reason.
- Idempotent and audited (invariants 6, 8). Refund and credit-note issue are maker-checker (S3).
- A refund references the original booking snapshot and cannot exceed the amount received for it, enforced in the transaction, not the UI.
- A credit note is a ledger document with its own numbering; payables derive from supplier-confirmed bookings and supplier settlement terms.
- Writes go through a dedicated restricted database role with forced RLS, provisioned like the tenant-control role, with live identity checks and no fallback principal.

## Decisions needed
Chart of accounts and settlement-currency rules (AED only today, ADR 0029); numbering and tax treatment of credit notes; who may approve, and thresholds; supplier payment terms source (no contract field today); whether refunds move money or only post ledger entries (no payment provider is enabled and none may be enabled by this change).
Needs a reviewed migration with rollback notes, the role provisioning CLI, strict-role e2e and cross-tenant negative tests. Not started: none of those can be validated without a Postgres server.

## Slice 2 as built: refund register
Refunds already exist: the cancellation flow posts `REFUND` entries to the agency wallet ledger. `/finance/refunds` is the existing ledger endpoint filtered to `type=REFUND` (finance.read, tenant RLS), read-only. It issues no refund, creates no document and adds no write path, schema or grant. A manual or goodwill refund, and credit notes, are **not built**.

## Why credit notes are still not built
A credit note is a numbered accounting document. Building it requires choices that are policy, not engineering: the numbering scheme and whether it may have gaps, tax lines (net rates are all-inclusive today, ADR 0029), who may approve and up to what amount, and whether it is tied to a ledger reversal. Inventing those would present an unreviewed accounting document as a production capability (invariant 10). Proposed default for approval, if you accept it: per-tenant gapless sequence `CN-<year>-<n>` allocated inside the issuing transaction; no tax lines; every credit note maker-checker (two different `finance` users) regardless of amount; a credit note posts a reversing `REFUND` ledger entry in the same transaction and is itself immutable; issued only through a dedicated restricted role like ADR 0042. Nothing in this paragraph is implemented.
