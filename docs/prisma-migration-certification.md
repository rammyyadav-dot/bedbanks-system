# Prisma Migration Certification

## Scope

This document records the reproducible certification procedure for the committed Prisma migration chain in `apps/api/prisma`:

1. `20260101000000_baseline_identity`
2. `20260910000000_p0d_authentication`
3. `202609160001_agent_domain_foundation`
4. `202609180001_prisma_tenant_finance_hardening`
5. `202609180002_postgres_release_controls`

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

## CI evidence

The first certification run completed successfully in GitHub Actions CI run **#64** for commit `902f283dfd2588a6576e317ae9c2b43433e801fb`:

- Prisma schema validation: passed
- Prisma client generation: passed
- Empty PostgreSQL migration deployment: passed
- Migration status: passed
- Schema drift check: passed with exit code 0
- API PostgreSQL E2E tests: passed

Each later commit must rerun the same gate. Certification evidence applies only to the exact commit tested. The release-controls migration requires a fresh certification run before it can be described as certified.

The first two historical SQL files contain immutable creation-time comments stating that they were hand-authored and unverified. They must not be edited after application. The later certification gate is the current evidence of PostgreSQL replay and drift verification.

## Known limitations

- A green disposable replay proves only that this committed migration chain can create a matching empty database.
- It does not prove production `_prisma_migrations` history, backup restoration, data migration correctness or future accommodation/finance domain readiness.
- Historical migrations are not modified by this certification work.

## Persistent-environment release gate

The exact migration under review is `202609230001_platform_role_management_permissions`. Disposable replay certification applies only to the tested commit and does not establish the state of production, staging, shared preview, shared development, or other persistent databases.

For each persistent database, an authorized database owner must provide read-only `_prisma_migrations` evidence containing the migration name, checksum, `started_at`, `finished_at`, `applied_steps_count`, and `logs`, plus the owner, approved deployment sequence, backup/restore reference, verification queries, compatibility check, monitoring plan, abort criteria, and explicit approval decision. Connection strings and raw sensitive output must remain outside GitHub.

A missing report is `NOT EXECUTED`, not PASS. A failed migration, missing row, divergent checksum, or divergent history is a release stop. Never edit historical migrations, use `migrate resolve`, reset, or guess a repair. Use the database owner's approved forward-only corrective path, or a verified restore when explicitly authorized.

## Release decision

Production remains blocked when migration deployment, status, schema drift or PostgreSQL integration tests fail. Production deployment additionally requires database-owner confirmation of `_prisma_migrations` history for every persistent environment and explicit rollout approval. A green disposable replay does not satisfy this gate.

## Future migration checklist

1. Change `schema.prisma` only with an approved domain/design decision.
2. Generate a new forward-only migration; do not alter prior migration directories.
3. Replay the whole chain against an empty PostgreSQL database.
4. Confirm migration status and drift are clean.
5. Add domain-specific integration and tenant-isolation tests.
6. Review rollback/forward-fix path, backup readiness and release owner before deployment.
