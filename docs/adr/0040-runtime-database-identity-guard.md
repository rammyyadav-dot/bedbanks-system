# ADR 0040: The API runtime must connect as a restricted login, and proves it at startup

Status: accepted (2026-10-07). Release gate P0-01.

## Context
Row-level security only protects tenants if the process that serves requests is not exempt from it. A superuser and any role with `BYPASSRLS` ignore every policy, and a table owner can disable policies or (without FORCE) skip them. The repository already had a strict role model (ADR 0008, 0031, 0032, 0036, 0037): `fbeds_api` / `fbeds_api_login`, a single grant contract, forced RLS on every tenant table, and operator tools that verify the role. But nothing made the running API prove which role it was using. `DATABASE_URL` carried the owner URL for migrations and was the same variable the API read, so starting the API with an owner URL booted normally and bypassed RLS silently. `.env.example` shipped a superuser URL.

## Decision
1. **Two credentials, never interchangeable.** `DATABASE_URL` is the restricted runtime login. `MIGRATION_DATABASE_URL` is the owner, used only by `pnpm prisma:migrate:deploy:owner` (a wrapper that copies it into `DATABASE_URL` for the child process only and refuses equal values) and operator provisioning (`PROVISION_DATABASE_URL`). Service definitions never carry an owner-only variable.
2. **Fail-closed startup guard.** After connecting, every runtime client (HTTP `PrismaService`, the booking module connection, the hold-expiry sweeper) asks the database who it is (`current_user`, `session_user`, `pg_roles`, owned objects, membership in privileged roles) and refuses to run unless the role is not SUPERUSER, has no BYPASSRLS/CREATEROLE/CREATEDB/REPLICATION, owns no tables, functions or schemas, is not a member of a privileged role, and is not a known owner or administrator name. The error names the invariant only; it never contains the URL, host or password. The booking connection answers its existing sanitized 503 and never falls back to another principal.
3. **No silent downgrade.** `DB_RUNTIME_ROLE_GUARD` defaults to `enforce`; `off` is accepted only when `NODE_ENV=test` and is a startup error anywhere else. Production also rejects a known owner login in `DATABASE_URL` at configuration validation.
4. **Static CI guard** (`pnpm check:runtime-db-role`, part of `check:architecture`): fails when a runtime service definition or template names an owner/admin login in a runtime database variable, when an owner-only variable appears in a service definition, when a `PrismaClient` is constructed outside the audited list (which records purpose, URL source and runtime or operator use), or when anything outside the API imports `@prisma/client`.
5. **Ownership and RLS audit** (`ops:strict-role-rollout audit`, `runtimeOwnershipAudit`): lists every application table with owner, ENABLE and FORCE state and the runtime group's privileges, and fails on a runtime-owned table, an unexplained table without forced RLS, any privilege on an exempt non-tenant table that must have none, TRUNCATE/REFERENCES/TRIGGER, or CREATE on the schema or database.

## RLS exemptions (reviewed; everything else is forced)
`tenants` (the tenant root, no tenant column), `Permission` (global catalogue), `users` and `sessions` (identity looked up before a tenant exists; column-limited writes in the contract), `PlatformPermission`, `PlatformRole`, `PlatformRoleAssignment`, `PlatformRolePermission` and `_prisma_migrations` (not tenant data; the runtime holds no privilege). The list lives in `ownership-audit.ts` and is asserted by the audit.

## Consequences
- Developers must provision a restricted login locally (documented in `apps/api/.env.example` and the runbook); `DB_RUNTIME_ROLE_GUARD=off` is not available outside tests.
- Operators run migrations and provisioning with the owner credential in a release job or shell, not on the service.
- No schema change and no change to the grant contract were needed: the audit found one owner (the migration owner) and no runtime-owned object.
- Pool behaviour is unchanged by this decision.

## Rollback
Revert the commit. There is no migration. Without the guard the API again trusts the operator to supply the right URL.
