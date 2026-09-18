# Prisma migration history and certification gate

**Authoritative schema:** `apps/api/prisma/schema.prisma`.  
Run these commands from `apps/api`. The committed migration files are the only permitted deployment source.

## Preserved migration history

1. `20260101000000_baseline_identity` — P0-C tenant, user and membership baseline.
2. `20260910000000_p0d_authentication` — status, credentials/lifecycle fields and opaque sessions.
3. `202609160001_agent_domain_foundation` — incremental roles, permissions, bookings, wallet/ledger and audit models.

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

## Local disposable verification

Use a newly created local PostgreSQL database, not `fbeds_dev`, staging or production. Set `DATABASE_URL` only in your local shell or local API environment, then run the certification commands above.

Before any production deployment, the database owner must also inspect `_prisma_migrations` and confirm the recorded migration history matches the committed chain.

## Prohibited recovery shortcuts

Do not use `prisma db push`, `prisma migrate reset`, or guessed schema generation in shared/staging/production environments. Do not use `prisma migrate resolve` unless the database owner proves the exact migration objects already exist and approves the repair. Do not edit, rename, squash or regenerate historical migrations.

## Release policy

A production release remains blocked if migration deployment, status, drift verification or PostgreSQL integration tests fail. Revert application code or create a reviewed forward-only corrective migration; never drop identity/session tables to force recovery.
