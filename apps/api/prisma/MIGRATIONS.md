# Prisma migration history and certification gate

**Authoritative schema:** `apps/api/prisma/schema.prisma`.  
Run these commands from `apps/api`. The committed migration files are the only permitted deployment source.

## Preserved migration history

1. `20260101000000_baseline_identity` — P0-C tenant, user and membership baseline.
2. `20260910000000_p0d_authentication` — status, credentials/lifecycle fields and opaque sessions.
3. `202609160001_agent_domain_foundation` — incremental roles, permissions, bookings, wallet/ledger and audit models.
4. `202609180001_prisma_tenant_finance_hardening` — tenant-bound role assignments, tenant-scoped idempotency, BIGINT money, multi-currency wallets, audit payload controls and PostgreSQL RLS.
5. `202609180002_postgres_release_controls` — non-owner ledger/audit append-only RLS policies and ordinary-role system-audit insert protection.
6. `202609190001_supplier_hotel_master` — tenant-scoped supplier, canonical hotel, room type and board-basis master data.
7. `202609190002_contract_commercial_rules` — supplier mappings, versioned contracts, rate plans and commercial policy rules.
8. `202609190003_rate_availability_inventory` — dated, non-negative rate-plan availability and BIGINT minor-unit daily rates.
9. `202609190004_connector_registry_foundation` — connector registry, secret-manager references and auditable inventory events.
15. `202609250001_booking_concurrency_foundation` — non-bookable inventory holds, atomic held quantities, tenant idempotency and RLS.
16. `202609260001_authoritative_rate_amount_semantics` — explicit nullable NET/SELL meaning for daily rates; legacy NULL rows remain non-sellable until classified.

Historical migration directories are immutable after they have been applied to any environment. Future schema changes require a new, forward-only migration.

## Certification gate

The `Prisma migration certification` GitHub Actions job starts an empty PostgreSQL 16 service and fails when any of these checks fail:

```sh
pnpm prisma:validate
pnpm prisma:generate
pnpm prisma:migrate:deploy
pnpm prisma:migrate:status
pnpm prisma:migrate:drift
pnpm test:e2e
```

`prisma:migrate:drift` compares the deployed disposable database with `schema.prisma` and exits non-zero on drift. A green run is release evidence for this exact commit only; it does not certify production database history, backups or data migrations.

## Tenant RLS execution model

The hardening migration enables RLS on tenant-scoped tables. The NestJS API must use `PrismaService.withTenant()` only after the authenticated user’s membership is validated. It opens one Prisma transaction and uses `set_config('app.current_tenant_id', tenantId, true)`, equivalent to `SET LOCAL`; the value cannot leak to a pooled connection after the transaction ends.

Production application connections must use a non-owner, non-superuser database role. A controlled system/migration role is separate and may not be used for ordinary HTTP requests. CI proves policy behaviour by switching to a non-owner test role. Do not configure a permanent session tenant variable.

The historical migration headers correctly record their creation state. The CI certification in this repository subsequently replayed the chain against PostgreSQL; do not edit applied historical SQL merely to change those comments.

## Local disposable verification

Use a newly created local PostgreSQL database, not `fbeds_dev`, staging or production. Set `DATABASE_URL` only in your local shell or local API environment, then run the certification commands above.

Before any production deployment, the database owner must also inspect `_prisma_migrations` and confirm the recorded migration history matches the committed chain.

## Prohibited recovery shortcuts

Do not use `prisma db push`, `prisma migrate reset`, or guessed schema generation in shared/staging/production environments. Do not use `prisma migrate resolve` unless the database owner proves the exact migration objects already exist and approves the repair. Do not edit, rename, squash or regenerate historical migrations.

## Release policy

A production release remains blocked if migration deployment, status, drift verification or PostgreSQL integration tests fail. Revert application code or create a reviewed forward-only corrective migration; never drop identity/session tables to force recovery.
