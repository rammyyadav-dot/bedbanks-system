# FBEDS — Local Development Setup

## Prerequisites

- Node.js 24.x (`node -v`; `package.json` `engines`)
- pnpm 10.4.1 (`corepack enable && corepack prepare pnpm@10.4.1 --activate`). Use pnpm, never `npm install`: this is a pnpm workspace.
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

`pnpm install` does not generate the Prisma client. Run it explicitly:

```bash
pnpm --filter @bedbanks/api prisma:generate
```

## 2. Configure environment

```bash
cp apps/api/.env.example apps/api/.env
```

Two database logins are used, never interchangeable (ADR 0040). The API refuses to start if `DATABASE_URL` is a superuser, `postgres`, or an owner login.

```bash
export MIGRATION_DATABASE_URL=postgresql://OWNER:OWNER_PASSWORD@localhost:5432/fbeds_dev   # shell only, never in .env
```

Set local-only values in `apps/api/.env`:

```env
DATABASE_URL=postgresql://fbeds_api_login:GENERATED_PASSWORD@localhost:5432/fbeds_dev
FBEDS_SEED_ADMIN_PASSWORD=a-strong-local-password
```

Never commit `.env` files or production credentials.

## 3. Apply migrations

```bash
cd apps/api
pnpm prisma:migrate:deploy:owner
PROVISION_DATABASE_URL="$MIGRATION_DATABASE_URL" API_RUNTIME_LOGIN_PASSWORD='GENERATED_PASSWORD' pnpm ops:provision-api-runtime-role
pnpm prisma:migrate:status:owner
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
| `prisma generate` fails | Run with network access to Prisma binaries (set `HTTPS_PROXY` behind a proxy). |
| `@prisma/client did not initialize` | Run `pnpm --filter @bedbanks/api prisma:generate`. |
| API exits at start about superuser/owner login | `DATABASE_URL` must be `fbeds_api_login`, not `postgres`/owner. |
| `DATABASE_URL` error | Confirm the local URL begins with `postgresql://`. |
| Migration status/drift fails | Stop. Do not reset or push schema. Share output with the database owner and prepare a forward-only repair. |
| Login returns 401 | Seed has not run or password differs from `FBEDS_SEED_ADMIN_PASSWORD`. |
| Health reports DB unavailable | Verify local PostgreSQL is running and credentials are correct. |
