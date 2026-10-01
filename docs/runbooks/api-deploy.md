# Deploying the API (first public environment)

The Admin and Agent apps cannot build or run on Vercel until the API has a public HTTPS URL. This runbook covers the API only. It does not enable booking: `BOOKING_ENABLED` stays unset (off).

## What the API needs

| Dependency | Notes |
|---|---|
| Container host | Any host that runs `Dockerfile.api` and injects `PORT` (Render, Railway, Fly.io). Long-running process; not suitable for Vercel serverless. |
| PostgreSQL 16 with `pgvector` and `pg_trgm` | Migration `202610010003_hotel_search_index` runs `CREATE EXTENSION vector`. Neon supports it. |
| Redis (`REDIS_URL`, `redis://` or `rediss://`) | Search cache. |
| HTTPS | `AUTH_COOKIE_SECURE=true` is mandatory. |

## Environment variables (secret manager, never committed)

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | Runtime URL for `fbeds_api_login` (see below), not the owner URL. |
| `REDIS_URL` | Your Redis URL. |
| `ADMIN_ORIGIN` | Exact public origin of the Admin site, no path and no trailing slash. |
| `AUTH_COOKIE_SECURE` | `true` |
| `API_PREFIX` | `api/v1` (default) |

Leave `HOLD_EXPIRY_SWEEP_ENABLED` and `BOOKING_ENABLED` unset.

## Order of operations

1. **Back up** the database (provider snapshot).
2. **Migrate** as the database owner from a trusted shell, with the owner URL (for Neon use the unpooled URL):
   `DATABASE_URL=<owner url> pnpm --filter @bedbanks/api prisma:migrate:deploy`
   Never run `prisma migrate dev` against this database.
3. **Provision the runtime role** exactly as in `docs/runbooks/api-runtime-role.md` (needs owner approval for a remote database). Build `DATABASE_URL` for the API from `fbeds_api_login`. The API must not run as the table owner: that role has `BYPASSRLS` and tenant isolation would not be enforced (ADR 0008).
4. **Create the service** from `Dockerfile.api`, set the variables above, and deploy.
5. **Smoke test:** `GET https://<api-host>/api/v1/health` returns `status: ok` with `database.status: ok`.
6. **Vercel (Admin project, Root Directory `apps/admin`):** set `API_INTERNAL_URL=https://<api-host>/api/v1` and `AUTH_API_ORIGIN=<Admin public origin>` for Production and Preview, then redeploy. `AUTH_API_ORIGIN` must equal the API's `ADMIN_ORIGIN`.
7. Record the deployed version, migration state and rollback point (`docs/runbooks/deploy.md`, `rollback.md`).

## Not covered

Seeding the first platform administrator, the hold-expiry sweeper role (`hold-expiry-role.md`), and any Agent-origin CORS. The API allows a single credentialed origin, so Agent cannot call it from a browser until a multi-origin policy exists.
