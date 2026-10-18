# ADR 0067: Database connection pooling and the Neon serverless driver

## Status
Accepted. Only the static architecture guard changes. No runtime driver, schema or migration changes.

## Context
An audit finding said that Next.js API routes and server actions connect to Neon PostgreSQL through PrismaClients created without a global singleton. It warned that serverless scale-out and dev hot reload could use up the connections. It recommended two things: make `@neondatabase/serverless` (the WebSocket driver) mandatory for every production connection, and add a global Prisma singleton.

What the repository actually does:

- **No frontend reaches the database.** `admin`, `agent`, `supplier` and `website` have no Prisma, `pg` or Neon dependency. `tools/runtime-db-role-check.ts` already fails CI when anything outside `apps/api` imports `@prisma/client`. The portals proxy `/api/v1/*` to the API on the server side (ADR 0010).
- **The API is one long-running NestJS process, not a serverless function.** It runs on Render today and is planned for ECS Fargate (ADR 0040). Dev starts with `node -r @swc-node/register src/main.ts` and has no hot module reload, so the `globalThis.prisma` workaround used by Next.js has nothing to fix here.
- **The HTTP client is already a process singleton.** `PrismaService` is provided once by the `@Global()` `DatabaseModule`. The dedicated role connections (`BookingOpsDatabase`, `TenantControlDatabase`, `RatePlanOpsDatabase`, `RatePlanCloneDatabase`, and the hold-expiry sweeper) are Nest singletons. Each one creates its client lazily, once, with `??=`. Every `PrismaClient` construction site is already on the audit list in `tools/runtime-db-role-check.ts`.
- **The gap:** the guard counted `new PrismaService(...)` as safe, and its test asserted exactly that. Each such call opens its own connection pool. A per-request `new PrismaService()` would pass CI and fill the database's connection slots under search traffic.

## Decision
1. **Do not adopt `@neondatabase/serverless`.** It exists to give HTTP/WebSocket access to edge and serverless functions that cannot keep TCP pools open. Our only database client is a long-lived TCP process. Under Prisma it would need the `driverAdapters` preview path. It would change how `withTenant`/`withSupplier`/`withPlatform` run their interactive `SET LOCAL` transactions, which RLS depends on. It would tie the runtime to a provider that ADR 0040 plans to replace with RDS. If a database client ever has to run in a serverless or edge runtime, that needs its own ADR.
2. **Treat pools as audited singletons.** `tools/runtime-db-role-check.ts` now rejects `new PrismaService(` anywhere in application source except the files listed in `APPROVED_POOL_HOLDERS`: the four process-wide role-connection holders. All other code injects `PrismaService` or one of those holders. Adding a pool means editing that list in review.
3. **Size the connection budget per URL, in the secret.** Prisma's pool size comes from each URL's `connection_limit` parameter (default `num_cpus * 2 + 1`). A single API task holds at most one pool per configured role URL: `DATABASE_URL`, `BOOKING_OPS_DATABASE_URL`, `HOLD_EXPIRY_DATABASE_URL`, `TENANT_CONTROL_DATABASE_URL`, `RATE_PLAN_OPS_DATABASE_URL` and `RATE_PLAN_CLONE_DATABASE_URL`. The worst case is `tasks × Σ connection_limit`, and it must stay below the database's `max_connections` minus the slots kept for migrations and operators. Operators set `connection_limit` explicitly on each stored URL. On a Neon pooled endpoint they add `pgbouncer=true`. Migrations and the owner CLIs keep using the direct endpoint (`isPooledHost` in `strict-role-rollout.ts` already refuses pooled hosts there).

## Consequences
- A new database client or pool cannot appear without a reviewed edit to the guard's lists.
- The transaction-local tenant context (`set_config(..., true)` inside `$transaction`) works unchanged with both direct and PgBouncer transaction-mode connections.
- Pool sizing stays an operator setting held in the secret manager. It is not checked at runtime.

## Rollback
Revert the `APPROVED_POOL_HOLDERS` check in `tools/runtime-db-role-check.ts` and its test. Nothing at runtime depends on it.
