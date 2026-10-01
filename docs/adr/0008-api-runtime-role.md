# ADR 0008: API runtime database role

## Status
Accepted for disposable and local runtimes. Production role creation remains an owner-controlled checklist item.

## Context
PostgreSQL row security is enabled and forced on tenant commercial tables. The HTTP process was connecting as the table owner, which also has `BYPASSRLS`, so those policies were not evaluated for search, recheck, or auth. `fbeds_rls_test` can prove the policies only through `SET LOCAL ROLE` inside an owner transaction. The hold-expiry role is a separate least-privilege path and cannot read hotel search tables.

Login and `/auth/me` load memberships before a tenant is selected. With forced RLS and no tenant setting, a non-bypass role sees no memberships.

`pnpm start` invoked `node dist/main`. Nest's TypeScript build emits a nested path and the workspace packages export TypeScript source, so that command cannot boot. The development entry that emits decorator metadata is the SWC register of `src/main.ts`.

## Decision
Provision `fbeds_api` (NOLOGIN) and one LOGIN member, `fbeds_api_login`, with `NOSUPERUSER`, `NOBYPASSRLS`, and no table ownership. Grant only the reads required for auth, contracted search, and recheck, plus session writes and audit inserts. Do not grant wallet, ledger, booking, or credential tables, and do not grant `UPDATE` or `DELETE` on `Hotel`.

Create the role with the owner-only CLI. Refuse a non-local target unless the operator passes the remote confirmation flags. Never store the password in the repository.

Add a SELECT policy on `memberships` for the transaction-local `app.current_user_id`. The application sets that value only after the session identifies the user. A missing setting matches no rows. Tenant-scoped queries continue to use `app.current_tenant_id` inside `withTenant()`.

`pnpm start` and `pnpm start:prod` use the same SWC entry as `pnpm dev`.

## Consequences
A disposable API process can connect as `fbeds_api_login` and search only the tenant in the transaction setting. The database credential can still set that setting itself; the HTTP guards remain responsible for choosing it after membership validation. Production still needs the owner to provision this role, store the URL, and confirm the deployed process uses it. Admin supply mutations are outside this grant set.
