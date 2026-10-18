# ADR 0064: Nightly ledger integrity run

Status: **Built.** Off by default until the owner provisions the role and enables it (docs/runbooks/ledger-audit-role.md). Follows ADR 0062 and ADR 0063.

## Context
ADR 0063 gave finance an on-demand integrity check. Global bedbank practice is a **daily close**: a control that runs every night without anyone remembering to, keeps its result as evidence, and raises its hand when it did not run. A live check proves the ledger is fine right now; it cannot prove it was fine last Tuesday, and nobody notices if nobody opens the page.

## Decision
1. **A scheduled run.** A background job (`LedgerIntegritySweeper`) checks every few minutes and, from a configured UTC hour (default 01:00), records tonight's report for every active tenant that has none. A missed night is caught up as soon as the service returns. Off unless `LEDGER_INTEGRITY_SWEEP_ENABLED=true`; passes never overlap; one failing tenant does not stop the others; several API servers are safe (a per-tenant-night advisory lock, then a unique key).
2. **One unchangeable record per tenant per night.** Table `LedgerIntegrityRun`, unique on (tenant, UTC date): verdict, counts and the full report as written at run time. Forced row-level security; a trigger refuses UPDATE and DELETE for every principal, including the owner (only the tenant-erasure cascade passes); a CHECK keeps the verdict consistent with its own counts. It holds integer-string amounts and no guest or agency personal data.
3. **The same code as the live check.** `buildLedgerIntegrityReport` is the single report builder, so a stored night and the live screen cannot disagree. The credit-line lookup was also made one shared batch query (no query per account), and the last duplicated copy of that rule (Admin wallets list) was removed.
4. **A dedicated, narrow database role** (`fbeds_ledger_audit`), following ADR 0005, 0039 and 0042: read-only on the ledger and wallets, append-only on its own results, and one narrowly-scoped SYSTEM audit event (`finance.integrity.run`). It is created by an owner-run script or the manual GitHub workflow, not by a migration, so no role or secret enters migration history. The web role is not widened and the runtime-role contract is unchanged (`LedgerIntegrityRun` is listed as a privileged path).
5. **Admin shows the evidence and the gap.** Finance, Ledger integrity has a **Nightly record**: the history, a banner that says plainly whether the run is switched off, has not run yet, is current, or is **overdue** (a missing night is red, never an empty list pretending to be clean), and any past night can be opened exactly as recorded. Endpoints `GET /admin/operations/ledger-integrity/runs` and `.../runs/:runId` need `finance.read`.
6. **Strict deployments can read finance.** When `LEDGER_AUDIT_DATABASE_URL` is set, the live check and the history read through this restricted credential, so they work where the API's own role has no ledger access. Without it they answer the existing typed "not readable" 503. There is never a fallback to a broader principal.

## Controls (constitution)
Tenant identity comes from the authenticated context only. Every endpoint declares `finance.read`. No money is written, floated or converted. The run is idempotent (unique key plus lock). The privileged action creates an immutable audit event. Credentials are secret references and are never logged; errors log the error name only.

## Deliberately not done
- **No automatic correction.** A FAIL is investigated by a person through an approved finance process (ADR 0028 and ADR 0054 leave adjustments undecided).
- **No notification channel.** A FAIL is an error log line and a red Admin banner; routing to email or chat needs the owner's choice of channel.
- **No retention policy** and no export of past nights beyond the existing CSV on each opened night.
- **Not a bank reconciliation.** It proves the books are internally consistent, not that they match a bank statement or supplier invoices (ADR 0028 slice 6).

## Rollback
Set the flag to false and restart. Drop the role. The migration is reversed by a reviewed forward migration (SQL in its header); stored nights are lost, the ledger is untouched.

## Verified
Pure schedule rules and the scheduler (unit), the pure integrity rules, role provisioning against a real PostgreSQL (verify both directions), and the `ledger-integrity-nightly` e2e suite over HTTP on a real restricted login: confinement, permissions, never-run and overdue states, one record per night, the audit event, stored report equals live report, tenant isolation, immutability (including for the owner), the database refusing any other audit event or another tenant's row, and the scheduler covering a night once.
