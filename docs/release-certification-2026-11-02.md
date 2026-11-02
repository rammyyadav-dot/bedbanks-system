# Release certification — 2026-11-02

**Verdict: NO-GO for production.** Remediations in this branch are verified on a disposable PostgreSQL 16 loopback cluster and may merge as source hardening. They do not clear the production gate.

Base commit: `8f4bc94b` (`main`). Candidate: this branch (`cursor/release-certification-hardening-5925`). Nothing was deployed. No production, staging, Neon, Vercel, or AWS account was contacted. Booking remains fail-closed (`BOOKING_ENABLED=false`).

## Recommendation

| Decision | Scope |
|---|---|
| **NO-GO** | Production promotion, staging soak as a release rehearsal, enabling booking, or treating search as within budget |
| Merge allowed | The remediations below (query fence, alarms, type-check heap, restore-drill timing). They close F2/F4 as *code* and improve F1; they do not pass the 200 ms search gate |

Mandatory-gate rule from this certification: Sev-1 tenant/money/restore blockers, or a failed mandatory performance budget, is NO-GO. F1 still fails that budget. AWS restore/rollback/alarm *delivery* remain unverified. CONDITIONAL GO would require reclassifying F1 as non-blocking; the 2026-10-30 cert treated it as blocking, and this run does not weaken that.

## Environment (what these results do and do not describe)

| Item | Value |
|---|---|
| Runtime | Node v24.22.2, pnpm 10.4.1 (repo pin), 4 vCPU, ~16 GiB RAM |
| Database under test | PostgreSQL 16.15 + pgvector 0.6.0 on loopback, `scram-sha-256`, no PgBouncer, no network hop |
| PITR cluster | Dedicated `initdb` instance on `127.0.0.1:5434` / recovered on `:5435`; `archive_mode=on`. The shared `fbeds_*` cluster still has `archive_mode=off` |
| Guard handling | Disposable databases named `fbeds_ci`, `fbeds_restore_src`, `fbeds_mig_interrupt`. `GITHUB_ACTIONS=true` and `NODE_ENV=test` set only for local certifiers that require them. No guard code was weakened |
| Timezone of timestamps in this document | Asia/Calcutta (IST, UTC+5:30) unless a value is labelled otherwise |

## Certification matrix

| Area | Check | Result | Evidence |
|---|---|---|---|
| Architecture | `pnpm check:architecture` (14 gates) | **PASS** | contracts 49 controllers; boundaries; no-float 147 files; no silent fallback 30 files; ledger single-writer 447 files; tenant-filter 421 files / 104 models; raw SQL 534 files / 33 audited; migration safety; public env; runtime DB role 1220 files / 33 client sites; AWS governance; 15 workflows; framework peers; env examples |
| Build quality | `@bedbanks/api` `type-check` with 8 GiB heap | **PASS** | ~27 s, exit 0. F4 remediation. Parallel turbo type-check not re-run as a full monorepo matrix in this turn |
| Mapping / health unit | `hotel-search-index.spec.ts`, `health.controller.spec.ts` | **PASS** | 15/15. Readiness 503 while draining, liveness stays ok |
| AWS governance tests | `node --test tools/aws-governance-check.test.mjs` | **PASS** | 49/49, including removal of `TargetResponseTime` and `DatabaseConnections` alarms |
| Dependencies | `pnpm check:dependencies` | **PASS** | no unaccepted high/critical production advisory (1 total, already accepted) |
| Secrets | tracked-file pattern sweep | **PASS** | no live AWS keys, private keys, GitHub/Slack/Stripe/Anthropic tokens. Hits are CI dummy `postgres:postgres@localhost` URLs. `gitleaks` not installed |
| Hotel search e2e | `test/hotel-search-index.e2e-spec.ts` | **PASS** | 4/4: active-tenant only; 100 hotels no cross-tenant; full shortlist when other tenants hold nearest neighbours; restricted role with no tenant context returns no rows |
| Health e2e | `test/health.e2e-spec.ts` | **PASS** | 5/5: `/api/v1/health` 200 envelope, `X-Request-ID` echo/generate, 404 envelope |
| Security (prior turn, same tree) | `pnpm --filter @bedbanks/api test:security` | **PASS** (not re-run this turn) | 28/28: 401/403 on non-public routes, cross-tenant denial, cookie flags, logout, audit append-only |
| API unit (prior turn, same tree) | `test:unit` | **PASS** (not re-run this turn) | 215 suites / 2404 tests |
| Performance | `tools/load/hybrid-search-load.ts` 10k-row AE corpus, budget p95/p99 &lt; 200 ms | **FAIL (F1)** | see Performance. EXPLAIN is the production statement via `explainHotelCandidates` |
| Migration | ledger + `migrate status` + drift on `fbeds_mig_interrupt` | **PASS** | 134 migrations, digest `ee31ece5638b8de5837c9f3082d6dd64c84e47ad359757b27ac55d2532817add`, schema up to date, no drift. 79 ids dated after today (name convention, chain intact) |
| Backup / logical restore | `tools/ops/restore-drill.sh` on clean `fbeds_restore_src` | **PASS** | dump 0.86 s, restore 0.94 s, 775 626 bytes, fingerprint `122\|2f5cece6…\|112\|127\|134` (tables, row-count digest, forced RLS, policies, migrations) |
| Backup / integrity detection | same drill on e2e-polluted `fbeds_ci` | **PASS (detected)** | `pg_restore` aborted on orphan `SupplierPaymentTerms.tenant_id` (e2e `session_replication_role` fixture). Drill fails closed |
| Backup / PITR | base backup + archived WAL + `recovery_target_time` | **PASS (local only)** | 1000 rows → DELETE left 100 → recover to instant before delete → 1000 rows, promoted. Not RDS PITR |
| Observability | Terraform alarms + governance guard | **PASS (static)** | F2 code closed. SNS subscriber / delivery **NOT VERIFIED** |
| Incident | runbook + readiness 503 unit | **PASS (tabletop / unit)** | `incident-response.md` playbooks; drain 503 covered. No live page to a mailbox |
| Rollback | `aws-rollback.yml` + `docs/runbooks/rollback.md` | **PASS (static)** | abort thresholds and post-rollback verify steps added. Workflow not executed |
| Hosted portals / AWS deploy | Vercel, ECS, RDS snapshot | **NOT VERIFIED** | no credentials, no authorization |

## Changes made in this branch

1. **Hotel candidate SQL (F1, partial).** `vector_scope AS MATERIALIZED` remains the tenant fence for the vector retriever (ADR 0073: planner must not walk the shared HNSW index then filter). Trigram and lexical retrievers filter `"tenant_id"` (and country) on `"HotelSearchIndex"` so they can use GIN indexes. `explainHotelCandidates` EXPLAINs this production statement; the load tool no longer probes a simplified HNSW-only query.
2. **Loopback corpus seeder** `tools/load/seed-hotel-search-corpus.ts` (owner connection, refuses non-loopback) and runtime-db-role allow-list entries for the seed and load scripts.
3. **Alarms (F2).** CloudWatch alarms for API target p95 `TargetResponseTime` 750 ms, ECS CPU/memory 80 %, RDS `DatabaseConnections` 80, RDS `FreeableMemory` 256 MiB. Governance check fails if they are removed. `recovery.md` lists them.
4. **Rollback runbook.** Abort thresholds (5 consecutive minutes) and a five-minute post-rollback verify list.
5. **Type-check heap (F4).** `@bedbanks/api` `type-check` and the CI verify `turbo type-check lint` job set `NODE_OPTIONS=--max-old-space-size=8192`.
6. **Restore drill timing.** `elapsed()` uses `awk` so the drill does not depend on `bc`.

## Performance

Corpus: 10 000 `HotelSearchIndex` rows, one tenant, country `AE`, hashed-token embeddings, loopback superuser. Budget: p95 and p99 under 200 ms, errors counted separately. `LOADTEST_MIN_ROWS` default is 100 000; this run set 10 000 because a 100k seed was not re-built in this environment.

Confirmation run (8 s steps; Asia/Calcutta 2026-11-02):

| Concurrency | rps | n | err | p50 | p95 | p99 | max |
|---|---|---|---|---|---|---|---|
| 1 | 5 | 40 | 0 | 199.7 ms | **227.6 ms** | **241.0 ms** | 241.0 ms |
| 8 | 20 | 158 | 0 | 403.9 ms | **479.9 ms** | **568.9 ms** | 616.3 ms |

Longer prior-turn run on the same corpus (same query): c=1 p95 228.0 / p99 229.8; c=8 p95 465.5 / p99 518.3. Same FAIL.

`EXPLAIN (ANALYZE, BUFFERS)` of the production statement, execution **112.8 ms**:

- `vector_scope`: Seq Scan of all 10 000 tenant/country rows (MATERIALIZED fence; HNSW unused by design).
- Trigram: Seq Scan, 589 rows after `%` + tenant + country filter. GIN `_name_trgm` not chosen.
- Lexical: Bitmap Index Scan on `HotelSearchIndex_search_tsv_idx`, then heap 6 863 rows (broad OR tsquery).
- Fuse + lookup: index scan on `HotelSearchIndex_tenant_id_hotel_id_key`.

Versus 2026-10-30 (100k rows, whole-tenant MATERIALIZED CTE, ~260 ms single query): vector fence is unchanged; trigram/text no longer sort every materialized row; GIN is used for tsvector only. The 200 ms budget still fails on this VM at 10k rows. Limits of the number: random 64-d embeddings, generated names, one tenant, superuser loopback, small machine. Defect in query cost remains; this is not a capacity forecast.

F1 is **not closed**. Next work (needs its own ADR if recall can change): selective trigram plan (`pg_trgm.similarity_threshold` / index-friendly predicate), tighter lexical query, or a per-tenant partial HNSW once pgvector iterative scan is a guaranteed version. Re-run on a production-shaped Neon pooled endpoint as the strict runtime role before any GO.

## Security

- Architecture tenant-filter and raw-SQL gates pass after the query change.
- Hotel-search e2e proves ADR 0073 recall still does not leak across tenants.
- Secret sweep: dummy CI connection strings only.
- `test:security` 28/28 from the prior turn on this working tree (not re-run this turn).
- Container image scan (Trivy): **NOT VERIFIED** (no container runtime).
- OWASP ZAP / authenticated portal crawl: **NOT VERIFIED**.

## Migration / backup

- Chain: `20260101000000_baseline_identity` … `202612190001_market_validity_profiling`, 134 files, digest `ee31ece5638b8de5837c9f3082d6dd64c84e47ad359757b27ac55d2532817add`.
- `prisma migrate deploy` on empty `fbeds_mig_interrupt` (prior turn) idempotent; this turn `migrate status` up to date; `prisma:migrate:drift` no drift.
- Logical restore PASS on a clean migrated database; integrity FAIL-closed on polluted `fbeds_ci`.
- Local PITR PASS: recovery target `2026-11-02 02:05:22.368003+00` (07:35:22 IST). Shared cert cluster was not restarted (`archive_mode` left off there).
- RDS automated backup / snapshot restore / production RPO/RTO: **NOT VERIFIED**.

## Observability / incident

- New alarms exist in Terraform and are required by `tools/aws-governance-check.mjs`. Topic subscription is still `count = var.alarm_email == "" ? 0 : 1`. An alarm with no confirmed subscriber is not monitoring.
- API tracing package exists; no Prometheus metrics endpoint. Saturation still comes from CloudWatch.
- Incident runbook (severities, first 15 minutes, playbooks) is in place. Tabletop: search-over-budget is Sev 2; restore/PITR path is `recovery.md`; supplier failure must surface (no silent fallback — architecture gate). Live SNS page not executed.
- Shutdown: unit test confirms `/health/ready` throws “Shutting down” (HTTP 503 at the controller) while `/health` liveness stays `ok`.

## Deployment / rollback

- Promotion still requires the five CI jobs named in `aws-deploy.yml` on the exact SHA; production additionally requires `main` plus a successful staging deploy. Migrations remain owner-run, not part of deploy.
- `aws-rollback.yml` (static): environment-gated, refuses unpinned images, waits for stability, records actor/reason. Not executed.
- Abort if, for five consecutive minutes after the new revision serves traffic: API 5xx &gt; 20 in 5 min, API p95 &gt; 750 ms, zero healthy hosts, RDS CPU &gt; 80 % with rising errors, or ECS circuit-breaker self-rollback.
- After rollback (target &lt; 5 min): `GET /api/v1/health` and `/health/ready` 200; one synthetic sign-in; agent search for a known fixture hotel; `prisma:migrate:status` still matches this chain. If the aborted release applied a migration the previous image cannot run, do not roll the API back.
- Application rollback of this branch: revert the TypeScript query (ADR 0073 rollback section). Terraform alarm removal is a separate apply. No migration was added.

## Ranked findings

| ID | Sev | Status | Finding |
|---|---|---|---|
| F1 | High | **OPEN** | Hybrid retrieval p95/p99 still over 200 ms at 10k rows. Vector path is an exact tenant seq scan. Trigram does not use GIN. Lexical GIN matches ~69 % of the corpus for generated names |
| F2 | Medium | **CODE CLOSED / DELIVERY OPEN** | Latency and saturation alarms exist in Terraform. SNS delivery to a confirmed subscriber is unverified. No business-level alarms (supplier failure rate, bookings stuck non-terminal, sweeper heartbeat) |
| F4 | Low | **CLOSED** on this tree | API `type-check` heap 8 GiB in package script and CI verify job; isolated run passes |
| F5 | Info | OPEN (baseline) | Historical `CREATE INDEX` without `CONCURRENTLY` remains in applied migrations; N-1 image vs current schema is still a human check |
| F6 | Info | OPEN | Full Playwright `@bedbanks/e2e` and the complete 131-file API e2e suite were not re-run in this turn. Selected mapping/health/security suites pass |

## Remaining blockers before GO

1. Close F1 on a production-shaped corpus (strict role, pooled endpoint, realistic names/embeddings) with p95/p99 under 200 ms, zero errors, and an EXPLAIN of the production statement showing acceptable plans.
2. Owner-run staging: RDS snapshot restore to a **new** instance, `prisma:migrate:status` + tenant-control cert, record in `docs/evidence`.
3. Owner-run: AWS rollback workflow on staging; confirm abort thresholds against real alarms.
4. Confirm SNS `alarm_email` (or on-call) is subscribed and a test alarm is delivered.
5. Clear hosted-portal blockers in `docs/hosted-release-certification-2026-10-06.md` if those surfaces are in the release.
6. Explicit written authorization before any production deploy, failover, or real-financial test. Booking stays off until that authorization names it.

## Release checklist (this SHA)

- [x] Architecture 14/14
- [x] API type-check (8 GiB heap)
- [x] Mapping + health unit; hotel-search + health e2e
- [x] Dependency audit
- [x] Secret pattern sweep (gitleaks unavailable)
- [x] Migration chain + status + drift
- [x] Logical restore drill (clean PASS, polluted FAIL-closed)
- [x] Local WAL PITR
- [ ] Hybrid search budget 200 ms — **FAIL**
- [ ] AWS snapshot restore / RDS PITR
- [ ] AWS rollback workflow
- [ ] Alarm delivery
- [ ] Full API e2e + Playwright this turn
- [ ] Image build + Trivy
- [ ] Staging soak
- [ ] Production authorization

## Reproduce

```bash
# disposable PostgreSQL 16 + pgvector, loopback
pnpm check:architecture
pnpm --filter @bedbanks/api type-check
pnpm --filter @bedbanks/api exec jest src/mapping/hotel-search-index.spec.ts src/health/health.controller.spec.ts --runInBand
MAPPING_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/fbeds_ci \
  pnpm --filter @bedbanks/api exec jest --config ./test/jest-e2e.json --runInBand test/hotel-search-index.e2e-spec.ts
SOURCE_URL=postgresql://postgres:postgres@127.0.0.1:5432/fbeds_restore_src tools/ops/restore-drill.sh
LOADTEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/fbeds_ci \
  LOADTEST_TENANT_ID=<tenant> LOADTEST_MIN_ROWS=10000 LOADTEST_STEPS=1,8 LOADTEST_DURATION_S=8 \
  node --import tsx tools/load/hybrid-search-load.ts
```
