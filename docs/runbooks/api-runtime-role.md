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
