# Runbook: roll out the strict API role grants for the pool capacity editor

Applies ADR 0036 Amendment 1 (migration `202610260001_strict_runtime_role_pool_capacity`) to an environment. Executed by the **database owner**, not by CI or an AI session; nothing here touches a persistent database until a person runs it. The two helper commands below are read-only.

## What changes in the database
Exactly the contract rows in [strict-runtime-db-role.md](../strict-runtime-db-role.md): column-level `UPDATE (capacity, source, source_updated_at, received_at, fresh_until, updated_at)` on `InventoryPoolDay`, and column-level `SELECT` on `InventoryHold (id, tenant_id, rate_plan_id, status)` and `InventoryHoldNight (tenant_id, hold_id, pool_day_id, counter_kind, quantity)`. No table, column, index, policy or data change. No grant to any other role.

## Order matters
1. Database first (steps 2 to 5), then the API deploy (step 6). The new API reads the hold columns and writes pool capacity; deployed before the grants it answers a sanitized `503 DATABASE_ROLE_NOT_PERMITTED` for those requests (nothing is written). The previous API keeps working with the new grants, which only add privileges it never uses.
2. Rollback is the reverse: previous API first, then the REVOKEs (see Rollback).

## 0. Preconditions
- A verified backup or restore point exists (`docs/postgres-production-release-checklist.md`) and the owner approved a change window.
- You have the **direct (non-pooled)** owner connection string and a new 32+ character URL-safe password for the login role, both from the secret manager. Never paste them in chat, tickets or logs.
- The branch containing the migration is deployed through the normal release process (`prisma migrate deploy` is part of it).

## 1. Dry run: what would change? (read-only)
```
PROVISION_DATABASE_URL=<owner url> \
pnpm --filter @bedbanks/api ops:strict-role-rollout status \
  [--allow-remote --confirm-database=<exact database name>]
```
It reads `_prisma_migrations`, the role catalog and the live grants; it writes nothing and prints no URL or password. Read it as:
- **Migrations**: applied, pending (expect `202610260001_strict_runtime_role_pool_capacity` on a not-yet-rolled-out database), unfinished and unknown. Unfinished or unknown migrations are a BLOCKER: stop and follow `docs/production-migration-repair-runbook-2026-09-27.md`.
- **Group role / login members**: the owner usually appears as a member of `fbeds_api` (administrative membership from creating it); that is expected. The API login must not be SUPERUSER or BYPASSRLS (BLOCKER).
- **Grant drift**: every difference between the live grants of `fbeds_api` and the contract. On a database before this rollout expect the pool-day UPDATE and the two hold-table reads to be listed. After the rollout it must be `none`.
- **Pooled endpoint**: a BLOCKER. Use the direct connection.
- **Verdict** `READY` or `BLOCKED` (exit code 1), and the ordered next steps.

## 2. Migrate
```
pnpm --filter @bedbanks/api prisma:migrate:deploy
```
The migration is a no-op when the group role does not exist, and otherwise revokes everything on the three tables from `fbeds_api` and re-grants exactly the rows above. Never `prisma migrate dev`, `db push` or `migrate reset`.

## 3. Provision (idempotent)
```
PROVISION_DATABASE_URL=<owner url> API_RUNTIME_LOGIN_PASSWORD=<secret> \
pnpm --filter @bedbanks/api ops:provision-api-runtime-role \
  [--allow-remote --confirm-database=<exact database name>]
```
Re-runs `REVOKE ALL`, then exactly the contract, and rotates the login password. If you do not intend to rotate the password, skip this step when step 4 already shows no drift.

## 4. Re-run the dry run
`ops:strict-role-rollout status` must now show `0 pending`, `Grant drift: none`, `Verdict: READY`.

## 5. Verify as the runtime login (read-only)
```
API_DATABASE_URL=<runtime login url> \
pnpm --filter @bedbanks/api ops:strict-role-rollout verify \
  [--allow-remote --confirm-database=<exact database name>]
```
Runs the role verifier (not superuser, not BYPASSRLS, owns nothing, only the group membership, no write or read outside the contract) and 12 privilege probes: capacity UPDATE allowed; `sold`, `held`, `tenant_id` UPDATE, INSERT and DELETE on `InventoryPoolDay` denied; the granted hold columns readable; `sell_amount_minor`, `SELECT *` and `Booking` unreadable. Every probe is a `WHERE false` statement in a rolled-back transaction, so no row is read or written. `Result: OK` is required.

## 6. Deploy the API
Only after step 5. The Admin app needs no config change. The permissions `supply.availability.read`, `supply.pool_capacity.preview` and `supply.pool_capacity.apply` are granted to no role by the migration: assign them to roles explicitly when the owner decides who may edit capacity.

## 7. Smoke (people with the permissions)
Open a pool in Admin: the per-plan consumption must show attribution (not an error); preview a capacity edit; apply one on a test night with a reason and confirm the audit event `inventory.pool.capacity_changed`. A `503 DATABASE_ROLE_NOT_PERMITTED` means a grant is missing: repeat steps 4 and 5.

## Rollback
1. Deploy the previous API release.
2. As the owner:
```
REVOKE UPDATE ("capacity","source","source_updated_at","received_at","fresh_until","updated_at") ON "InventoryPoolDay" FROM fbeds_api;
REVOKE SELECT ("id","tenant_id","rate_plan_id","status") ON "InventoryHold" FROM fbeds_api;
REVOKE SELECT ("tenant_id","hold_id","pool_day_id","counter_kind","quantity") ON "InventoryHoldNight" FROM fbeds_api;
```
Nothing else changed in the database, so there is no data to restore. (Do not run the old provisioning from an old checkout against a new database without checking `status` first: it would leave the role without grants the running API needs.)

## Rehearsal evidence (disposable cluster)
A database migrated to the migration before this one, provisioned, with the three grants revoked to mimic the earlier state, reported `1 pending` and three drift lines; after `prisma migrate deploy` it reported `47 applied, 0 pending, Grant drift: none`, and `verify` passed all 12 probes. The same sequences are covered by `apps/api/test/strict-role-rollout.e2e-spec.ts` (RO-01 to RO-05) and `strict-runtime-role-replay`.
