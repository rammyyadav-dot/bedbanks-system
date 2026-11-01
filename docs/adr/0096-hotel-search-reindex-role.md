# ADR 0096: Hotel search reindex role

## Status
Accepted. Builds the "next step" of ADR 0095. Provisioning is owner-run; nothing is provisioned by the application and no migration is added.

## Context
`HotelSearchIndex` is written only by `ops:reindex-hotel-search`, which needed the schema owner credential. A recurring job must not hold that credential (CLAUDE.md invariant 7), and the strict API role must stay read-only on the index (ADR 0072).

## Decision
A narrow login in the established pattern (ADR 0070, 0079, 0084): `fbeds_search_reindex_ops`, member of the NOLOGIN group `fbeds_search_reindex`, connection limit 2.
- `HotelSearchIndex`: SELECT, INSERT, and UPDATE on exactly the nine columns the upsert sets on conflict. No DELETE, no change to `id`, `tenant_id` or `hotel_id`.
- `Hotel`: column SELECT on `id, tenant_id, name, address, city, country_code, latitude, longitude, updated_at`. No write.
- `tenants`: column SELECT on `id` only (to list tenants).
- Nothing else. Row-level security applies; every use sets the tenant in its transaction. No audit event: the index is derived data rebuilt from `Hotel`, not a privileged or financial mutation.
- `pnpm --filter @bedbanks/api ops:provision-hotel-search-reindex-role` (owner-run, idempotent, revokes before granting) and `ops:verify-hotel-search-reindex-role` (run AS the login: catalogue checks plus 22 `WHERE false` probes).
- `ops:reindex-hotel-search` prefers `HOTEL_SEARCH_REINDEX_DATABASE_URL` and falls back to `MIGRATION_DATABASE_URL` for a first run. Pooled endpoints and unconfirmed remote targets are still refused. The URL must differ from `DATABASE_URL`.

## Not built
The scheduler. An ECS scheduled task (as for `compliance.tf`) running `ops:reindex-hotel-search --apply --fail-on-stale` with the new secret needs Terraform and IAM review that cannot be validated here. Until then, run the CLI after each deploy and use a dry run with `--fail-on-stale` as the freshness gate (ADR 0095).

## Verification
Unit tests for input validation, grant statements (no DELETE, no table-wide UPDATE, no write on `Hotel` or `tenants`), immutable index identity columns, probe shape and revoke-before-grant ordering. On PostgreSQL 16 with look-alike tables: provisioning twice, the verifier (no failures) and 22 of 22 probes; as the role, the stale-selection query and an insert-then-update upsert succeed, a write for another tenant fails row-level security, and DELETE is denied.
Not verified: the real migrations (pgvector is not installable here, so `embedding` was a plain array), the `vector` cast in the real upsert, Neon, or the CLI run end to end as the role.

## Rollback
Run `deprovisionSearchReindexRole` (drops the login and, with `dropGroup`, the group), unset `HOTEL_SEARCH_REINDEX_DATABASE_URL`; the CLI falls back to the owner credential. Revert the code and the two registry lines in `tools/runtime-db-role-check.ts`.
