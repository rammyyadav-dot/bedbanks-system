# ADR 0095: Hotel search index freshness

## Status
Accepted. Closes the "index freshness" item left open in `docs/database-search-architecture-audit-2026-10-18.md`. No schema, grant or runtime change.

## Context
`HotelSearchIndex` is written only by the owner-run `ops:reindex-hotel-search`; the runtime role holds SELECT only (migration `202610010003`). A hotel edited after its row was written is stale until the next run. Running the job on a schedule needs a credential that can write the table. The only one the CLI accepts is `MIGRATION_DATABASE_URL`, the schema owner, which must not live in a recurring job (CLAUDE.md invariant 7).

## Decision
- Keep writes owner-run. Do not widen the runtime role and do not schedule the job with the owner credential.
- Make staleness observable: `--fail-on-stale` makes the CLI exit 3 when indexable hotels remain stale after the run. A dry run with the flag is a freshness gate for the release checklist or a monitored job, and needs no write. Hotels without a country code cannot be indexed and do not count.
- Exit codes: 0 ok, 2 applied rows did not reconcile (unchanged), 3 stale.
- The suggestions route already reports `indexReady: false` for an unpopulated index rather than "no match" (invariant 5); a partially stale index is not distinguished by it.

## Next step (role built in ADR 0096; scheduler not built)
Automatic freshness needs a narrow reindex role in the existing pattern (hold-expiry, supplier-ingest): INSERT/UPDATE on `HotelSearchIndex` and SELECT on `Hotel`, provisioned by an owner CLI, with an ECS scheduled task. That needs its own migration or provisioning review, rollback notes and terraform review.

## Verification
Unit tests for each exit code, including that unindexable hotels never trigger 3. Not verified: against a populated Neon branch.

## Rollback
Revert `reindexExitCode` and the flag; the CLI returns to exit codes 0 and 2.
