# PostgreSQL credit concurrency and RLS integration

Run only against a disposable database with all checked-in Prisma migrations applied:

```sh
pnpm --filter @bedbanks/api prisma:generate
pnpm --filter @bedbanks/api prisma:migrate:deploy
pnpm --filter @bedbanks/api test:credit:postgres
```

Supply `DATABASE_URL` through your environment. It must be an owner connection permitted to create/drop a temporary login and seed/clean fixtures. The dedicated command opts in with `ALLOW_DISPOSABLE_CREDIT_TESTS=true`; ordinary E2E discovery skips this suite unless explicitly enabled. The tenant-isolation workflow runs it on relevant PRs. The main CI migration-certification job also runs it, so the existing AWS promotion gate requires these tests before staging or production. Both use disposable PostgreSQL 16 services.

The owner handles setup, assertions and cleanup. All financial services and isolation probes use a unique non-owner LOGIN with NOSUPERUSER, NOBYPASSRLS and explicit financial-table permissions. Startup identity verification and catalog assertions ensure the probes cannot accidentally run as the owner or against tables without forced RLS. These grants test the financial execution path; they do not certify that the production API login has finance permissions or enable that capability in production.

Coverage:

- Twenty concurrent final-credit authorizations on agency and house wallets: one durable reservation, nineteen insufficient-credit refusals, one audit event.
- Agency-before-wallet lock ordering prevents a hold transaction and authorization from deadlocking.
- Twenty identical retries: one reservation and audit event.
- Actual PostgreSQL wait-graph observation before releasing a blocker, including direct debits, authorizations and hold-time checks waiting for credit changes, approved first creation/update/removal waiting for the agency lock, and rollback releasing the lock without changing the credit line.
- Unfiltered wallet, ledger and credit-limit reads under both tenants and without context. Cross-tenant/no-context wallet inserts fail with SQLSTATE 42501, and foreign updates/deletes affect zero rows.
- One-connection pool reuse proves transaction-local tenant context disappears after commit and rollback, with rolled-back mutations absent.

No fixed delay is used to infer blocking: the suite polls `pg_blocking_pids` with a bounded deadline. All blockers release in `finally`. Test-owned rows, clients and role grants are cleaned up. A failed setup/cleanup may require discarding the disposable database; never point this suite at a persistent environment.
