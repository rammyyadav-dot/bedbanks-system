# Finance proof: failed and duplicate bookings (2026-10-27)

Question: can a failed or duplicate booking leave an incorrect financial entry? Method: re-ran the finance e2e suites on PostgreSQL 16
(all 202610 to 202612 migrations applied), then added `apps/api/test/booking-failure-ledger-proof.e2e-spec.ts`, which drives the real
prebook, confirm, reconcile and integrity services and asserts the exact ledger entries, the finance sub-ledgers and the R1 to R4 report.

| Case | Proven outcome |
|---|---|
| FAIL-1 supplier definitively rejects | `HOLD -X`, `RELEASE +X`; account net unchanged; no finance event, posting, supplier payable, document or credit note; a repeat attempt adds nothing |
| FAIL-2 supplier outcome unknown (timeout) | `HOLD -X` kept, never released, never charged; supplier not called again on retry; confirm refused; repeated reconciliation stays manual review; integrity report: warning only once stale, never critical |
| DUP-1 same idempotency key, sequential | one booking, one HOLD; after confirm replays, exactly `HOLD, RELEASE, DEBIT` |
| DUP-2 ten simultaneous prebooks, one key | one booking, one HOLD |
| DUP-3 one key reused for another hold | refused; no money moved |
| CREDIT-1 credit line | one minor unit short: refused at prebook with no entry and inventory returned; exact fit passes; five concurrent bookings on exhausted credit all refused; two racing for credit that covers one: exactly one reserves; the early hold check refuses too |
| ROLL-FORWARD | per-currency balance = entries = funding + credits + refunds - charges - open reservations; charges = price x CONFIRMED bookings; every DEBIT belongs to a CONFIRMED booking; FAILED or PENDING_SUPPLIER bookings have no sub-ledger rows |

Sensitivity: with `release()` made a no-op, FAIL-1 fails (the stranded reservation is caught); restored afterwards.

Already covered elsewhere and re-run green (19 suites, 155 tests): refunds and cancellation settlement, credit notes, supplier payables
and settlement, invoice documents, bank and supplier statement reconciliation, funding maker-checker, ledger hash chain and database guards.

## Not proven here (open, from the operating model)
- The nightly run (`LedgerIntegrityMonitor`) was not exercised on a schedule or with its read-only login; only the report it calls.
- Supplier payable and invoice numbering for failed bookings is proven absent; gapless numbering, ADJUSTMENT/REVERSAL kinds, refunds to bank,
  GL export and period close remain PROPOSED (operating model sections 3, 9, 11).
- Not run: browser, CI, the full e2e suite (only finance scope).
