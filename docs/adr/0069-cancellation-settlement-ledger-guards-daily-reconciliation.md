# ADR 0069: Cancellation settlement, database ledger guards and daily reconciliation

Status: **Built.** Resolves the three decisions ADR 0068 left open (audit findings F3 and F4, and scheduling). The owner's instruction was to
decide them "as per global bedbanks workflow and functioning"; each decision below states the bedbank practice it follows.
Migration `202611210001_ledger_integrity_guards` applied only to disposable local databases.

## 1. Cancellation settlement (F3)

**Bedbank practice.** When a booking is cancelled, the client account is credited automatically with the booking amount less the
cancellation charge fixed by the policy. If the charge cannot be determined, nothing is credited until the team decides it; when it is
decided, the credit follows. A later waiver credits the difference. A credit is never taken back automatically: recovering money from a
client is a separate, approved debit.

**Decisions.**
1. `CancellationSettlementService.settle` credits a cancelled, ledger-charged booking with `refund = total - effective penalty`. The effective
   penalty is the one booking operations already defines (`effectivePenalty`: latest waiver or decision, else the quote stored when
   cancellation was requested). Nothing is recomputed.
2. Undetermined penalty (NEEDS_DECISION): no credit, outcome `awaiting_penalty_decision`. Recording the decision settles it.
3. A waiver after settlement tops up the difference (`topped_up`). A decision that would refund less than already credited, or more than was
   charged, changes nothing (`review_required`).
4. Triggers, each after its own transaction commits: an operator lifecycle action that ends in CANCELLED (`confirmCancellation`), the manual
   answer "supplier cancelled", the supplier job that completes a cancellation (on behalf of the job's requester), and every penalty
   decision or waiver. A trigger never fails its caller (`settleQuietly`): the cancellation has committed; a missed settlement is reported by
   the integrity check (`CANCELLED_REFUND_NOT_POSTED`) and settled by the sweep.
5. Sweep: `POST /admin/operations/finance/cancellation-settlements` (`booking.reconcile`, as the stalled-booking reconciliation; `dryRun`
   lists). Amounts come from policy or a recorded decision, never from the request, so no second approver is needed; a manual or goodwill
   refund beyond the policy remains out of scope and would need one.
6. Safety: one transaction under the booking row lock (shared with every cancellation path) and the wallet row lock. The first credit uses
   the agent path's key `booking:<id>:cancel-refund`, so the agent path and this one can never both credit; a top-up is keyed
   `…:cancel-refund:<new total>`. It writes the `Cancellation` record (so the credit note becomes issuable) and the audit event
   `booking.cancellation.settled`. Agent-path cancellations are `already_settled`; bookings never charged on the ledger are left alone.
7. Connection: it runs on the API connection, like the agent cancellation, because the booking module's role has no ledger access
   (ADR 0032). On a strict deployment where that connection cannot write the ledger, the agent booking path cannot either; settlement then
   fails quietly and the integrity check reports the booking.

## 2. Database ledger guards (F4)

**Bedbank practice.** The book of record is immutable at the storage layer for everyone, administrators included; corrections are new
entries; retention erasure is a governed, explicit operation.

**Decisions** (migration `202611210001`):
1. `LedgerEntry_sign_by_type`: CREDIT, RELEASE, REFUND positive; DEBIT, HOLD negative; never zero. Added NOT VALID and validated in the same
   migration, so existing bad data stops the migration instead of being accepted silently.
2. `LedgerEntry_account_guard` (before insert): the wallet belongs to the entry's tenant and has the entry's currency.
3. `LedgerEntry_append_only` (before update or delete): always refused, for every role. A DELETE is allowed only in a transaction that set
   `fbeds.ledger_erasure = 'on'`; the application never sets it. Test teardowns use `test/ledger-erasure.ts`.
4. No grant, no index. Rollback steps are in the migration header.

## 3. Daily reconciliation

**Bedbank practice.** Reconciliation runs automatically every day across every account, and any break raises an alert for the finance team
before the day is closed.

**Decisions.**
1. `LedgerIntegrityMonitor` runs the ADR 0068 check for every active tenant, by default every 24 hours (minimum 1 hour).
2. Read-only: it writes nothing (no finding table, no audit event, no correction), so it can never move money.
3. Same rules as the hold-expiry sweeper (ADR 0005): off unless `LEDGER_INTEGRITY_MONITOR_ENABLED=true`; its own credential
   `LEDGER_INTEGRITY_DATABASE_URL`, which must differ from `DATABASE_URL` and is checked to be a restricted login at startup (startup
   fails otherwise); never overlaps itself; one tenant failing does not stop the others. Registered as an approved pool holder.
4. Alerting: ISSUES is logged at error level with tenant id, counts and rule codes only (no amounts, names or references); WARNINGS and
   INCOMPLETE at warn level. The log alarm on error level is the alert.
5. Provisioning the read-only login (SELECT on `Tenant`, `Wallet`, `LedgerEntry`, `FundingReceipt`, `Booking`, `Cancellation`,
   `AgencyCreditLimit`, under forced RLS) is an owner step, like the hold-expiry login. It is not created by this change.

## Verified
Unit: 1429 passed, 3 skipped, including a new monitor spec (5) and the controller guard updated for the new reconciliation handler.
Type-check, lint, `check:architecture`, `check:schema`. PostgreSQL 16, every migration applied to an empty database:
`cancellation-settlement` e2e (5: quoted penalty, undecided then decided, waiver top-up with no clawback, agent path and uncharged bookings
left alone, sweep with RBAC and dry run, integrity report clean afterwards) and a new F4 case in `ledger-integrity` (sign, foreign-tenant
wallet, currency, update and delete refused for the database owner). Not run: browser, CI. The booking-ops HTTP hooks are exercised by
the existing booking-ops suites only for not breaking them: those suites run the API on the strict role, where settlement fails quietly as
described in 1.7.

## Rollback
Revert the code. The migration is reversed by the forward migration in its header. Credits already posted stay, as every ledger entry does.
