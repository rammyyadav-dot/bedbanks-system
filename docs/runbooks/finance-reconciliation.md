# Runbook: supplier statement reconciliation (ADR 0070)

Reconciliation is off until you turn it on. Nothing here posts to the ledger or pays a supplier.

## Enable (order matters)
1. **Migrate** with the owner credential: `pnpm --filter @bedbanks/api prisma:migrate:deploy` (applies `202611220001_supplier_statement_reconciliation`). Never `prisma migrate dev`.
2. **Provision the role** (owner credential; idempotent; prints no secret):
   ```
   PROVISION_DATABASE_URL=<owner url> FINANCE_RECONCILIATION_LOGIN_PASSWORD=<32+ char URL-safe secret> \
   pnpm --filter @bedbanks/api ops:provision-reconciliation-role
   ```
3. **Store** `FINANCE_RECONCILIATION_DATABASE_URL` (that login and password, same host and database) in the secret manager. It must differ from `DATABASE_URL`.
4. **Certify** as the login itself: `FINANCE_RECONCILIATION_DATABASE_URL=<url> pnpm --filter @bedbanks/api ops:verify-reconciliation-role`. Do not continue unless it prints `Result: OK`.
5. **Grant permissions** in Roles & Permissions to at least two finance users: `finance.reconcile.resolve` (so one can propose and another approve) and, for whoever imports statements, `finance.reconcile.run`. Everyone who looks needs `finance.read`.
6. **Set** `FINANCE_RECONCILIATION_ENABLED=true`, then `FINANCE_RECONCILIATION_WORKER_ENABLED=true` (optional `FINANCE_RECONCILIATION_WORKER_INTERVAL_MS`, default 30000, minimum 5000). Restart the API.

Without step 3 the API uses its own database login: a strict runtime login is refused by the database (typed 403/503) and nothing is written. That is the safe default.

## Daily use
Finance → Reconciliation → Statements → import (paste `reference,kind,currency,amount`; kind is CHARGE, CREDIT or SURCHARGE; amounts use a dot) → Run matching → Dispute queue. A decision at or above 100 currency units needs a different person to approve.

## Reading a stuck run
Statements table → Matching column. `Failed` shows a plain reason; the stable codes are `SCOPE_TOO_LARGE` (split the statement by period), `MAX_ATTEMPTS` (the worker failed three times; check API logs for `Reconciliation run … failed`; only the error class is logged) and `RUN_ERROR`. A `Queued` run that does not move means the worker is off, the role URL is wrong (503 `FINANCE_RECONCILIATION_UNAVAILABLE`), or `fbeds_reconciliation_due_tenants()` returned nothing because the migration owner does not bypass row-level security.

## Roll back
Set `FINANCE_RECONCILIATION_ENABLED` and the worker flag to anything but `true` (non-destructive). To remove the role: `deprovisionReconRole` (see `database/reconciliation-role.ts`). To drop the tables, follow the header of the migration; export statements and decisions first.
