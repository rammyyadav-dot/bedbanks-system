# ADR 0110: Drizzle queries set the tenant session variable

## Status
Accepted.

## Context
PostgreSQL already forces row-level security through `fbeds_current_tenant_id()`, which reads the transaction-local setting `app.current_tenant_id`. Prisma sets that value inside `PrismaService.withTenant` (`set_config(..., true)`, the same lifetime as `SET LOCAL`). That path stays the one the API uses for its existing queries.

Drizzle ORM has no query middleware. A statement and a session variable are isolated only when they run on the same connection inside the same transaction. A session-level `SET` would leak across a pooled connection, and `SET LOCAL` issued as its own autocommit statement is gone before the next statement. ADR 0067 also keeps `@neondatabase/serverless` out of this process: the API is long-lived and uses TCP.

ADR 0074 declined Drizzle as a second ORM for replicas, search and streaming. This decision does not move those paths. It adds one Drizzle client whose every statement is pinned to the tenant the server already validated.

## Decision
1. `createTenantDrizzle` is the only constructor. It hooks `pg` `client.query`. For a statement outside a transaction the hook sends `BEGIN`, `SELECT set_config('app.current_tenant_id', $2, true)`, the statement, then `COMMIT`. For a transaction Drizzle already opened, the hook sets the variable immediately after `BEGIN` and leaves Drizzle's `COMMIT` / `ROLLBACK` in place. `ROLLBACK TO SAVEPOINT` does not end the tenant transaction. The tenant id is a bind parameter. Named prepared statements are stripped so a Neon transaction-mode pooler cannot reuse them on another backend. A pool captures the tenant when `connect` is called, because `pool.query` runs the statement in a later callback. Drizzle also starts work from a thenable's `.then`; `runWithTenant` adopts that thenable before the scope exits.
2. The tenant comes from `AsyncLocalStorage` filled by `runWithTenant`. `TenantRlsInterceptor` calls that with the id `TenantContextGuard` stored on the request after the membership check. It does not read `x-fbeds-tenant-id`. No tenant, or a different tenant in the middle of a transaction, fails the statement before it is sent. Releasing a connection with the transaction still open destroys that connection.
3. `TenantDrizzleService` opens at most two connections (`TENANT_DRIZZLE_POOL_MAX`) to `DATABASE_URL`, on first use, with the same runtime-role guard as Prisma. The connection budget adds those two checkouts per task whenever `DATABASE_URL` is set. Prisma's `connection_limit` is unchanged.
4. `tools/drizzle-tenant-check.ts` rejects any other `drizzle-orm` import, any other `new Pool(`, and `@neondatabase/serverless` in application and tool source.

## Consequences
Existing Prisma queries are unchanged. A Drizzle query observes the same forced RLS policies as Prisma, and sees no rows when the setting is absent because that is what `fbeds_current_tenant_id()` already does. The extra pool is two connections, not a second copy of Prisma's limit. A query pays for a transaction even when the caller did not open one, which is the cost of keeping the setting on the same connection.

## Verification
Unit tests drive Drizzle and the `pg` callback form through a scripted client: the setting is bound, not interpolated; a transaction sets it once; a missing tenant sends nothing; a failed setting rolls back before the caller statement; a tenant switch does not send the new id; a savepoint rollback stays in the transaction; an abandoned transaction is not returned to the pool; a pool that delivers the client on a later turn still sets the captured tenant. The service tests refuse an owner URL and a `BYPASSRLS` identity without logging the password. On local PostgreSQL 16, a `NOSUPERUSER NOBYPASSRLS` login using this hook inserted one row per tenant, read only that tenant's row, saw `fbeds_current_tenant_id()` equal the pinned tenant, got `42501` on a cross-tenant insert, and saw zero rows with no tenant set. Not run here: a live Neon branch. The application policies themselves are the existing migrations.

## Rollback
Remove `TenantDrizzleService` from `DatabaseModule`, remove `TenantRlsInterceptor`, and drop the `extraPerTask` term from the connection-budget command. No migration was added.
