# FBEDS — Local Development Setup

## Prerequisites

- Node.js ≥ 20 (`node -v`)
- pnpm ≥ 9 (`pnpm -v`, install with `npm i -g pnpm`)
- PostgreSQL ≥ 15 running locally (`psql --version`)

Create the dev database once:

```bash
psql -U postgres -c "CREATE DATABASE fbeds_dev;"
```

---

## 1. Install

```bash
git clone https://github.com/rammyyadav-dot/bedbanks-system.git
cd bedbanks-system
pnpm install
```

`pnpm install` runs `prisma generate` automatically via the `postinstall`
script in `apps/api/package.json`. This generates the Prisma client from
the schema in `apps/api/prisma/schema.prisma`.

---

## 2. Configure environment

```bash
# API
cp apps/api/.env.example apps/api/.env
```

Edit `apps/api/.env` and set:

```
DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@localhost:5432/fbeds_dev
FBEDS_SEED_ADMIN_PASSWORD=a-strong-local-password
```

All other values in `.env.example` are fine as defaults for local dev.

For the frontends, only set `.env.local` if you need to override the
defaults (the default `NEXT_PUBLIC_API_URL=http://localhost:3001/api/v1`
is correct for local dev):

```bash
cp apps/admin/.env.example apps/admin/.env.local    # optional
cp apps/agent/.env.example apps/agent/.env.local    # optional
```

---

## 3. Apply migrations

```bash
cd apps/api
pnpm exec prisma migrate deploy
```

`migrate deploy` applies the committed migration files in order without
generating new ones. Use this for all environments (dev, staging, prod).

After migrations run you should see:

```
Applying migration `20260101000000_baseline_identity`
Applying migration `20260910000000_p0d_authentication`
All migrations have been successfully applied.
```

> **If you see drift warnings or new migrations generated:** run
> `prisma migrate diff --from-schema-datasource --to-schema-datamodel prisma/schema.prisma`
> to see what changed. This should not happen with a fresh database.

---

## 4. Seed demo data

```bash
# Still inside apps/api
pnpm run db:seed
```

Creates:
- Tenant: `Demo Travel Agency` (slug: `demo-agency`)
- User: `owner@demo-agency.example` with the password from `FBEDS_SEED_ADMIN_PASSWORD`
- Membership: `owner` role

Running seed again on an existing database is safe — it uses `upsert` everywhere.

---

## 5. Start the apps

Open separate terminals:

```bash
# Terminal 1 — API (port 3001)
cd apps/api && pnpm run dev

# Terminal 2 — Admin console (port 3000)
cd apps/admin && pnpm run dev

# Terminal 3 — Agent portal (port 3001 — change to 3002 in package.json if conflict)
cd apps/agent && pnpm run dev

# Terminal 4 — Public website (port 3000 — change if conflict)
cd apps/website && pnpm run dev
```

Or from repo root with Turbo:

```bash
pnpm dev  # starts all apps in parallel
```

---

## 6. Smoke test authentication

With the API running (`pnpm run dev` in `apps/api`):

```bash
# Login — replace YOUR_PASSWORD with FBEDS_SEED_ADMIN_PASSWORD
curl -s -c /tmp/fbeds.txt -X POST http://localhost:3001/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"owner@demo-agency.example","password":"YOUR_PASSWORD"}' \
  | python3 -m json.tool

# Should return:
# { "success": true, "data": { "user": {...}, "memberships": [...] } }
# AND set a Set-Cookie: fbeds_session=... header

# Confirm session works — /me reads the cookie
curl -s -b /tmp/fbeds.txt http://localhost:3001/api/v1/auth/me | python3 -m json.tool

# Logout — revokes the session in the database
curl -s -b /tmp/fbeds.txt -X POST http://localhost:3001/api/v1/auth/logout

# Confirm session is dead — must return 401
curl -s -b /tmp/fbeds.txt http://localhost:3001/api/v1/auth/me
# { "success": false, "error": { "code": "UNAUTHORIZED" } }

# Health check — confirms DB is connected
curl -s http://localhost:3001/api/v1/health | python3 -m json.tool
# { "success": true, "data": { "status": "ok", "database": { "status": "ok" } } }
```

---

## 7. Admin console UI flow

1. Visit `http://localhost:3000/login`
2. Enter `owner@demo-agency.example` and your seed password
3. Should redirect to `/dashboard`
4. Click user menu → Sign out → should redirect to `/login`

---

## Useful commands

```bash
# View the database in a browser UI
cd apps/api && pnpm run prisma:studio

# Re-run seed (safe — idempotent)
cd apps/api && pnpm run db:seed

# Typecheck all apps
pnpm type-check  # from repo root via Turbo

# Run API tests
cd apps/api && pnpm test

# View Swagger API docs (API must be running)
open http://localhost:3001/api/docs
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `prisma generate` fails on install | Run `pnpm install` on a machine with internet access to `binaries.prisma.sh` |
| `DATABASE_URL` validation error on API startup | Check `apps/api/.env` exists and `DATABASE_URL` starts with `postgresql://` |
| Login returns 401 immediately | Seed hasn't been run, or wrong password. Re-run `pnpm run db:seed` with the correct `FBEDS_SEED_ADMIN_PASSWORD` in `.env` |
| Admin shows `/login` but form does nothing | `NEXT_PUBLIC_API_URL` in `apps/admin/.env.local` not pointing at the running API |
| Health endpoint shows `database.status: unavailable` | Postgres isn't running, or `DATABASE_URL` credentials are wrong |
