# Prisma Tenant and Finance Hardening

## Scope

This change adds a forward-only migration, `202609180001_prisma_tenant_finance_hardening`, to the fBeds API. It does not alter earlier migration directories or access any shared database.

## Tenant isolation model

PostgreSQL RLS is enabled for memberships, roles, user-role assignments, bookings, cancellations, wallets, ledger entries and audit events. API code calls `PrismaService.withTenant()` after the session and membership guards have established a server-validated tenant. The helper uses one Prisma transaction plus transaction-local `app.current_tenant_id`; connection pools cannot carry that context into a later request.

The production HTTP database role must be non-owner and non-superuser. Migrations and controlled background operations require a separately governed role. No client-provided tenant header is trusted without membership verification.

## Migration safety

The migration adds `UserRole.tenant_id`, backfills it from the existing role, then fails if an assignment has no matching membership. A database trigger rejects future mismatched assignments. It also fails safely rather than guessing how to repair inconsistent historical data.

Financial values are converted to `BIGINT` minor units. `Wallet.cached_balance` is explicitly a cache, not the ledger source of truth. A tenant may have one wallet per ISO-4217 currency. Booking idempotency is unique per tenant; ledger idempotency is unique per wallet.

## Audit and retention

`sanitizeAuditPayload()` redacts credentials, session material, payment data and guest identifiers before persistence. Audit records are append-only by application convention; database-level UPDATE/DELETE denial and retention automation remain a production follow-up because they require an approved operations policy and database-role rollout.

## Required evidence

CI uses an empty PostgreSQL 16 database and runs validate, generate, deploy, migration status, drift and E2E tests. The new E2E coverage checks RLS visibility, cross-tenant write denial, role-assignment integrity, per-tenant booking idempotency, multi-currency wallets and audit redaction.

## Release decision

Production remains blocked until this exact commit has a green certification run and the database owner confirms production `_prisma_migrations`, backups, the non-owner application role and the RLS rollout plan. This change does not implement hotel, contract, rate, availability or supplier connector domain models.
