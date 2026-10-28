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
