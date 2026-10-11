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

## Credit notes: correction to the earlier proposal (slice 3 built)
The earlier proposal (a new per-tenant gapless `CN-<year>-<n>` sequence, a second approver on every credit note, a reversing ledger entry, a dedicated issuing role) was written without noticing that **credit notes already exist**. The booking document service issues a `CREDIT_NOTE` booking document for a cancelled booking: frozen at issue (a database trigger rejects edits), unique per booking and per `(tenant, number)`, numbered `CN-<booking reference>`, permission `booking.documents.issue`; the refund ledger entry is posted by the cancellation flow itself, and penalty waivers already need a second person (`booking.penalty.waive.approve`, never the requester). Building the proposal as written would create a second, competing credit-note source of truth next to it, and would renumber or duplicate documents that already exist. It was therefore **not built**.

What was built instead (slice 3): a read-only **credit note register** at `/finance/credit-notes` (`GET /admin/operations/credit-notes`, finance.read, tenant RLS) listing issued credit notes with number, booking, total, penalty kept and amount credited, read from the frozen payload. An amount the payload does not hold is shown as unknown, never zero. It issues nothing.

## Still undecided: changes to the existing scheme
Each of these would change documents or flows that already exist, so each needs an explicit decision before any code:
1. **Gapless yearly numbering** (`CN-<year>-<n>`) instead of `CN-<booking reference>`. Needed only if a jurisdiction requires gapless credit-note numbers. It affects every issued document and its unique key, so it needs a migration plan for existing numbers.
2. **Two-person issue** of every credit note (today only a penalty waiver needs a second person).
3. **Tax lines** (net rates are all-inclusive, ADR 0029).
4. **Manual or goodwill refunds** that are not tied to a cancellation. They would need a restricted write role as in ADR 0042.
