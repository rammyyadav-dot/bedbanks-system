# Prisma Migration Certification

## Scope

This document records the reproducible certification procedure for the committed Prisma migration chain in `apps/api/prisma`:

1. `20260101000000_baseline_identity`
2. `20260910000000_p0d_authentication`
3. `202609160001_agent_domain_foundation`

The authoritative schema is `apps/api/prisma/schema.prisma`.

## Disposable database method

GitHub Actions runs the `Prisma migration certification` job against a new PostgreSQL 16 service database named `fbeds_ci`. Each job starts from an empty database and deploys only committed migration files.

For local verification, create a separate empty PostgreSQL database. Never use production, staging, a shared environment or the ordinary developer database as the certification target.

## Required commands

Run from `apps/api`:

```sh
pnpm prisma:validate
pnpm prisma:generate
pnpm prisma:migrate:deploy
pnpm prisma:migrate:status
pnpm prisma:migrate:drift
pnpm test:e2e
```

## CI evidence status

This change adds the certification job and commands. The pull-request workflow is the source of real PostgreSQL replay, status, drift and integration-test evidence for the commit that contains this document. Do not state that certification passed until that workflow is green.

## Known limitations

- A green disposable replay proves only that this committed migration chain can create a matching empty database.
- It does not prove production `_prisma_migrations` history, backup restoration, data migration correctness or future accommodation/finance domain readiness.
- Historical migrations are not modified by this certification work.

## Release decision

Production remains blocked when migration deployment, status, schema drift or PostgreSQL integration tests fail. Production deployment additionally requires database-owner confirmation of `_prisma_migrations` history.

## Future migration checklist

1. Change `schema.prisma` only with an approved domain/design decision.
2. Generate a new forward-only migration; do not alter prior migration directories.
3. Replay the whole chain against an empty PostgreSQL database.
4. Confirm migration status and drift are clean.
5. Add domain-specific integration and tenant-isolation tests.
6. Review rollback/forward-fix path, backup readiness and release owner before deployment.
