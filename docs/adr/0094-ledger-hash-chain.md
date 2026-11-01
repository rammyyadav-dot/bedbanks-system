# ADR 0094: Tamper-evident ledger (per-wallet hash chain)

Status: **Built. Written by the database, verified by the daily ledger integrity run. Not built: tax-jurisdiction reports (needs your rules), external anchoring of chain heads (operator step).**

## Finding
`LedgerEntry` is append-only by trigger (ADR 0069), and every role except the owner is blocked by privileges as well. A database owner, a restored backup or a disabled trigger can still change a
balance without leaving a trace. Constitution invariant 8 asks for immutable audit of financial mutations; "immutable" so far meant "the application never edits". This ADR makes an edit,
a deletion or an insertion behind the application's back **detectable**. It does not make it impossible; no database-level control can.

## Decision
1. **A chain per wallet.** Table `LedgerChainLink` (tenant, wallet, entry, `seq` from 1, `prev_hash`, `entry_hash`). The first link's `prev_hash` is 64 zeros.
2. **The database writes it.** An `AFTER INSERT` trigger on `LedgerEntry` (`fbeds_ledger_chain_append`, `SECURITY DEFINER`) appends the link in the same transaction as the entry, so a rolled-back entry leaves no link and
   a committed entry always has one. No role holds INSERT, UPDATE or DELETE on the chain (`LedgerChainLink` is classified finance-gated in the runtime-role contract), so an application bug or a narrow role cannot forge a link.
   Application code did not change: `appendLedgerEntry` is still the only writer of the ledger (`check:ledger-single-writer`).
3. **One hash formula, in one place.** `entry_hash` = lower-hex SHA-256 of the UTF-8 text
   `prev_hash|id|tenant_id|wallet_id|type|amount_minor|currency|reference ('' when null)|idempotency_key|immutable_at`, `immutable_at` as `YYYY-MM-DDTHH:MM:SS.mmmZ` (UTC, milliseconds). It lives in `fbeds_ledger_chain_hash`.
   An independent auditor can recompute it with any SHA-256 tool; the e2e test does exactly that in Node.
4. **Concurrency.** The trigger takes `FOR NO KEY UPDATE` on the entry's `Wallet` row before reading the last link. That is the same row the booking and cancellation paths already lock, so the lock order cannot invert
   (an advisory lock would have), two writers on one wallet wait only for the instant of the append, and different wallets never wait on each other. `NO KEY UPDATE` is used because the foreign key already holds
   `KEY SHARE` on the wallet; a stronger lock there would deadlock two concurrent inserters. Test: 60 simultaneous mixed postings (credits, holds and releases, debits with partial refunds) over four wallets, one transaction each:
   all chains contiguous and valid.
5. **Verification.** `fbeds_ledger_chain_breaks()` (current tenant only) recomputes every link against the live entry and returns one row per fault: `SEQUENCE_GAP`, `PREV_HASH_MISMATCH`, `ENTRY_MISSING`, `ENTRY_HASH_MISMATCH`, `ENTRY_UNCHAINED`.
   `checkLedgerIntegrity` (`@bedbanks/money`) turns each into a **critical** finding, `LEDGER_CHAIN_BROKEN` or `LEDGER_CHAIN_ENTRY_UNCHAINED`, so the existing daily monitor (ADR 0069) alarms on it and the report verdict is `ISSUES`.
   The report also returns each wallet's newest link (`chainHeads`).
6. **Backfill.** The migration chains all existing entries in `(immutable_at, id)` order. The chain therefore attests the ledger **from the migration onward**: a change made before it is not detectable. Run the ledger
   integrity report before applying it and keep the output (it must be CLEAN). Tested by applying the migration to a database that already held entries in two tenants: all chained, no faults.

## Limits, stated plainly
- **Tail truncation.** Someone with owner access who removes a wallet's newest links *and* entries together leaves a shorter, internally valid chain. Only a head hash stored outside the database catches it.
  The report publishes `chainHeads`; **copying them somewhere the database owner cannot write (a WORM bucket, a signed daily email to Finance) is an operator step that is not automated here.**
- **A rewritten chain.** An owner who recomputes every later link after an edit produces a valid chain. The external heads catch that too. Until they are stored, this control detects careless or partial tampering, not a determined owner.
- **Erasure switch.** The existing owner-governed `fbeds.ledger_erasure` setting also permits deleting links (used by disposable test tenants and by retention erasure). Any use should be paired with an audit record.
- **Read cost.** The verifier reads the tenant's whole chain. It runs only when the integrity scan is not capped, so it is bounded by the same 50,000-entry limit as the rest of the report.

## Operator steps
1. Run the ledger integrity report; it must be CLEAN. Apply migration `202612090001_ledger_hash_chain` (rollback notes are in its header; it discards the chain, not the ledger).
2. Grant the integrity monitor's login `EXECUTE` on `fbeds_ledger_chain_breaks()` and `fbeds_ledger_chain_heads()`. Neither function is granted to any role by the migration. Without the grant the report fails closed (503) rather than reporting a clean chain.
3. Store `chainHeads` outside the database on a schedule.

## What this ADR does not cover
- **Other audit events.** `AuditEvent` rows are not chained; only the ledger is. Chaining audit events would serialise every audit insert in the transaction that writes it, which needs its own design.
- **Tax reporting (GST/VAT).** Not built. Net rates are tax-inclusive and the platform records no tax lines (ADR 0054); a compliant report needs, per jurisdiction, the tax registration, the rate and treatment rules, the invoice numbering rule and the filing format. Provide those and it can be built on the booking finance events.
- **FX gain and loss, double-entry.** Unchanged: ADR 0029 forbids FX in money paths and a chart of accounts is still an open decision.
