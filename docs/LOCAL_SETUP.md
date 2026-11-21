# FBEDS — Local Development Setup

## Prerequisites

- Node.js ≥ 20 (`node -v`)
- pnpm ≥ 9 (`pnpm -v`, install with `npm i -g pnpm`)
- PostgreSQL ≥ 15 running locally (`psql --version`)

Easiest: `docker compose up -d --wait` starts PostgreSQL 16 with pgvector (database `fbeds_dev`, user and password `postgres`, 127.0.0.1 only) and Redis at the same pinned images CI uses, then use `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/fbeds_dev?schema=public`. Skip the manual step below if you do.

Otherwise create the normal development database once:

```bash
psql -U postgres -c "CREATE DATABASE fbeds_dev;"
```

## 1. Install

```bash
git clone https://github.com/rammyyadav-dot/bedbanks-system.git
cd bedbanks-system
pnpm install
```

`pnpm install` does **not** run `prisma generate` automatically: pnpm blocks postinstall scripts from `@prisma/client`, `prisma` and other dependencies by default (you'll see `Ignored build scripts: ...` in the install output). Generate the client explicitly before any type-check, build or test:

```bash
pnpm --filter @bedbanks/api prisma:generate
```

(CI always runs this step explicitly, so it isn't affected by the blocked-script warning. If you'd rather have `pnpm install` run it for you locally, review and run `pnpm approve-builds` — this grants the listed packages permission to run their install scripts going forward, so only approve packages you trust.)

## 2. Configure environment

```bash
cp apps/api/.env.example apps/api/.env
```

Set local-only values:

```env
DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@localhost:5432/fbeds_dev
FBEDS_SEED_ADMIN_PASSWORD=a-strong-local-password
```

Never commit `.env` files or production credentials.

## 3. Apply migrations

```bash
cd apps/api
pnpm prisma:migrate:deploy
pnpm prisma:migrate:status
```

This applies the committed migrations in order:

1. `20260101000000_baseline_identity`
2. `20260910000000_p0d_authentication`
3. `202609160001_agent_domain_foundation`

Use `migrate deploy` for local, staging and production deployments. Future changes must use a new reviewed, forward-only migration.

## 4. Certify a disposable database

Do not certify migrations against your ordinary development, staging or production database. Create a separate empty database such as `fbeds_migration_check`, set `DATABASE_URL` to that database only, then run from `apps/api`:

```bash
pnpm prisma:validate
pnpm prisma:generate
pnpm prisma:migrate:deploy
pnpm prisma:migrate:status
pnpm prisma:migrate:drift
pnpm test:e2e
```

The drift command exits non-zero if the deployed database does not match the Prisma schema. Do not use `db push`, `migrate reset`, edit historical migrations, or use `migrate resolve` without database-owner proof and approval.

## 5. Seed local demo data

```bash
pnpm db:seed
```

This creates a local demo tenant and user using the password supplied by `FBEDS_SEED_ADMIN_PASSWORD`. It is idempotent and must not be run against production.

## 6. Start applications

```bash
cd apps/api && pnpm dev
```

Run each frontend from its own app directory as required. Configure frontend URLs only in local `.env.local` files.

## Useful commands

```bash
pnpm prisma:studio
pnpm type-check
pnpm test
pnpm prisma:migrate:status
pnpm prisma:migrate:drift
```

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `prisma generate` fails | Run `pnpm install` with network access to Prisma binaries. |
| `Cannot find package 'tsx'` or `has no exported member 'PrismaClient'` on a fresh clone | Prisma client was never generated — `pnpm install` doesn't run it automatically here (see step 1). Run `pnpm --filter @bedbanks/api prisma:generate`. |
| `pnpm type-check` crashes with `JavaScript heap out of memory` | Turbo runs every package's `tsc` concurrently; on a memory-constrained machine/container this can exceed the default V8 heap. Re-run the failing package alone with a larger heap, e.g. `NODE_OPTIONS="--max-old-space-size=6144" pnpm --filter @bedbanks/api type-check`, or type-check packages serially instead of via `pnpm type-check`. |
| `DATABASE_URL` error | Confirm the local URL begins with `postgresql://`. |
| Migration status/drift fails | Stop. Do not reset or push schema. Share output with the database owner and prepare a forward-only repair. |
| Login returns 401 | Seed has not run or password differs from `FBEDS_SEED_ADMIN_PASSWORD`. |
| Health reports DB unavailable | Verify local PostgreSQL is running and credentials are correct. |

## Running the full test task

`pnpm test` runs API unit tests followed by PostgreSQL integration tests. Supply `DATABASE_URL` for a disposable database and `REDIS_URL` for disposable Redis; configure the remaining test owner/mapping references as needed by the certification suites. The API Turbo test task is uncached and explicitly passes these private values only to API tests. They are not build inputs or frontend environment variables. The full API e2e process has a 6 GiB heap limit; run it separately from large parallel builds/type checks on memory-limited machines. Use the existing disposable setup and strict-role certification before running database suites.

E2E metrics use `TEST_ARTIFACT_DIR` when supplied; otherwise they go to the operating system temporary directory under `fbeds-test-artifacts`. The test task passes this setting to API tests. CI should set it to a writable directory collected by its artifact uploader.

### Opt-in financial and tenant-control certification

The default task skips two suites that need additional disposable credentials. Run them separately on a fresh migrated `fbeds_ci` database with disposable Redis.

For credit concurrency and forced RLS, set `DATABASE_URL` to the disposable owner connection. The suite provisions and removes its own restricted test login; its financial grants certify concurrency and tenant isolation, not production runtime grants.

```bash
ALLOW_DISPOSABLE_CREDIT_TESTS=true pnpm --filter @bedbanks/api test:e2e --runTestsByPath test/credit-concurrency-rls.e2e-spec.ts
```

For tenant-control certification, use the existing owner-run `ops:provision-api-runtime-role` and `ops:provision-tenant-control-role` procedures. Set `DATABASE_URL` to the strict API login, `TENANT_CONTROL_DATABASE_URL` to the distinct authoring login, and `TEST_OWNER_DATABASE_URL` to that database's owner connection. Then run:

```bash
pnpm --filter @bedbanks/api test:e2e --runTestsByPath test/tenant-control.e2e-spec.ts
```

These direct API invocations keep their additional credentials and opt-in flags out of frontend tasks. Run them sequentially with other database suites; temporary roles and shared catalogue state must not overlap.
