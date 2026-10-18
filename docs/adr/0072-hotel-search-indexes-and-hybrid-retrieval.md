
## Verification
`tools/hotel-search-smoke.ts` runs against a disposable migrated database with pgvector (see its header for the command). It seeds two tenants and 200,000 filler hotels, then checks hybrid ranking, tenant isolation, typo tolerance, and that the resolver's predicate is answered from the trigram indexes.
Measured on PostgreSQL 16 with 200,000 hotels in one tenant: 5.6 ms with the indexes against 558 ms for a sequential scan. On small tenants (about 3,000 hotels) the planner prefers the tenant b-tree and scans cheaply, which is expected.
`prisma migrate diff` reports `ALTER COLUMN "search_tsv" DROP DEFAULT`, an artifact of Prisma not modelling generated columns. The generated expression stays in the migration.
Not covered by the script: behaviour through a PgBouncer transaction-mode endpoint (the threshold is set with transaction-local `set_config`, which that mode supports).
