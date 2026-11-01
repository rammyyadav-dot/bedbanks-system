# Runbook: certify supplier uncertainty handling (timeouts, retries, duplicate prevention, reconciliation)

Certifies the existing supplier-boundary machinery against the four properties required of any supplier mutation
(`PREBOOK`, `BOOK`, `CANCEL`): a bounded, classified timeout; a safe retry policy (reads only, mutations never);
no duplicate supplier call or duplicate booking for one logical request; and a reconciliation sweep that resolves
every attempt whose outcome was never observed, without ever inventing a success or double-releasing a resource.
This is a certification of code already in the repository, not a design proposal — the sections below name the
exact source files and the exact tests run, and record their result. Re-run this runbook whenever the transport,
the mutation journal, or the reconciliation service changes.

## Scope boundary
fBeds only. Certification below ran against a **disposable local PostgreSQL 16** database created for this run
and dropped afterward (`bedbanks_certify`). Nothing here touches a hosted, staging or production database or
credential, and no production migration history was created (`prisma migrate deploy` against a throwaway
database, never `prisma migrate dev` against a shared one).

## What is certified and where it lives

| Property | Mechanism | Source |
|---|---|---|
| Timeout | Per-attempt timeout bounded by a shrinking overall budget; classified as `timeout` vs `transport` vs `provider_unavailable` by response shape, never guessed | `packages/connectors/core/src/xml/xml-transport.ts` (`XmlSupplierTransport.send`, `.once`) |
| Retry | Reads retry once on a transient fault inside the shared time budget; **mutations never retry** and report `not_sent` / `maybe_sent` / `answered` so the caller knows whether the supplier may have acted | `xml-transport.ts` (`maxAttempts = operation.kind === 'read' ? 2 : 1`), `supplier-types.ts` (`SupplierCallError` delivery field) |
| Circuit breaker / concurrency | In-process gate opens after repeated provider failures and refuses new calls without hitting the network | `xml-transport.ts` (`InProcessGate`) |
| Duplicate prevention (outbound) | `SupplierMutation` journal: `prepare()` is a unique-constrained write keyed on `(tenantId, bookingId, operation, idempotencyKey)`; a concurrent or repeated prepare with the same fingerprint returns the existing row, a different fingerprint is refused; only the caller that wins the `PREPARED → SENDING` transition may call the adapter | `apps/api/src/agent/supplier-mutation-journal.service.ts` |
| Duplicate prevention (inbound booking) | Booking creation and ledger HOLD both key off the same idempotency key; the same key sequentially or concurrently produces exactly one booking and one reservation, a reused key against different hold inputs is refused | `apps/api/src/agent/booking-persistence.service.ts`, `apps/api/src/agent/ledger.service.ts` |
| Reconciliation | Sweep over `PROCESSING` holds past a stale threshold: releases orphan holds, waits out an in-window prebook, fails and compensates an expired or rejected one, and marks `manual_review_required` (never silently resolved) for any outcome the journal never observed; every step is a single idempotent claim so a crashed sweep is safe to re-run | `apps/api/src/agent/booking-reconciliation.service.ts` |

## Certification run (2026-10-28)

### 0. Environment
- Database: disposable local PostgreSQL 16 (`postgresql-16-pgvector` extension installed to satisfy the search
  index migration), database `bedbanks_certify`, created and dropped by this run only.
- `npx prisma migrate deploy` — 132/132 migrations applied cleanly to the empty database.
- Branch: `claude/vibrant-ride-oxe3kx`, commit as pushed by this runbook's commit.

### 1. Transport-level timeout, retry and circuit breaker (unit, no network)
```
pnpm --filter @bedbanks/connectors-core test
```
**Result: 85/85 pass**, including the properties below (`packages/connectors/core/test/xml-connector.test.mjs`,
`xml-parser.test.mjs`):
- `a read retries once on a transient fault; a persistent fault surfaces`
- `a mutation is NEVER retried and a lost answer is reported as maybe_sent`
- `timeouts are classified and a mutation timeout is maybe_sent`
- `circuit opens after repeated provider failures and does not call the supplier`
- `a host that resolves to a private address is refused before any request`
- `fetch uses redirect:error and never leaks credentials into events or errors`

### 2. Supplier mutation journal — duplicate prevention at the outbound boundary (unit)
```
npx jest --runInBand supplier-mutation-journal.service.spec.ts
```
**Result: pass** (in-memory Prisma double). Covers idempotent `prepare`, single-winner `markSending`, and
terminal-state transitions (`acknowledge`, `reject`, `markUnknown`, `resolve`) refusing to move backward out of a
terminal state.

### 3. Supplier mutation journal — PostgreSQL-backed (e2e, real unique constraint and RLS)
```
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/bedbanks_certify \
npx jest --config test/jest-e2e.json --runInBand supplier-mutation-journal.e2e-spec.ts
```
**Result: pass.** Named cases include:
- `MUT-05` retains inventory and finance on supplier timeout and does not retry.
- `MUT-11` allows exactly one supplier invocation across 25 concurrent attempts on the same key.
- `MUT-12` repeats reconciliation of an unknown mutation without a second side effect.
- `MUT-13` denies cross-tenant journal reads, reconciliation and direct RLS access.
- `MUT-14` does not expire a processing hold tied to an unresolved supplier mutation.
- `MUT-15` refuses confirmation while the mutation is unknown.
- `MUT-01/02/03/10` — a crash before, during, or just after sending never calls the supplier twice and never
  silently resolves an uncertain outcome.

### 4. Duplicate booking / idempotency proofs and ledger correctness under failure (e2e)
```
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/bedbanks_certify \
npx jest --config test/jest-e2e.json --runInBand booking-failure-ledger-proof.e2e-spec.ts
```
**Result: pass.** Named cases include:
- `DUP-1` the same idempotency key sequentially reserves once and returns the same booking.
- `DUP-2` ten simultaneous prebooks with one key produce one booking and one reservation.
- `DUP-3` one key reused for a different hold is refused and moves no money.
- `FAIL-1` a definitive supplier rejection nets the account to zero (HOLD then RELEASE only).
- `FAIL-2` an unobserved supplier outcome keeps the reservation and a retry does not reserve twice.
- `ROLL-FORWARD` the ledger integrity run balances with nothing critical outstanding.

### 5. Reconciliation sweep (e2e, real stale-hold detection and race against confirmation)
```
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/bedbanks_certify \
npx jest --config test/jest-e2e.json --runInBand booking-reconciliation.e2e-spec.ts
```
**Result: pass.** Named cases include:
- returns wallet and inventory of a crashed attempt exactly once, fails the booking, and is idempotent.
- never releases a booking whose supplier prebook succeeded, and recovers one whose prebook failed.
- expires a prebooked-but-never-confirmed booking after the window, and confirmation then refuses.
- a confirmation racing the expiry has exactly one winner and never refunds a confirmed booking.
- retains inventory when supplier prebook times out, and repeated reconciliation stays a manual review.
- confirms from the durable supplier reference when the success audit is missing.

### 6. Adjacent coverage run for completeness (e2e)
```
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/bedbanks_certify \
npx jest --config test/jest-e2e.json --runInBand booking-supplier.e2e-spec.ts finance-reconciliation.e2e-spec.ts bank-reconciliation.e2e-spec.ts
```
**Result: pass** (39 tests) — the supplier-facing booking lifecycle and the separate finance/bank reconciliation
runners, which consume the same "never invent a success, always leave an auditable exception" discipline.

### 7. Unit suites for the orchestration and compensation paths that call the journal (unit)
```
npx jest --runInBand supplier-prebook-orchestration.service.spec.ts prebook-compensation-recovery.service.spec.ts \
  xml-booking-supplier.spec.ts aggregating-supplier.adapter.spec.ts contracted-inventory.adapter.prebook.spec.ts \
  supplier.port.spec.ts hold-expiry-sweeper.service.spec.ts
```
**Result: pass** (88 tests). Logged `ERROR` lines in this run are the suites' own fault-injection assertions
(a mocked ledger or journal failure that the code is proven to handle), not failures of the run.

## Gaps found
None in the covered properties. Every timeout, retry, duplicate and reconciliation path named above has a
passing, PostgreSQL-backed or unit test that exercises it by name. The in-process gate (`InProcessGate`) is
explicitly documented as not coordinating multiple worker processes sharing a credential — if this deployment
runs the API as more than one process against the same supplier credential, a shared (e.g. Redis-backed) gate
is required before the circuit-breaker and concurrency-limit property can be certified across processes; this
runbook did not test that configuration because none exists in this repository yet.

## Evidence record
| Item | Value |
|---|---|
| Date | 2026-10-28 |
| Database | disposable local PostgreSQL 16, `bedbanks_certify`, dropped after the run |
| Migrations applied | 132/132, clean |
| `@bedbanks/connectors-core` unit tests | 85/85 pass |
| Supplier mutation journal (unit + e2e) | pass |
| Duplicate/idempotency proofs (`booking-failure-ledger-proof.e2e-spec.ts`) | pass |
| Reconciliation sweep (`booking-reconciliation.e2e-spec.ts`) | pass |
| Adjacent booking/finance/bank reconciliation suites | pass (39 tests) |
| Orchestration/compensation/adapter unit suites | pass (88 tests) |
| Verdict | CERTIFIED for the single-process deployment this repository currently has. Re-certify the circuit breaker specifically before running more than one API process against a shared supplier credential. |
