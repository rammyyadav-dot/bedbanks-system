# Runbook: rate plan clone role (ADR 0057, S8)

Cloning a rate plan inserts a row, which the strict runtime role may not do (ADR 0032) and the lifecycle role must not do. The clone login `fbeds_rateplan_cloner` closes that gap and can insert **only DRAFT plans with no inventory pool**; a database trigger enforces it, so the role cannot create a sellable plan or bypass the activation approval.

## Provision (owner-run, idempotent)
```
PROVISION_DATABASE_URL=<owner credential from your secret manager> \
RATE_PLAN_CLONE_LOGIN_PASSWORD=<generated 32+ char URL-safe secret> \
pnpm --filter @bedbanks/api ops:provision-rate-plan-clone-role [--allow-remote --confirm-database=<name>]
```
The migration `202611150001_rate_plan_clone_guard` must be deployed first (it installs the DRAFT-only trigger). Build `RATE_PLAN_CLONE_DATABASE_URL` yourself from the same host and database with this login; store it in the secret manager; it must differ from `DATABASE_URL`. Never commit it.

## Certify (run as the clone login; read-only)
```
RATE_PLAN_CLONE_DATABASE_URL=<clone credential> pnpm --filter @bedbanks/api ops:verify-rate-plan-clone-role [--allow-remote --confirm-database=<name>]
```
Exit 0 only if the role verifier (no superuser, no BYPASSRLS, owns nothing, no UPDATE/DELETE anywhere, INSERT only on `RatePlan` and `AuditEvent`, `Hotel` readable by `id` and `tenant_id` only, the guard trigger present and enabled) and all 20 probes pass.

## Behavior
| Credential | Clone |
|---|---|
| set and usable | works on a strict login; the plan is a DRAFT; audit event attributed to the user |
| set but unusable | sanitized `503 RATE_PLAN_CLONE_UNAVAILABLE`; nothing written; never falls back to the runtime client |
| not set | unchanged: refused (403 `RUNTIME_ROLE_OPERATION_PROHIBITED`) on a strict login |

`GET /supply/rate-plans/capabilities` reports clone as available when the credential is configured.

## Rollback
Unset `RATE_PLAN_CLONE_DATABASE_URL` (clone is unavailable again on a strict login; "Create Rate Plan" still works). To remove the role: `deprovisionRatePlanCloneRole`. The trigger is harmless without the role and can stay; to drop it see the migration header.
