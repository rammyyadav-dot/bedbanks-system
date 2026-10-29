# ADR 0104: Structural tenant guard on the `withTenant` transaction client

## Status
Accepted. Application code only. No schema, migration, grant or runtime-role change.

## Context
An audit of the financial ledger path found three tenant walls: forced RLS on `LedgerEntry`, `Wallet` and the other tenant tables, keyed on the transaction-local `app.current_tenant_id` (the repo's setting name; there is no `app.current_tenant`); the `check:tenant-filter` CI gate (ADR 0071); and the e2e second-wall suites. The ADR 0071 "Not done" list named the missing piece: a structural guarantee that does not depend on every author remembering `tenantId`. RLS does not protect a connection that bypasses it (platform, tenant-control, owner tooling), and the CI gate is syntactic.

## Decision
`PrismaService.withTenant` and `withSupplier` pass work a transaction client wrapped by `guardTenantClient` (`apps/api/src/database/tenant-scope-guard.ts`). For every model whose `tenantId` is a required scalar (derived from `Prisma.dmmf`, so new models are covered automatically):

- `where` on find*, count, aggregate, groupBy, update*, delete*, upsert has `tenantId` pinned to the active tenant;
- `data` on create, createMany*, upsert.create has `tenantId` injected;
- naming a different tenant in `where`, `data` or `update` throws `TenantScopeViolation` instead of silently rewriting it.

The tenant value is the server-derived argument already given to `withTenant`; it never comes from the request.

## Not covered (stay on RLS, `check:raw-sql` and `check:tenant-filter`)
- Raw SQL (`$queryRaw`, `$executeRaw`).
- Models with an optional `tenantId` (global rows).
- Relation filters and nested writes inside `include`/`select`/`data`.
- `withPlatform`, `withPlatformTenant` and the dedicated role clients, which are cross-tenant by design.
- Clients used outside a transaction wrapper.

## Consequences
Missing predicates become correct instead of leaking. A caller that intentionally reads another tenant inside `withTenant` now fails loudly. The wrapper adds one object spread per call.

## Rollback
Set `TENANT_SCOPE_GUARD=off` and restart (emergency only), or revert the two lines in `prisma.service.ts`.
