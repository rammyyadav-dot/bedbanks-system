# Runbook: hotel search reindex role

ADR 0096. Executed by the **database owner**, not CI or an AI session.

1. Dry run the status first against a non-production branch, then production, using the direct (non-pooled) endpoint:
   `PROVISION_DATABASE_URL=… HOTEL_SEARCH_REINDEX_LOGIN_PASSWORD=<32+ URL-safe chars> pnpm --filter @bedbanks/api ops:provision-hotel-search-reindex-role --allow-remote --confirm-database=<name>`
2. Build `HOTEL_SEARCH_REINDEX_DATABASE_URL` from the same host and database with login `fbeds_search_reindex_ops` and that password. Store it in the secret manager only.
3. Certify as the role: `HOTEL_SEARCH_REINDEX_DATABASE_URL=… pnpm --filter @bedbanks/api ops:verify-hotel-search-reindex-role --allow-remote --confirm-database=<name>`. Expect `Result: OK`.
4. Reindex: `… ops:reindex-hotel-search` (dry run), then `--apply`. Gate a release with `--fail-on-stale` (exit 3 when indexable hotels are stale).
5. Rollback: see ADR 0096.

Neon: `vector` and `pg_trgm` must already exist (migrations `202610010003`, `202610180001`). The role needs a direct endpoint; set `connection_limit` low (the role's own limit is 2).
