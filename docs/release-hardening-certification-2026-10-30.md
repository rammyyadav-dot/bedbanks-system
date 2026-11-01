# Release hardening certification — 2026-10-30

**Verdict: NOT CERTIFIED FOR PRODUCTION.** Security, migration, backup/restore and PITR evidence is a PASS on a disposable PostgreSQL 16. Performance is a **FAIL** (finding F1). Everything that needs AWS, a container runtime or production-scale data is **NOT VERIFIED** and listed under "Not certified here".

Commit under test: `615020a` (main) plus this change. Nothing was deployed, no production or staging system was contacted.

## Environment (what these results do and do not describe)

| Item | Value |
|---|---|
| Runtime | Node v22.22.0, pnpm 10.4.1 (repo pins Node 24.x; `pnpm` warns on every command) |
| Database | PostgreSQL 16.15 + pgvector 0.6.0 on loopback, 4 vCPU shared with the test runners, no network hop, no PgBouncer |
| Cluster auth | `scram-sha-256` for TCP (as CI). Early runs used `trust`; the two wrong-password e2e failures that produced were an artifact and are re-run below |
| Guard handling | The DB certifiers require `GITHUB_ACTIONS=true`, `NODE_ENV=test`, loopback and a database named `fbeds_ci`. A disposable local database with that name was created and the variables set to satisfy the guard; no guard code was changed |

## Results

| Area | Check | Result | Evidence |
|---|---|---|---|
| Architecture | `pnpm check:architecture` (all 14 gates) | PASS | contracts, boundaries, no-float, no-silent-fallback, ledger single writer, tenant filter, raw SQL (33 audited files), migration safety, public env, runtime DB role (32 client sites), AWS governance, workflow permissions (15 workflows), framework peers, env examples |
| Build quality | `type-check`, `lint` (0 errors, 63 warnings), unit tests across the monorepo | PASS | 44 of 46 turbo tasks green in the parallel run; `@bedbanks/api#type-check` ran out of heap (F4) and passes alone with `--max-old-space-size=8192`; API unit 2296 passed / 14 skipped |
| API e2e | `pnpm --filter @bedbanks/api test:e2e` | PASS | 130 suites in 905 s; first run 3 suites failed for environment reasons (trust auth; restore databases holding role dependencies), all 3 passed on re-run (36 tests) |
| Dependencies | `pnpm check:dependencies` | PASS | no unaccepted high or critical production advisory (1 total, accepted) |
| Secrets | pattern sweep of tracked files (AWS keys, private keys, GitHub/Slack/Stripe/Anthropic tokens, URLs with passwords) | PASS | only test fixtures with obvious dummy values |
| Migration | `prisma migrate deploy` on an empty database | PASS | 132 migrations in about 3 s; `migrate status` up to date; `prisma:migrate:drift`: no drift; ledger chain digest `943c664b…2716` |
| Migration | Strict-role certification (`certify-disposable-runtime-role.cjs`) | PASS | login `fbeds_api_login`, 26 privilege probes, 58 forced-RLS tables, pg_trgm and vector present |
| Security | `test:security` | PASS | 28/28: 401/403 on every non-public route, cross-tenant denial in Admin, Agent and Supplier, session cookie flags, server-side logout, audit append-only for every restricted login |
| Security | `ops:certify-tenant-control`, `ops:certify-runtime-db-identity` | PASS | 18/18; bare, inherited and NOINHERIT roles behave, `SET ROLE`/`RESET` verified |
| Backup/restore | `tools/ops/restore-drill.sh` (pg_dump -Fc, pg_restore into a new database) | PASS | Three sources. 120 tables, 111 forced-RLS, 128 policies, 132 ledger rows and per-table row counts identical. Dump 0.2 s / restore 1.5 s at 0.9 MB; dump 0.7 s / restore 14.4 s at 2.9 MB with 200k rows |
| Backup/restore | Point-in-time recovery (base backup plus archived WAL, `recovery_target_time`) | PASS | Table had 1000 rows; a later `DELETE` left 100; recovery to the instant before the delete returned 1000 rows, promoted cleanly within the 6 s wait after startup |
| Backup/restore | Integrity detection | PASS | The drill failed correctly on a database containing 7 orphan `RolePermission` rows (inserted by e2e fixtures that disable triggers via `session_replication_role`). Orphans were absent from the clean databases; confirms the drill catches referential damage |
| Rollback | `aws-rollback.yml` and `rollback.md`, static review | PASS (static) | refuses non-numeric revision, revisions not ACTIVE, images not digest-pinned, same-revision no-op; waits for stability; fails if the service did not settle on the target or has more than one deployment; records actor and reason |
| Incident | Runbook | FIXED | `incident-response.md` was a three-line stub; now has severities, roles, first-15-minutes, playbooks and closing criteria |
| Observability | Alarm and health review, static | PARTIAL | see F2 |
| Performance | `tools/load/hybrid-search-load.ts` on a 100k-row single-tenant synthetic corpus | **FAIL** | see F1 |

## Findings

### F1 — High — hotel candidate retrieval scans the whole tenant partition on every query

`retrieveHotelCandidates` (`apps/api/src/mapping/hotel-search-index.ts`) wraps `HotelSearchIndex` in `"scoped" AS MATERIALIZED`. The planner therefore cannot use `HotelSearchIndex_embedding_hnsw`, `_name_trgm` or `_search_tsv_idx`. Each of the three retrievers sorts every row of the tenant and country in the CTE.

Measured on 100,000 rows (30,000 in the queried country), `EXPLAIN (ANALYZE)` on the query's shape: CTE scan 24 ms, vector retriever 51 ms, trigram 120 ms, text 87 ms, total about 260 ms single-threaded.

Load test, budget p95 and p99 under 200 ms, zero errors counted separately:

| Concurrency | rps | p50 | p95 | p99 |
|---|---|---|---|---|
| 1 | 5 | 187 ms | 317 ms | 351 ms |
| 8 | 20 | 348 ms | 621 ms | 725 ms |
| 64 | 19 | 2917 ms | 4903 ms | 5023 ms |

At 64 concurrent requests, 20 of 285 hit Prisma's 5 s interactive transaction timeout. Throughput saturates near 20 rps on four cores and latency grows linearly with corpus size, so a large tenant will degrade search and, through the shared pool, other traffic.

Limits of this number: embeddings are random 64-dimension vectors, names are generated, there is one tenant, the connection is superuser on loopback and the machine is small. Treat it as a defect in query shape, not as a capacity forecast.

Related tooling defect: the load tool's "plan" probe runs a simplified, unfiltered `ORDER BY embedding <=> …` and shows an HNSW index scan at 1.3 ms. That is not the production query, so it gives false comfort.

Recommended fix (not applied; it changes retrieval behavior and needs an ADR and recall comparison): drop `MATERIALIZED` and restructure so each retriever filters on `tenant_id` directly; evaluate pgvector 0.8 iterative scan or a per-tenant partial HNSW for filtered ANN; make the probe EXPLAIN the real statement. Re-run this load test on a production-like Neon endpoint with the strict role and a real corpus before release.

### F2 — Medium — alarm coverage is availability-only

Ten alarms exist: API and portal unhealthy and no-healthy-host, API 5xx, RDS CPU and free storage, two compliance-export alarms, one reindex alarm. There is no alarm for response latency, ECS CPU or memory, RDS connections or freeable memory, or for business-level failure (supplier call failure rate, bookings stuck in a non-terminal state, hold-expiry sweeper not running). The API exposes tracing (`apps/api/src/observability`, `packages/tracing`) but no metrics endpoint, so those signals would have to come from logs. An alarm topic with no confirmed subscriber is not monitoring (already noted in `recovery.md`); delivery was not tested.

### F3 — Low — incident runbook was a stub

Fixed in this change.

### F4 — Low — API type-check can exhaust the default Node heap

`pnpm type-check` run in parallel by turbo aborted (exit 134, heap limit). Alone it passes in 45 s with an 8 GB heap. CI sets no `NODE_OPTIONS`; a larger runner or a heap setting on that step would remove the flake risk.

### F5 — Informational

- Full-history migration scan (`check:migration-safety --all`) lists 61 unmarked statements, almost all `CREATE INDEX` without `CONCURRENTLY` on existing tables. Applied migrations are immutable and the gate only applies to new files, so this is the baseline, not a regression. On Neon any similar future index on `Booking` needs the marker and a size review.
- The migration ledger reports 79 migration ids dated after the run date. Ordering is by name and the chain is intact; a clock-skew or id-convention issue would only matter if ids are ever compared with real dates.
- Rollback is application-only. Nothing automated checks that the previous task definition can run against the current schema; `rollback.md` leaves that to a human. A scripted N-1 check (previous release tests against the new schema) would remove that reliance.

## Not certified here

- Executing the `AWS rollback` workflow, RDS snapshot and PITR restore, alarm delivery to a confirmed subscriber, Terraform plan and apply, and any other AWS behavior. No AWS access.
- Container image build and scan (Trivy): no container runtime in this environment.
- Performance on production-scale or production-shaped data, and Neon pooled-endpoint behavior.
- Node 24 (the pinned runtime). CI remains the authority for that.
- Hosted Vercel and API runtime blockers recorded in `hosted-release-certification-2026-10-06.md`. This work did not re-observe them, so they stay open.
- RTO and RPO for production. The numbers above are for megabyte-scale data on loopback.

## Reproduce

```bash
# disposable PostgreSQL 16 with pgvector, database fbeds_ci, scram auth on loopback
pnpm --filter @bedbanks/api prisma:migrate:deploy
pnpm --filter @bedbanks/api prisma:migrate:drift
pnpm --filter @bedbanks/api test:security
SOURCE_URL=postgresql://…@localhost:…/fbeds_ci tools/ops/restore-drill.sh
LOADTEST_DATABASE_URL=… LOADTEST_TENANT_ID=… node --import tsx tools/load/hybrid-search-load.ts
```

## Release gate

Do not promote on this evidence. Before release: resolve F1 and re-run the load test on production-shaped data, close F2 for at least latency and booking/supplier failure, run the restore and rollback drills in staging on AWS and record them in `docs/evidence`, and clear the hosted blockers.
