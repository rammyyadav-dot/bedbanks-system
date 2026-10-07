# API runtime database role

The HTTP process uses `fbeds_api_login`, a member of the NOLOGIN group `fbeds_api`. The role is not a superuser, does not have `BYPASSRLS`, and owns no tables. ADR 0008 records the grant set.

## Provision a local or disposable database

Generate a 32+ character URL-safe password outside the repository. Then, as the database owner:

```
PROVISION_DATABASE_URL=<owner url> \
API_RUNTIME_LOGIN_PASSWORD=<secret> \
pnpm --filter @bedbanks/api ops:provision-api-runtime-role
```

A remote target also requires `--allow-remote --confirm-database=<exact database name>` after the owner has approved the change. The command prints the role and database names only.

Build `DATABASE_URL` with user `fbeds_api_login` and that password. Store it in the secret manager. Do not commit it.

## Rolling out grant changes

For an environment that already has the role, use [strict-role-rollout.md](strict-role-rollout.md): a read-only `status` dry run, the migration, idempotent provisioning and a read-only `verify` as the login role.

## Rollback

```
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM fbeds_api;
DROP OWNED BY fbeds_api_login;
DROP ROLE fbeds_api_login;
DROP OWNED BY fbeds_api;
DROP ROLE fbeds_api;
```

Drop the membership policy only with the forward rollback in `202610010002_membership_authenticated_user`.

## Roles, and who uses which (P0-01, ADR 0040)

| Credential | Variable | Used by | Never used by |
|---|---|---|---|
| Restricted runtime login `fbeds_api_login` (group `fbeds_api`) | `DATABASE_URL` | the API process | migrations, provisioning |
| Booking module login (group `fbeds_booking`) | `BOOKING_OPS_DATABASE_URL` | the API's booking module only | everything else |
| Hold-expiry login | `HOLD_EXPIRY_DATABASE_URL` | the sweeper (off by default) | everything else |
| Migration/owner | `MIGRATION_DATABASE_URL` (migrations), `PROVISION_DATABASE_URL` (provisioning, audit) | release jobs and operators, for one command | any running service, preview environments |

Required invariants for every runtime login: not SUPERUSER, no BYPASSRLS, no CREATEROLE/CREATEDB/REPLICATION, owns no table, function or schema, not a member of a privileged role. The grants are exactly the contract in `runtime-role-contract.ts` (rendered in [strict-runtime-db-role.md](../strict-runtime-db-role.md)); there is no `GRANT ALL`.

**RLS and tenant context.** Every tenant table has ENABLE and FORCE row-level security with the policy `tenant_id = fbeds_current_tenant_id()`, where the setting `app.current_tenant_id` is set per transaction (`PrismaService.withTenant`, `SET LOCAL` semantics, discarded at commit). With no setting, or a garbage value, the policy matches nothing: reads return no rows and writes/inserts are refused. The tenant comes only from the authenticated session, never from a query, header or body. Exempt tables and their reasons: ADR 0040.

**The API verifies itself.** At startup every runtime client checks its own identity and refuses to run as an owner, superuser or BYPASSRLS role (the message names the invariant, never the URL). `DB_RUNTIME_ROLE_GUARD` stays `enforce`; `off` exists only for the test harness.

## Running migrations (owner credential, one command)

```
MIGRATION_DATABASE_URL=<owner url> pnpm --filter @bedbanks/api prisma:migrate:deploy:owner
```

The wrapper puts the value into `DATABASE_URL` for that child process only and refuses if it equals the runtime URL or names a runtime login.

## Verifying a database and a deployment

1. `PROVISION_DATABASE_URL=<owner url> pnpm --filter @bedbanks/api ops:strict-role-rollout audit` (add `--json` for the machine-readable table): owners, forced RLS, runtime privileges. Exit code 1 on any finding.
2. `PROVISION_DATABASE_URL=<owner url> ... ops:strict-role-rollout status`: migration and grant drift.
3. `API_DATABASE_URL=<runtime login url> ... ops:strict-role-rollout verify`: the runtime login's attributes, privileges against the contract, and no-row privilege probes.
4. Start the API: the log line `API database role verified: user=<login> (not superuser, no BYPASSRLS, owns nothing)` confirms the live identity.
5. In CI: `pnpm check:runtime-db-role` (static), `pnpm --filter @bedbanks/api exec jest src/database` and the strict-role e2e suites (`runtime-db-guard`, `runtime-rls-probes`, `api-runtime-role`, `strict-runtime-role-*`), and `ops:strict-role-boot-smoke`.

## Rotating the runtime credential

1. Generate a new 32+ character URL-safe password in the secret manager.
2. As the owner, re-run `ops:provision-api-runtime-role` with it (idempotent: it sets the new password on the same login and re-applies the contract grants).
3. Update `DATABASE_URL` in the secret manager and roll the service. The startup guard re-verifies the identity on each instance.
4. Confirm with `verify`, then retire the old secret. The same procedure applies to the booking and hold-expiry logins with their provisioning commands.

## Strict-role certification

On a disposable PostgreSQL: replay migrations from zero, provision the logins, run the audit, `verify`, the strict-role e2e suites, the boot smoke, and `check:runtime-db-role`. See `apps/api/scripts/certify-disposable-runtime-role.cjs` for the CI form.
