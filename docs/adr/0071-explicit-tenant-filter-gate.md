# ADR 0071: Explicit tenant filter on every tenant-table query, enforced in CI

## Status
Accepted. Code change to API services (query predicates only), one new CI gate. No schema, migration, grant or runtime-role change.

## Context
Tenant isolation rests on two walls (ADR 0003, ADR 0040, `docs/tenant-database-security-certification.md`): the authenticated tenant context (`TenantContextGuard`, `ActiveTenant`), and PostgreSQL forced row-level security under the `fbeds_api_login` role inside `PrismaService.withTenant`.

RLS protects only code that runs on that role inside that transaction. Four things can take the second wall away without a visible failure: a call made outside `withTenant`, a connection that bypasses RLS (the platform and tenant-control logins, the compliance exporter, owner-credential tooling), a raw-SQL path, or a regression in a policy. When that happens, a `where: { id }` is a cross-tenant read or write of financial ledgers, markup rules, contracts and rate plans. Until now the only defence was reviewer discipline.

An audit of the 303 non-test API source files found 119 Prisma calls on the 69 tenant models, plus raw SQL, with no explicit tenant predicate. Most were updates or lookups by id after a tenant-scoped read in the same transaction, so RLS and the earlier read covered them. A few were not covered by anything in the code:

- `ComplianceExport.batchRecords` read `ComplianceRecord` by batch id with no tenant predicate, on a connection whose scope is only a session setting.
- `ComplianceExport.exportScope` flipped a batch to STORED by id alone.
- Ledger idempotency lookups (`walletId_idempotencyKey`) carried the wallet, not the tenant.
- Booking, hold, funding, reconciliation, hotel-setup, rate-plan, image and markup mutations addressed rows by id alone.
- The admin and booking list endpoints took a `where` from a builder and trusted it to contain the tenant.

`apps/admin/lib/api/tenant-context.ts` was named as a risk, but it only holds the browser's *requested* tenant for the `x-fbeds-tenant-id` header. The API re-validates it against membership on every call (`sessionTenantId`), so a forged value gains nothing. Nothing in the Admin app queries the database.

## Decision
1. **Every Prisma call on a model with a `tenantId` column names the tenant**: a `tenantId` key, a composite unique key containing it, or an `AND` member that does. By-id mutations and lookups use `where: { id, tenantId }` (Prisma extended unique where). A `where` built elsewhere is spread and the tenant pinned last: `where: { ...built, tenantId }`, so a builder that forgets the tenant cannot widen a query.
2. **`tools/tenant-filter-check.ts` enforces this** from the TypeScript AST and the Prisma schema, in `pnpm check:architecture` and in `tenancy-check.yml`. It flags:
   - `missing-filter`: a literal `where` with no tenant;
   - `dynamic-where`: a `where` it cannot resolve to one that names the tenant;
   - `unscoped-client`: a tenant model queried on the bare `PrismaService` outside `withTenant`/`withSupplier`/`withPlatform`;
   - `missing-data`: a create on a model whose `tenantId` is nullable (where Prisma's types would not force it);
   - `raw-sql`: `$queryRaw`/`$executeRaw` that reads or writes a tenant table with no tenant predicate (catalog probes are not table access).
3. **Zero tolerance, one audited exception**: `// tenant-scope: <reason>` on the same or preceding line, reason mandatory (at least six characters), for queries that are tenantless or cross-tenant by design. Today there are seven, each reviewed: login-time membership lookups keyed by `userId`, tenantless authentication and system audit events, the platform operator directory and company-registration uniqueness check, and the first-admin bootstrap.
4. `compliance*` batches are tenant-scoped by `scopeKey` (the tenant id, or `platform`), which the check accepts for that model only.
5. Owner-credential provisioning CLIs (`apps/api/src/database/*.cli.ts`) are not read: they run once, on the schema-owner connection with no RLS context, and address rows across tenants by purpose.

## Consequences
- A new query that lacks a tenant predicate fails CI at the line, with the method and model named.
- RLS remains the boundary. This is the second wall, so a lost context or a bypass-RLS connection does not widen a query.
- `where: { ...built, tenantId }` can make a query return nothing where a buggy builder previously returned another tenant's rows. That is the intended failure.
- The check is syntactic. It cannot prove that a variable named `tenantId` is the session tenant. That stays with `ActiveTenant`, `TenantContextGuard` and the e2e cross-tenant suites. It also does not read relation filters inside `include`/`select`; those stay on RLS and review.
- Create calls on non-nullable `tenantId` models are not checked: the Prisma types already require the value.

## Rollback
Remove `check:tenant-filter` from `check:architecture` and the two workflow steps. The predicate changes are independent and each narrows a query; reverting one restores the previous RLS-only behaviour for it.

## Evidence the second wall holds without RLS
`apps/api/test/tenant-second-wall.e2e-spec.ts` runs the real services on the schema-owner connection, where RLS does not apply, as a tenant-A member against tenant-B ids. A control proves the connection bypasses RLS (a raw read inside `withTenant(A)` still sees B). It then shows that list endpoints return only A's rows, that hotel and mapping reads and updates by B's id find nothing and change nothing, that image edits and deletes by B's image id are refused under either hotel, and that a ledger post cannot reach B's wallet or return B's entry on an idempotency-key replay. Each refusal is paired with a positive control on A's own data. Removing the tenant predicate from the hotel-image lookups makes the cross-tenant image test fail; the other five stay green, which shows the suite detects the regression it exists for. It runs with the rest of `test:e2e` in the Prisma migration certification job.

`apps/api/test/tenant-second-wall-finance.e2e-spec.ts` does the same for the financial paths, with two full tenants (agency booker, wallet, contract, rate plan, inventory). Tenant A confirms tenant B's prebooked booking, quotes and cancels B's confirmed booking, authorizes and releases against B's wallet, and reads, verifies, clears, rejects and posts B's funding receipt. Each attack must end in a deliberate HTTP refusal (404, 403 or 409), never a crash, and an exact before/after snapshot of B's bookings, holds, inventory, ledger, cancellations, receipts and audit count must be unchanged. Each is paired with a positive control on A's own data, and B can still complete the same operation itself afterwards. Removing the tenant predicate from the funding lookup, lock and updates fails only the funding test.

## Not done / next
- Relation filters inside `include`/`select`/`some`/`every`, and Prisma `$extends` middleware that injects the tenant, if the team prefers a structural guarantee to a lint-style one.
- The RLS-off suites cover hotel, mapping, image, ledger, booking confirmation and cancellation, financial authorization and funding. Reconciliation, commercial markups, rate-plan mutations and the compliance export are covered by the syntactic gate and their own e2e suites, not by an RLS-off cross-tenant case.
- Booking confirmation and cancellation filter by tenant at several layers (lock, read, supplier mutation, ledger), so the suite asserts the outcome and not one predicate. Removing a single predicate there does not change the result; that is defence in depth working, not a gap in the test.
