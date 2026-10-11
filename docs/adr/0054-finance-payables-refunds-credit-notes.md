# ADR 0054: Supplier payables, refunds and credit notes

Status: Proposed. **Not built. Blocked on accounting policy and a restricted write role.**

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
