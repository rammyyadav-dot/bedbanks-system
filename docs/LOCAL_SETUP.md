# FBEDS — Local Development Setup

## Prerequisites

- Node.js ≥ 20 (`node -v`)
- pnpm ≥ 9 (`pnpm -v`, install with `npm i -g pnpm`)
- PostgreSQL ≥ 15 running locally (`psql --version`)

Create the normal development database once:

```bash
psql -U postgres -c "CREATE DATABASE fbeds_dev;"
```

## 1. Install

```bash
git clone https://github.com/rammyyadav-dot/bedbanks-system.git
cd bedbanks-system
pnpm install
```

`pnpm install` runs `prisma generate` automatically from the schema in `apps/api/prisma/schema.prisma`.

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
| `DATABASE_URL` error | Confirm the local URL begins with `postgresql://`. |
| Migration status/drift fails | Stop. Do not reset or push schema. Share output with the database owner and prepare a forward-only repair. |
| Login returns 401 | Seed has not run or password differs from `FBEDS_SEED_ADMIN_PASSWORD`. |
| Health reports DB unavailable | Verify local PostgreSQL is running and credentials are correct. |
