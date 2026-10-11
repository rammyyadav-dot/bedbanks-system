# Runbook: provision and certify the rate plan lifecycle role on a hosted or persistent database

Applies ADR 0041 Amendment 2 and 3. Executed by the **database owner** (a person with the owner credential), never by CI or an AI session. Nothing in this repository has been run against a hosted or persistent database: every result for the lifecycle role so far is from disposable local PostgreSQL 16 only. This runbook is the procedure; the record at the end is filled in by the person who runs it.

**Scope boundary.** fBeds only. Do not use a UAEWB or fabBeds database, credential, secret store or project for any step. If the target host or database name is not unmistakably the fBeds database named in the approved change, stop.

## What this changes
Creates (or converges) one NOLOGIN group role `fbeds_rateplan_status` and one login `fbeds_rateplan_ops`, with exactly: `UPDATE ("status", "updated_at")` and `SELECT` on `RatePlan`; `SELECT` on `RoomType`, `BoardBasis`, `Contract`, `SupplierHotelMapping`, `CancellationPolicy`, `DailyRate`, `DailyAvailability`; `SELECT ("id", "tenant_id", "time_zone")` on `Hotel`; `INSERT` on `AuditEvent`. No migration, no schema change, no change to `fbeds_api`, RLS or any existing grant. Without it, activate and suspend under the strict login answer `403 RUNTIME_ROLE_OPERATION_PROHIBITED` (fail closed). Clone stays unavailable by decision.

## Credential separation (do not weaken)
| Credential | Used by | Where it lives |
|---|---|---|
| Owner / migration URL | this runbook's provisioning step and `prisma migrate deploy`, run by a person | secret manager, owner only; never in the API's environment |
| `DATABASE_URL` (strict `fbeds_api_login`) | the API runtime | API secret |
| `RATE_PLAN_OPS_DATABASE_URL` (`fbeds_rateplan_ops`) | the API, one code path (`transitionRatePlan`) | API secret, **must differ from `DATABASE_URL`** (the API treats an equal value as "not configured") |

Never paste any of them into chat, tickets, logs, CI variables visible to forks, or this repository. The commands below print role and database names only.

## 0. Preconditions (stop if any is missing)
1. **Target confirmation.** Write down, from the approved change record, the exact database name and host. Confirm with the infrastructure owner that it is the fBeds environment and which tier it is (staging, production, other). A pooled endpoint (`-pooler` in the host) is not acceptable for provisioning: use the direct connection.
2. **Backup and recovery.** A verified backup or restore point of that database exists, with identifier and timestamp recorded, and a restore test has been done within the agreed period (`docs/postgres-production-release-checklist.md`). The change window is approved by the owner. Recovery for this change is trivial (step 8), but the backup is still required because the same window may carry other migrations.
3. **Migration state.** `pnpm --filter @bedbanks/api ops:strict-role-rollout status` (read-only; add `--allow-remote --confirm-database=<exact name>` for a remote target) reports `Verdict: READY`: no unfinished or unknown migrations, strict login not SUPERUSER or BYPASSRLS, no grant drift. Unfinished or unknown migrations are a BLOCKER: follow `docs/production-migration-repair-runbook-2026-09-27.md`, do not continue here.
4. **API version.** The deployed API contains ADR 0041 Amendment 2 (the lifecycle route and `RatePlanOpsDatabase`). Older APIs ignore the new variable harmlessly.
5. A fresh 32 to 128 character URL-safe password (`[A-Za-z0-9_-]`) generated into the secret manager, not on a shared terminal.

## 1. Provision (idempotent, owner)
```
PROVISION_DATABASE_URL=<owner direct url> RATE_PLAN_OPS_LOGIN_PASSWORD=<secret> \
pnpm --filter @bedbanks/api ops:provision-rate-plan-ops-role \
  --allow-remote --confirm-database=<exact database name>
```
It refuses a remote target unless both flags match. It revokes everything from the group first, so a stale grant cannot survive, then applies exactly the grants above. Re-running rotates the password.

## 2. Build and store the connection string
Build `RATE_PLAN_OPS_DATABASE_URL` from the **same host and database** as `DATABASE_URL` with user `fbeds_rateplan_ops` and the new password, with `sslmode=require` for a remote host. Store it in the secret manager as the API secret. Do not deploy yet.

## 3. Certify as the lifecycle login (read-only)
```
RATE_PLAN_OPS_DATABASE_URL=<lifecycle url> \
pnpm --filter @bedbanks/api ops:verify-rate-plan-ops-role \
  --allow-remote --confirm-database=<exact database name>
```
It connects as the lifecycle login only (no owner credential), runs the role verifier (not superuser, no BYPASSRLS, no CREATEROLE/CREATEDB/REPLICATION, owns nothing, member of the group, no table-wide write, INSERT only on the audit log, UPDATE only on `status` and `updated_at`, audit log unreadable, `Hotel` limited to three columns) and the privilege probes, each a `WHERE false` statement that reads and writes nothing. Required: `Result: OK`, exit code 0. Any FAIL is a BLOCKER: do not deploy; re-run step 1 and investigate with the owner.

## 4. Certify the runtime login is unchanged (read-only)
```
API_DATABASE_URL=<strict runtime url> \
pnpm --filter @bedbanks/api ops:strict-role-rollout verify --allow-remote --confirm-database=<exact name>
```
`Result: OK`. The lifecycle role must not have changed any runtime grant.

## 5. Deploy the API with the new secret
Set `RATE_PLAN_OPS_DATABASE_URL` on the API only (not on the Admin or Agent apps). Deploy through the normal release process. On first use the lifecycle client connects and verifies it is restricted (not at boot, so a bad secret surfaces at the first activate or suspend, or in step 6); a rejected credential never falls back to the runtime client (it answers a sanitized `503 RATE_PLAN_OPS_UNAVAILABLE`).

## 6. Smoke on the hosted API (a person with `supply.rates.manage`, on a test rate plan only)
1. `GET /supply/rate-plans/capabilities` shows activate and suspend `available: true`, clone `available: false` with reason `STRICT_ROLE_NO_WRITER`. The Admin Rate Plans tab shows Clone disabled with its explanation.
2. Activate a **ready DRAFT test plan**: `201`; Agent search now offers it. Check the audit log for one `supply.rate_plan.status_changed` with actor, request id, before and after.
3. Try a plan with no rates: `409 RATE_PLAN_NOT_READY`, the failed checks are listed, the plan stays DRAFT, no audit event.
4. Suspend it with a reason: `201`; it disappears from Agent search.
5. As a user without `supply.rates.manage`: `403 FORBIDDEN`, no change.
Booking, payment and supplier confirmation are not touched by any step and must stay disabled.

## 7. Failure handling
| Symptom | Meaning | Action |
|---|---|---|
| `403 RUNTIME_ROLE_OPERATION_PROHIBITED` on activate or suspend | Variable not set, or equal to `DATABASE_URL`, on the running API | Check the secret reached the API process; redeploy |
| `503 RATE_PLAN_OPS_UNAVAILABLE` | Set but the login is rejected, unreachable, missing a grant, or not restricted | Re-run steps 1 and 3; check network allow-list and `sslmode`; nothing was written |
| Step 3 FAIL | Role or grants differ from the contract | Do not deploy; re-provision; escalate to the owner |
| Unexpected rows written to `RatePlan` | Should be impossible: the role can change only two columns | Treat as incident (`docs/runbooks/incident-response.md`) |

## 8. Rollback
Unset `RATE_PLAN_OPS_DATABASE_URL` and redeploy (activate and suspend return to the fail-closed 403 under the strict login; plans already ACTIVE or SUSPENDED stay as they are). To remove the role, the owner runs `deprovisionRatePlanOpsRole` (drops the login, optionally the group). No data migration is involved.

## Production-clone compatibility (before the first production use)
Restore the latest production backup into a **disposable** database (never the live one), run `prisma migrate deploy` for the migrations pending in that environment, then steps 1 and 3 against the restored copy. This proves the role and the migrations coexist on production-shaped data. It is separate from, and does not replace, steps 0 to 6 on the real target. See `docs/clone-certification-runner.md` and `.github/workflows/clone-certification.yml` for the existing clone mechanism.

## Evidence record (filled in by the person who runs it)
| Item | Value |
|---|---|
| Environment / tier | |
| Database name and host (no credentials) | |
| Target confirmed by (person, date) | |
| Backup identifier and timestamp; restore test reference | |
| Change window approval (person) | |
| `ops:strict-role-rollout status` verdict | |
| Provisioning run (person, time) | |
| `ops:verify-rate-plan-ops-role` result and probe count | |
| `ops:strict-role-rollout verify` result | |
| API release / commit SHA deployed | |
| Hosted smoke steps 6.1 to 6.5 | |
| Production-clone compatibility run (reference) | |
| Verdict | NOT VERIFIED until every row above is filled in |
