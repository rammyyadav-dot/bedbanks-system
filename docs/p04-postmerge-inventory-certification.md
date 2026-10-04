# P0.4 post-merge certification: inventory, runtime roles and full regression

Local certification on a disposable PostgreSQL cluster. **It is not hosted readiness.** Nothing here deploys, migrates a persistent database, provisions a persistent role, or enables booking, payment or a live supplier.

| | |
|---|---|
| Main / base | `e1e31b746d23fd15e89cd5cd07aba80600a04feb` (merge of PR #246; PR head `61e988942167f38535f74e2799fc2a1768a82a62` is an ancestor: verified with `git merge-base --is-ancestor`) |
| Code under test | `b9cb0c91451cd838085aa993d590f6da922d7398` (every later commit on the branch changes documents only) |
| Toolchain | Node v22.22.2, pnpm 10.4.1 (repository `packageManager`), PostgreSQL 16.13, Prisma 6.19.3 |
| Database classification | A **newly created local cluster** (`pg_createcluster 16 p04cert`, port 5433, listening on localhost, empty at creation). Databases `p04_*`, all created for this run. The repository seed guards accept only `localhost` and `fbeds_ci` or `p04_*`. No persistent database was contacted. Credentials were generated into a 0600 file outside the repository and never printed or committed. |
| Role model used | Owner/migration role `p04_owner`: not a superuser, `CREATEROLE`, `BYPASSRLS`, owns the schema. API runtime role `fbeds_api_login` (group `fbeds_api`) and hold-expiry role `fbeds_hold_expiry_login` (group `fbeds_hold_expiry`), provisioned by the repository's own provisioning code. Fixtures and migrations used the owner; certification of runtime behaviour used the restricted logins. |

## Final gates

| Gate | Result |
|---|---|
| POSTMERGE_BASE_VERIFIED | **PASS** |
| HOTEL_OPERATIONS_FULL_HARNESS | **PASS** 163/163 assertions in one execution (see note on code state) |
| API_E2E_COMBINED | **PASS** 50 of 50 suites, 409 of 409 tests, 0 skipped, **one** `jest --runInBand` execution of every `*.e2e-spec.ts` on a fresh database as the non-superuser owner (255.8 s) |
| API_UNIT | **PASS** 59 suites, 649 tests, 0 skipped (with `REDIS_URL`; 647 passed and 3 skipped without it) |
| ADMIN_AGENT_DOMAIN_TESTS | **PASS** Admin 39, Agent 96, domain 28 |
| TYPECHECK_LINT_BUILD_GUARDS | **PASS** type-check, lint, `check:architecture`, all workspace builds |
| API_RUNTIME_ROLE_RLS | **PASS** with findings (below) |
| HOLD_EXPIRY_ROLE_SECURITY | **PASS** |
| SHARED_POOL_LIFECYCLE | **PASS** |
| INVENTORY_UI_CLARITY | **PASS** (one UI correction made) |
| DISPOSABLE_MIGRATION_REPLAY | **PASS** 37 migrations as a non-superuser owner, twice (role absent and role present at migration time) |
| SCHEMA_DRIFT | **PASS** `prisma:migrate:drift`: "No schema drift." |
| PRODUCTION_CLONE_COMPATIBILITY | **BLOCKED** (below) |
| LOCAL_BROWSER_SEARCH_RECHECK | **PASS** 31/31 |
| RESTRICTED_ROLE_SCALE_100_HOTELS | **PASS** (measured as `fbeds_api_login`; limits below) |
| P04_LOCAL_CERTIFICATION | **PASS (local only)**, with the owner-decision findings above and PRODUCTION_CLONE_COMPATIBILITY BLOCKED |
| PRODUCTION_RELEASE_READINESS | **NOT ESTABLISHED**: production-clone evidence, grant decisions and owner approvals are outstanding |

PRODUCTION_DB_MIGRATION_EXECUTED=NO, PERSISTENT_ROLE_PROVISIONING_EXECUTED=NO, PRODUCTION_DEPLOYMENT_EXECUTED=NO, DNS_OR_ALIAS_CHANGED=NO, LIVE_SUPPLIER_ENABLED_BY_THIS_WORK=NO, BOOKING_ENABLED_BY_THIS_WORK=NO, PAYMENT_ENABLED_BY_THIS_WORK=NO.

## Defects found and fixed

1. **Re-provisioning failed for a non-superuser owner.** `ALTER ROLE ... NOSUPERUSER ... NOBYPASSRLS` on an existing login role is refused on PostgreSQL 16 unless the caller is a superuser. Provisioning (API and hold-expiry) now only changes login attributes for a non-superuser owner and **fails closed** if the existing role already carries an elevated attribute. `deprovisionHoldExpiryRole` likewise needed an explicit membership to `DROP OWNED`.
2. **Agent search and recheck could not run on the restricted API role.** `CancellationPolicy` had no grant. It is row-level secured through its contract's tenant, so `SELECT` was added to the provisioned set. Before this, search on that role returned `provider_unavailable`.
3. **A migration over-grant on the new pool tables.** Migration `202610160001` grants `INSERT, UPDATE` on `InventoryPool` and `InventoryPoolDay` to `fbeds_api` when the role already exists; the authoritative provisioning gives `SELECT` only. `verifyApiRuntimeRole` now fails if the role can write the pool tables, so the difference cannot persist silently; re-provisioning removes it (test `RR-01b`). The merged migration was not edited.
4. **Pooled-plan displays implied the plan's own allotment controls stock.** The calendar now shows the shared pool's capacity, sold and held as authoritative (`(pool)`), marks the plan's value as not used, and the legacy Rates & Inventory workbench warns when the plan is pooled.
5. **Test portability.** Four suites assumed a superuser could `SET ROLE` to roles it creates (PostgreSQL 16 needs an explicit membership for a CREATEROLE owner). `HI-04` read an unordered audit list and failed intermittently; it now orders explicitly. No assertion was weakened.
6. Tooling: the seed guards accept `p04_*` databases on any local port; the scale harness measures on the restricted role and also rechecks; two Hotel Operations assertions track the new Quick Update wording.

## Runtime-role and RLS evidence (no secrets)

Role attributes (catalog): `p04_owner` super=f createrole=t bypassrls=t; `fbeds_api`/`fbeds_api_login` super=f bypassrls=f createrole=f createdb=f replication=f; `fbeds_hold_expiry`/`fbeds_hold_expiry_login` the same restrictions. Both logins own no table or database and belong to exactly one group role.

Policies: `InventoryPool_tenant_isolation` and `InventoryPoolDay_tenant_isolation`, `FOR ALL`, `USING` and `WITH CHECK` `tenant_id = fbeds_current_tenant_id()`; row security enabled **and forced** on both tables and on `RatePlan`, `DailyAvailability`, `InventoryHoldNight`. `fbeds_current_tenant_id()` returns NULL without context, so a connection with no tenant context reads **zero rows** and cannot write (documented fail-closed policy). Context is `SET LOCAL`-scoped (`set_config('app.current_tenant_id', ..., true)`).

Custom guards present: `InventoryPoolDay_stock_check` (0 ≤ sold, held; sold+held ≤ capacity), `InventoryPoolDay_fresh_after_received`, `InventoryPool_name_check`, `InventoryPool_archive_check`, `InventoryHoldNight_counter_check`, `RatePlan_release_time_check`, `RatePlan_release_days_check`, `DailyAvailability_fresh_after_received`; triggers `RatePlan_pool_consistency` (same tenant, hotel and supplier, pool ACTIVE) and `InventoryPool_tenant_guard`; composite `(tenant_id, pool_id)` foreign key.

Grants after authoritative provisioning:

| Role | Pool and stock tables |
|---|---|
| `fbeds_api` | `InventoryPool` SELECT; `InventoryPoolDay` SELECT; `RatePlan`, `DailyAvailability` SELECT; **no** write on any of them; no `InventoryHold`, `InventoryHoldNight`; `CancellationPolicy` SELECT (new) |
| `fbeds_hold_expiry` | `InventoryPoolDay` SELECT and `UPDATE (held, updated_at)` only; `DailyAvailability` SELECT and `UPDATE (held, updated_at)`; `InventoryHold`, `InventoryHoldNight` SELECT; tenants `(id, status)`; audit insert limited by policy to SYSTEM expiry events. No `InventoryPool`, `RatePlan`, `Hotel`, finance or auth tables. |

Tested on real restricted connections (`inventory-runtime-roles`, 13 tests, and `inventory-runtime-http`, 4 tests):
- Attributes, ownership, single group membership, repository verifiers; DDL, `CREATE ROLE`, `DROP POLICY`, `DISABLE ROW LEVEL SECURITY`, `SET ROLE <owner>` all refused; an unauthorised `GRANT` only warns, and the test proves the privilege did not change.
- Own-tenant pool and pool-day reads succeed; the other tenant is invisible even when asked for by filter; no context shows nothing.
- Every pool write by the API role is refused by privilege. Separately, a `NOBYPASSRLS` test role that **does** hold write grants is still refused by the policy (`WITH CHECK`), the composite foreign key and the tenant-guard trigger for: foreign tenant id, foreign pool, foreign hotel or supplier, re-homing a row, and a foreign-row update (0 rows). The owning tenant's write is admitted.
- Connection reuse: one pooled connection alternating tenants, an aborted transaction and a no-context query never leaked context.
- The whole HTTP application on `fbeds_api_login`: Agent search returns the three pooled plans, recheck is authoritative and consumes nothing, Admin summary and calendar read one shared stock of 5; pool creation, Quick Update apply and the release rule **fail closed** (status >= 400) and write nothing; another tenant gets 404.
- **Hold-expiry design is explicit, not assumed equal to the API role.** It may enumerate tenants (`id`, `status` only), but it acts on pool days only inside one tenant context: with no context 0 rows, with a foreign tenant context an update of another tenant's pool day affects 0 rows. It cannot change `capacity`, `sold`, `tenant_id`, `stay_date`, `source` or `fresh_until`, cannot insert or delete, cannot read `InventoryPool`, `RatePlan`, `Hotel`, finance or auth tables, and cannot forge any audit action other than the SYSTEM hold expiry. The sweeper on this role alone expired due holds in **two tenants**, returned each unit to its own pool day exactly once (a second pass found 0), and wrote one SYSTEM audit event per hold.

### Findings that need an owner decision (not changed here)

- **Over-grants by earlier migrations.** Migrations also grant `fbeds_api` write access on `Agency`, `AgencyMember`, `AgencyCreditLimit`, `ApprovalRequest`, `CommercialMarkupRule`, `DistributionRestriction`, `HotelProfile`, `HotelAmenity`, `HotelImage`, `HotelExternalIdentifier`, `RoomAmenity`, `ServiceCase`, `ServiceCaseNote`, `SupplierMutation` when the role exists first, but provisioning revokes them, and an existing test (`department-summaries`) asserts `SupplierMutation` is outside the role. The outcome depends on order. I did not widen provisioning (that would institutionalise `SupplierMutation`) and did not edit merged migrations. Decide: forward-revoke, or an explicit documented write set.
- **Fail-open reads on the strict role.** Under the authoritative grants the HTTP role cannot read `Agency` (suspension not enforced, logged), `DistributionRestriction` (no restriction applied, logged) or `CommercialMarkupRule` (NET rates unsellable). These are existing designed fallbacks, but they mean the strictly provisioned role does not enforce them.
- **Admin mutations are not served by the strict role** (pool, Quick Update, release, and every other supply write): they fail closed with a 5xx, not a clean 403. Admin writes must run on a role the owner approves.
- Holds (`InventoryHold`) cannot be created on the strict role: consistent with transaction gates being disabled.

## Shared-pool lifecycle (`inventory-pool-lifecycle`, `inventory-pool`, `inventory-search-recheck`, `inventory-admin`)

Three plans over capacity 5 expose 5 units (a sixth room is refused whichever plan asks; 30 concurrent holds sell exactly 5); a failed multi-night hold leaves no hold, night, counter or audit change; holds record `counterKind = POOL_DAY` with the exact pool day; prebook then confirm moves held to sold on the pool only, once, with a repeat confirm changing nothing; cancel returns to the original pool day once and a repeat is idempotent, **after the selling plan has left the pool**; expiry and release return exactly once and a forced second release is refused; search and recheck (5 rounds over 3 plans) leave every counter identical; Admin capacity below sold+held is refused, a pool with committed units cannot be archived, and removing members leaves a live hold on its pool day; every counter invariant (never negative, sold+held <= capacity) was swept after each scenario. Transaction gates stay disabled; no supplier or payment provider is called (the supplier adapter is a stub in the confirmation chain).

## Evaluator boundaries (`inventory-semantics`, `zoned-time`, `inventory-search-recheck`)

All four modes; unknown mode closes; missing row or pool day is unknown (never zero); `now == freshUntil` is stale and one millisecond earlier sells; a supplier row without expiry is stale; `now == release deadline` is unavailable and one millisecond earlier sells; hotel-local time zone with Asia/Dubai and America/New_York DST gap (later) and overlap (earlier); invalid zone, empty zone and invalid release time fail closed at the evaluator; CTA on the first night only; CTD on the departure-date row, not on a stay-through night or the check-in date; a missing departure row is not closed; every stay night needs a rate and an inventory row and a snapshot shorter than the stay never sells; ON_REQUEST is visible, priced and never selectable; recheck never substitutes plan, room, board or supplier (SR-11: with an available sibling present, a suspended or closed offered plan rechecks as `unavailable`).

## Browser and scale acceptance

Local production builds of Admin (:3000) and Agent (:3003) against the disposable API and database, headless Chromium: **31/31**. Admin login; Hotels, hotel, Inventory & Allotment; pool capacity 5/0/0/5 across three plans; calendar marks pool numbers authoritative; the workbench warns for a pooled plan; Quick Update preview and apply; reload shows persistence; Agent login and Dubai search shows three limited plans; selection rechecks; Admin sets the pool to 0 and the same offer rechecks **unavailable**; a fresh search no longer offers the hotel; ON_REQUEST rows are labelled and not selectable; empty, unavailable and loading states; a read-only account has no controls and a direct mutation returns **403**; another tenant gets **404**; no horizontal overflow at 1280, 768 and 390 px; axe WCAG A/AA has no violation. The browser journey ran the API on the owner connection, because Admin writes are not served by the strict role (finding above).

Hotel Operations harness (`verify-hotels.cjs`, directory, profile tabs, rooms, amenities, images, policies, mappings, inventory, Quick Update, distribution, permissions, persistence and audit): **163/163 in one execution**, after the Images wait uses a condition (`images-empty` selector) rather than a fixed delay.

Scale (`inventory-scale.ts`, measured as `fbeds_api_login`: not superuser, not BYPASSRLS; 15 samples per measure, so p95 equals the maximum; local single-host numbers, indicative only, not an SLA). Concurrency used the owner connection because the strict role has no hold-write grant.

| Hotels | Plans | Search p50 / p95 | Mismatches / overstated | Recheck samples, p50 / p95, wrong | Admin summary p50 / p95 | Concurrent holds |
|---|---|---|---|---|---|---|
| 1 | 3 | 21.2 / 129.8 ms | 0 / 0 | 3, 18.2 / 19.2 ms, 0 | 9.9 / 14.0 ms | 5 of 12 held, exact |
| 10 | 30 | 38.2 / 129.7 ms | 0 / 0 | 26, 19.2 / 27.9 ms, 0 | 10.2 / 14.7 ms | 45 of 108, exact |
| 100 | 300 | 403.0 / 450.6 ms | 0 / 0 | 60, 31.7 / 40.4 ms, 0 | 14.1 / 28.9 ms | 100 of 240, exact |

For comparison, the earlier superuser measurement of the same 100-hotel search was p50 188 ms: it understated the cost of forced row-level security by about half.

## Migration certification

Fresh database, 37 migrations applied as the non-superuser owner, with and without the group role present at migration time; `prisma migrate status` up to date; `pnpm prisma:migrate:drift` reports no drift. The only difference Prisma reports, and the script tolerates by exact statement, is `DROP INDEX "HotelSearchIndex_embedding_hnsw";`: that HNSW pgvector index is created by raw SQL in `202610010003_hotel_search_index` and Prisma 6 cannot model it in `schema.prisma`. No other difference exists, and none was classified as acceptable without explanation. Clean replay says nothing about production data.

### PRODUCTION_CLONE_COMPATIBILITY = BLOCKED

`node tools/certify-production-clone.mjs --check-config` returns `CLONE_SECRETS_MISSING` / "BLOCKED; production authorization: false": no approved isolated clone, secret or authorised runner exists in this environment, and this mission does not authorise connecting to an unclassified database. Clean replay is **not** substituted. Also, the runner's pinned baseline (`releaseSha 5c19dee`, five pending migrations) predates the current 37 migrations and must be re-pinned by the owner before it can certify this release.

Owner-reviewable prerequisites: (1) an isolated clone (not primary, not default, direct endpoint) whose `_prisma_migrations` history is inspected and recorded; (2) re-pin `releaseSha` and the expected pending list in `tools/clone-certification-guard.mjs` to the clone's baseline and this release; (3) set the environment secrets and approvals in `docs/clone-certification-runner.md`; (4) a recorded decision on the grant findings above; (5) read-only pre-checks on the clone before any write:
`SELECT count(*) FROM "DailyAvailability"; SELECT count(*) FROM "RatePlan";` (existing rows take defaults ALLOTMENT / ADMIN / no expiry / release `00:00`), the `fbeds_api` grants on the new tables, and `SELECT proname FROM pg_proc WHERE proname = 'fbeds_current_tenant_id'`. Then, on the runner only: `node tools/certify-production-clone.mjs --check-config`, then the documented dispatch. None of this was run.

## Skipped tests and caveats

- `redis-cache.adapter.spec` is skipped unless `REDIS_URL` is set (3 tests); with Redis it passes and the full unit run is 650/650.
- The combined e2e run is the one in **PASS** 50 of 50 suites, 409 of 409 tests, 0 skipped, **one** `jest --runInBand` execution of every `*.e2e-spec.ts` on a fresh database as the non-superuser owner (255.8 s). Earlier partial reruns were diagnostic and are not reported as the suite result.
- The Hotel Operations harness and browser run executed on the build of commit `eb969cb`; later commits changed tests, tools and this document only (`git diff eb969cb..HEAD -- apps/*/src apps/*/components apps/*/lib packages` is empty apart from test files).
- Local latency is not a production SLA; the single host runs the database, API and browser together.

## Files changed

See `git diff --stat origin/main..HEAD`: provisioning and verifier (`api-runtime-role.ts`, `hold-expiry-role.ts` and specs), pooled calendar fields (`hotel-commercial.ts`, `operations-hotels.service.ts`, `stay-snapshot.ts`, Admin calendar and workbench), new e2e (`inventory-runtime-roles`, `inventory-runtime-http`, `inventory-pool-lifecycle`, SR-11), evaluator boundary tests, test portability fixes, harness and scale tooling, this record.

## Remaining blockers

1. PRODUCTION_CLONE_COMPATIBILITY: owner action above.
2. Owner decision on the migration over-grants and the fail-open reads of the strict role.
3. Which role serves Admin mutations in production, and whether it keeps forced RLS.
4. Hosted evidence: backup/restore, pool configuration, secret storage, monitoring, authenticated deployment smoke test (unchanged from `docs/postgres-release-controls.md`).
