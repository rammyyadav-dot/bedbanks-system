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

`FUNDING_ENABLED` (ADR 0028 slice 2) stays unset until finance is ready to record agency bank transfers. Before setting it to `true`: apply migration `202610220001_agency_funding_receipts` and grant `funding.manage` to at least two finance users (the declarer can never verify, clear or post the same receipt). Funding writes go to `Wallet` and `LedgerEntry`, which the strict runtime role does not write (ADR 0032), so they need the privileged database connection.

## Database credentials (P0-01)

The service gets only the restricted logins: `DATABASE_URL` (`fbeds_api_login`) and `BOOKING_OPS_DATABASE_URL`. The migration/owner credential (`MIGRATION_DATABASE_URL`, `PROVISION_DATABASE_URL`) belongs to the release job or an operator shell and is never set on the service or a preview environment. The API refuses to start if its login is a superuser, has BYPASSRLS, owns tables or is a known owner name, and `pnpm check:runtime-db-role` fails CI if a service definition says otherwise. Details and rotation: [api-runtime-role.md](api-runtime-role.md), ADR 0040.

## Order of operations

1. **Back up** the database (provider snapshot).
2. **Migrate** as the database owner from a trusted shell, with the owner URL (for Neon use the unpooled URL):
   `MIGRATION_DATABASE_URL=<owner url> pnpm --filter @bedbanks/api prisma:migrate:deploy:owner` (the wrapper hands the owner URL to that one command only)
   Never run `prisma migrate dev` against this database.
3. **Provision the runtime role** exactly as in `docs/runbooks/api-runtime-role.md` (needs owner approval for a remote database). Build `DATABASE_URL` for the API from `fbeds_api_login`. The API must not run as the table owner: that role has `BYPASSRLS` and tenant isolation would not be enforced (ADR 0008).
4. **Create the first administrator** (do not use `db:seed`: it creates a demo tenant and user for local development and grants no `supply.*` or platform permissions). As the database owner, from a trusted shell:
   ```
   PROVISION_DATABASE_URL='<owner url>' \
   BOOTSTRAP_TENANT_NAME='<your company>' BOOTSTRAP_TENANT_SLUG='<lowercase-slug>' \
   BOOTSTRAP_ADMIN_EMAIL='<you@company.com>' BOOTSTRAP_ADMIN_NAME='<your name>' \
   BOOTSTRAP_ADMIN_PASSWORD='<16+ characters>' \
   pnpm --filter @bedbanks/api ops:bootstrap-first-admin --allow-remote --confirm-database=<exact database name>
   ```
   It creates the tenant, a tenant `owner` role holding every tenant permission, the user, and a `platform_owner` role holding every platform permission. It is idempotent; an existing user's password is kept unless you add `--reset-password`. It writes two audit events (ids only) and prints only ids and counts. This is the only path that bypasses the API's self-escalation rule; run it once, then manage further access through the platform admin API. It does not create wallets.
5. **Create the service** from `Dockerfile.api`, set the variables above, and deploy.
6. **Smoke test:** `GET https://<api-host>/api/v1/health` returns `status: ok` with `database.status: ok`. `GET /api/v1/health/ready` is the host readiness check and returns 503 when the database is unavailable, so a process with a failed database is not treated as ready.
7. **Vercel (Admin project, Root Directory `apps/admin`):** set `API_INTERNAL_URL=https://<api-host>/api/v1` and `AUTH_API_ORIGIN=<Admin public origin>` for Production and Preview, then redeploy. `AUTH_API_ORIGIN` must equal the API's `ADMIN_ORIGIN`.
8. Record the deployed version, migration state and rollback point (`docs/runbooks/deploy.md`, `rollback.md`).

## Render

`render.yaml` at the repository root defines the API web service (Docker, readiness check `/api/v1/health/ready`, manual deploys) and a Redis-compatible Key Value instance wired to `REDIS_URL`.

1. In Render choose New, then Blueprint, and select this repository. Render prompts for the two `sync: false` values: `DATABASE_URL` (the `fbeds_api_login` URL from step 3) and `ADMIN_ORIGIN`.
2. The Key Value instance has an empty `ipAllowList`, so it is reachable only from your Render services in the same region (internal URL).
3. The default region is Frankfurt. Keep the database in a nearby region; a Neon or Render Postgres database in another region adds latency to every query.
4. Deploys are manual (`autoDeploy: false`) so a push cannot release an unreviewed migration-dependent build. Run migrations first, then use Manual Deploy.

Render's public URL (`https://fbeds-api.onrender.com`, or your custom domain) is the host for `API_INTERNAL_URL`.

## Portals (Agent, Supplier)

Portals reach the API through a same-origin proxy (ADR 0010), not CORS.

1. Agent Vercel project (Root Directory `apps/agent`): set `API_INTERNAL_URL=https://<api-host>/api/v1` for Production and Preview. The Agent build fails without it. Do not set `NEXT_PUBLIC_AGENT_API_URL`.
2. API (Render): set `TRUSTED_ORIGINS` to the exact production origin of each portal, comma-separated, HTTPS, no path, for example `https://agent.example.com`. Redeploy the API. A portal missing from this list gets 403 `Untrusted request origin` on login.
3. Do not list preview deployment origins.
4. Supplier has no authenticated API client yet; do not add it until it does.

## Not covered

Wallets and credit limits, and the hold-expiry sweeper role (`hold-expiry-role.md`).
