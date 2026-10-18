# Runbook: switch on the nightly ledger integrity run

Operational half of ADR 0064. Executed by the **database owner** (or someone they delegate), not by CI or an AI session.
Nothing here touches production until a human runs it. You do not need to write code: the GitHub workflow below does the technical steps.

## What this switches on
Every night (default 01:00 UTC) the API checks each active tenant's whole ledger with the same rules as the live check in
Admin, Finance, Ledger integrity, and stores **one unchangeable record per tenant per night**: the verdict, the counts and the full list of findings.
Admin shows the history, flags a missing night as **overdue**, and lets finance open any past night exactly as it was recorded.
It only reads money. It cannot post, change or delete a ledger, wallet, booking, agency or user row.

## Fastest route: the GitHub workflow (no terminal)
The manual workflow **Provision ledger-audit role** (Actions tab) does steps 2 to 4 from GitHub. It runs only from `main`, reads secrets from a
GitHub Environment, never prints a URL or password, and defaults to a read-only check. It is the same pattern as the hold-expiry role.

One-time setup (repository owner, GitHub: Settings, Environments). Skip what already exists from the hold-expiry role.
1. Environments `db-nonprod` and `db-production`; on `db-production` add a person under **Required reviewers**; restrict both to `main`.
2. In each environment add **secrets**:
   - `OWNER_DATABASE_URL`: the owner **direct** (not pooled) connection string for that database.
   - `LEDGER_AUDIT_LOGIN_PASSWORD`: a new 32+ character URL-safe password (letters, digits, `-`, `_`). Use the same value in step 3.
3. Optional environment **variable** `LEDGER_AUDIT_LOGIN_ROLE` (default `fbeds_ledger_audit_login`).

Run (Actions, Provision ledger-audit role, Run workflow):
1. `target=nonprod`, `mode=status-only`, `confirm_database=<database name>`. Expect "Migration state: as expected".
2. `target=nonprod`, `mode=apply` to rehearse. The run applies the one new migration `202611190001_ledger_integrity_runs`, creates the role and ends with "Role check passed".
3. Repeat both for `production` (a reviewer approves the apply).

The workflow refuses a pooled connection string, a wrong database name, unresolved failed migrations, migrations the repo does not know, and any
pending migration other than the expected one (nonprod may tick **allow_catch_up** if it is several migrations behind; production never).

## Terminal route (same effect)
```
PROVISION_DATABASE_URL=<owner URL from secret manager> \
LEDGER_AUDIT_LOGIN_PASSWORD=<secret> \
pnpm --filter @bedbanks/api ops:provision-ledger-audit-role --allow-remote --confirm-database=<exact database name>
```
Idempotent; re-running rotates the password. Generate the secret with `openssl rand -base64 30 | tr '+/' '-_' | tr -d '='`; never paste it in chat or tickets.

## What the role may do (and nothing more)
| Object | Privilege |
|---|---|
| `tenants` | SELECT (`id`, `status`) only |
| `Wallet`, `LedgerEntry` | SELECT only. No insert, update, delete or truncate. |
| `AgencyCreditLimit` | SELECT (`tenant_id`, `agency_id`, `currency`, `limit_minor`) |
| `LedgerIntegrityRun` | SELECT, INSERT. A database trigger refuses UPDATE and DELETE for everyone, including the owner. |
| `AuditEvent` | SELECT, INSERT. A policy permits one event only: SYSTEM, no user, action `finance.integrity.run`, the current tenant. |
It has no access to bookings, guests, users, sessions, agencies, hotels, contracts, rates, holds or funding receipts. The verifier checks all of that in both directions.

## 3. Store the runtime settings
Where the API runs, set (the URL as a **secret reference**, same host and database as `DATABASE_URL` but this role and password; it must differ from `DATABASE_URL`):
- `LEDGER_AUDIT_DATABASE_URL`
- `LEDGER_INTEGRITY_SWEEP_ENABLED=true`
- optional `LEDGER_INTEGRITY_RUN_HOUR_UTC` (0 to 23, default 1) and `LEDGER_INTEGRITY_CHECK_INTERVAL_MS` (default 300000, minimum 5000)

Set the URL first; the API refuses to start with the run enabled and no credential, with the web credential, or with a privileged one.
On a **strict deployment** (the API's own database role has no ledger access, ADR 0031/0032), setting `LEDGER_AUDIT_DATABASE_URL` also lets the
Admin live check and history read the ledger through this restricted role; without it they answer "not readable" rather than falling back to a broader login.

## 4. Verify
- Start log line: `Nightly ledger integrity run enabled: daily from 01:00 UTC`.
- After the first scheduled hour: Admin, Finance, Ledger integrity, **Nightly record** shows tonight's run and "Nightly record is current".
- Log lines: `Ledger integrity pass: recorded=N`, and an **error** line `Ledger integrity FAIL for tenant <id>` when a night has errors.
  Wire your log monitoring to alert on that error line and on the Admin banner "Nightly run is overdue" (the run is late more than 3 hours after its hour).

## What to do when a night FAILS
A finding is a question for a person, never an automatic repair. Open the night in Admin, read each finding (it names the booking or account and the amounts),
and investigate from the booking's finance tab and the Ledger page. Corrections must go through an approved finance process; the run changes nothing.

## Residual risks (accepted, reviewed)
- The role sees every active tenant's ledger by design (the run is cross-tenant); row-level security still applies per tenant context.
- It reads at most 20,000 bookings per tenant per run and records `partial` when there are more. A partial night is not a clearance.
- Several API instances each try each night; a per-tenant-night lock and a unique key make that safe, with some redundant checking.
- One row per tenant per night is stored with up to 200 findings; retention is indefinite until the owner sets a policy.

## Rollback
1. `LEDGER_INTEGRITY_SWEEP_ENABLED=false`, restart. Stored nights remain readable.
2. Revoke the role: `DROP OWNED BY "<login role>"; DROP ROLE "<login role>";` (and the group role `fbeds_ledger_audit` if unused).
3. The migration is reversible only by a reviewed forward migration (rollback SQL is in its header); that deletes stored nights, never the ledger.
