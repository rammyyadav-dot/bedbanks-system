# ADR 0070: Supplier statement reconciliation and the dispute queue

Status: **Built (matching engine, background worker, dispute queue, dedicated database role). Behind `FINANCE_RECONCILIATION_ENABLED`; posting to the ledger and supplier payment are deliberately not built.**

## Finding
ADR 0054 left supplier payables as a read-only accrual: the system could say what confirmed stays *cost*, but had no record of what a supplier *invoiced*, no comparison of the two, and no place for finance to decide a difference. ADR 0062 listed "a reconciliation report built on the shared functions" as next. This ADR builds the comparison and the decision workflow. It does not build payment, posting or FX.

## Decision

### 1. One pure matching engine (`@bedbanks/money`, `reconciliation.ts`)
Integer minor units as bigint, no I/O, no clock, no framework (invariants 3 and 9). A supplier statement line is matched to a booking-level ledger item by **booking reference** (our reference or the supplier's own; case and surrounding space ignored, nothing fuzzy) and then by **exact net amount**. Everything else is a typed finding:

| Finding | Meaning |
|---|---|
| `MATCHED`, `CREDIT_MATCHED` | exact reference and exact net / expected credit. Closed by the engine; no person involved |
| `ROUNDING_VARIANCE` | same currency, difference up to the run's rounding tolerance (default 0: exact only; maximum 1000 minor units) |
| `AMOUNT_OVERCHARGE`, `AMOUNT_UNDERCHARGE` | same currency, difference beyond tolerance; variance is statement minus ledger |
| `CURRENCY_MISMATCH` | statement and booking currencies differ. **No variance is computed and nothing is converted** (ADR 0029: there is no FX conversion in the platform) |
| `UNINVOICED_SURCHARGE` | a `SURCHARGE` line. Net rates are all-inclusive (ADR 0029), so a surcharge is never auto-matched |
| `UNMATCHED_LINE`, `AMBIGUOUS_REFERENCE`, `DUPLICATE_LINE` | no booking, more than one booking, or the same reference/kind/currency/amount twice |
| `NET_UNKNOWN` | the booking has no recorded net. Unknown is never compared as zero |
| `CHARGE_ON_CANCELLED` | the supplier charged a cancelled booking |
| `CREDIT_VARIANCE`, `CREDIT_WITHOUT_CANCELLATION`, `CREDIT_AMOUNT_UNKNOWN` | automated credit-note settlement: a `CREDIT` line is matched to a cancelled booking's expected credit |
| `MISSING_FROM_STATEMENT` | a payable booking with check-out in the statement period that the supplier did not invoice |
| `CREDIT_NOT_RECEIVED` | a cancelled booking an earlier statement already charged, whose expected credit is not on this one |

The expected supplier credit of a cancelled booking is derived **only** when its `CANCELLED` finance event records a zero penalty and the net is known (the whole net is expected back). Any penalty makes the supplier-side amount unknown, because the supplier's own penalty is not recorded anywhere; it then stays null and raises `CREDIT_AMOUNT_UNKNOWN` rather than an assumption.

Settlement summary is per currency (charges, credits, statement net, matched, exceptions) and currencies are never added.

### 2. Statements are immutable evidence; findings are a workflow
`SupplierStatement` and `SupplierStatementLine` are inserted once and never change (database trigger). `content_sha256` (over period and order-independent canonical lines) stops the same statement being imported under another number. Import and run requests are idempotent on `requestId`. Amounts arrive as major-unit decimal **strings** (a JSON number is refused) and are converted server-side with the currency exponent; extra decimals are refused.

`ReconciliationFinding` is one row per statement line (plus ledger-side gaps), unique per `(tenant, statement, finding_key)`, so a re-run updates and never duplicates. A re-run keeps a dispute and a pending decision whose facts did not change, reopens a decision pending a second person if its facts changed, and closes a difference that disappeared (`AUTO_MATCHED`). A `RESOLVED` finding never changes again (trigger). `ReconciliationDecision` is append-only history.

### 3. The dispute queue and maker-checker
`OPEN → DISPUTED | PENDING_APPROVAL → RESOLVED`. Decisions: accept the statement amount, keep our figure and dispute, write off a variance, reject a statement line, acknowledge. Which are offered depends on the finding type (`EXCEPTION_RULES`).

* Disputing and acknowledging move nothing and need no second person.
* Accepting or writing off puts the **variance** at stake; rejecting a line puts the **whole statement amount** at stake; an unknown amount is treated as unbounded. At or above **100 currency units** (exponent-aware: 10,000 minor for AED, 100 for JPY, 100,000 for KWD) the decision waits for a **different person**. Enforced in the service, by conditional update, and by a database CHECK (`ReconciliationFinding_second_person`).
* Permissions are three and none implies another: `finance.read` (queue and statements), `finance.reconcile.run` (S2: import a statement, request a run), `finance.reconcile.resolve` (S3: propose, approve, send back). All are formal role assignments (not implied by owner membership).

**Recording a decision posts nothing.** No `LedgerEntry`, `Wallet`, booking or payable is written by this module (`pnpm check:ledger-single-writer` still holds; the e2e suites assert zero ledger rows). A resolved exception is an audited statement of intent for finance to act on.

### 4. The background worker: why a Postgres run table and not BullMQ or Temporal
The repository has no job queue and no Redis job infrastructure (Redis is a static-content cache, ADR 0064). A second queue would add an unreviewed dependency and a second source of truth for "did this run happen". The run table is already the durable, tenant-isolated, audited queue: the API inserts `QUEUED`; the worker claims with a conditional update on the exact status and attempt count it read, so concurrent workers cannot both win; an abandoned `RUNNING` claim (older than ten minutes) is re-driven; after three attempts the run is `FAILED` with a stable `error_code` (never a raw message). Tenants with work are found through a `SECURITY DEFINER` function that returns ids only. The pattern is the existing sweepers' (ADR 0005, ADR 0057). **If volume or scheduling needs outgrow this** (per-supplier schedules, fan-out across many statements, long-running multi-step flows), Temporal is the right next step, behind the same `ReconciliationRunner` interface; nothing here prevents it.

The worker is off unless `FINANCE_RECONCILIATION_WORKER_ENABLED=true` (and the feature flag). A run is also kicked right after it is requested.

### 5. A dedicated restricted database role (ADR 0054 requirement)
`fbeds_recon_ops` (group `fbeds_recon`): read and append the five tables; update only workflow columns of runs and findings; read exactly ten named `Booking` columns, three `BookingFinanceEvent` columns and `Supplier.display_name`; insert audit events (not read them); execute the tenant-listing function. It cannot touch `LedgerEntry`, `Wallet`, a statement after import, guest data, credentials or the audit log's contents. `pnpm ops:provision-reconciliation-role` provisions it; `pnpm ops:verify-reconciliation-role` certifies it as the role itself (catalogue checks plus 29 `WHERE false` probes). `ReconciliationStore` connects with `FINANCE_RECONCILIATION_DATABASE_URL` and **never falls back** when it is configured; unset, it uses the HTTP client like the other finance-gated paths (a strict runtime login is then refused by the database itself).

Worker and run audit events are attributed to the **requesting user**, not a `SYSTEM` actor, because ordinary roles may not insert `SYSTEM` audit events (migration 202609180002). Audit payloads hold ids, amounts as strings and counts only; decision reasons live in `ReconciliationDecision`, never in the audit payload.

## Owner decisions this ADR assumes (change them here, not in code)
1. **Second-person threshold: 100 currency units**, any currency. Funding (ADR 0028) uses AED 10,000 for a different risk; this one is about accepting supplier variance. Needs confirmation.
2. **Default rounding tolerance 0**; an operator may choose up to 1000 minor units per run. A larger default is a policy choice, not a code default.
3. **Statement period is matched on check-out date.** If suppliers statement by booking date or by stay start, `MISSING_FROM_STATEMENT` scope changes (one query in `ledger-items.ts`).
4. **Bookings without a supplier organization** (connector and manual bookings, ADR 0061) are out of scope until they are attributed.
5. **Expected supplier credit** is derived only for zero-penalty cancellations (see above).

## Not built (and why this is not "100%")
* **Posting.** No ledger entry, payable, supplier payment, write-off journal or credit-note document is created. ADR 0054 still requires a chart of accounts, settlement-currency rules and a decision on whether refunds move money. Resolved exceptions are the *input* to that step.
* **FX variance adjustment.** A currency mismatch is surfaced and decided by a person; no rate source or revaluation policy exists (ADR 0029).
* **Automated statement ingestion** (supplier API/SFTP/email). Import is pasted text through the Admin screen or JSON through the API.
* **Manual re-link** of an unmatched line to a booking (the commonest fix for a typo'd reference) and **bulk decisions**.
* **Aging and notifications** (SLA on open disputes, escalation, supplier-facing dispute letters).
* **Nightly check** that the ledger sum equals the reconciliation figures per account (ADR 0062 "next").

## Verified
Against a real PostgreSQL 16 with pgvector: the full migration chain applies; `prisma migrate diff` shows no drift for the new objects; constraint, trigger, RLS and cross-tenant foreign-key behaviour exercised directly; 23 Jest e2e tests (service level, HTTP level with real guards and sessions, and the whole workflow under the narrow role, including fail-closed); 32 API unit tests, 21 money-engine tests, 7 Admin tests; `check:architecture`, type-check and lint. **Not run:** the production strict-runtime-role e2e suite in CI (`pnpm --filter @bedbanks/e2e e2e`) and a hosted database; the `SECURITY DEFINER` function relies on the migration owner bypassing forced RLS (true locally; confirm in CI as for the compliance functions).

## Rollback
Forward migration `202611220001_supplier_statement_reconciliation`; its header holds the drop order. It discards imported statements and the dispute history, so export them first. Disabling is non-destructive: unset `FINANCE_RECONCILIATION_ENABLED` (writes answer 503, reads keep working where the role holds the tables) and `FINANCE_RECONCILIATION_WORKER_ENABLED`.
