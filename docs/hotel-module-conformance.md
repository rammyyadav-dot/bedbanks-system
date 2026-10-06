# Hotel module audit and stay diagnostics

## Source and scope

Implementation base: `b6fbf4e7947213980b448a758b978f7cd7602673`, tree `67cd5e7180b5d7e8f25f4dc973b0edc7a7fa5652`. Branch: `feat/hotel-module-readiness-and-workflows`. This report supersedes the older module conformance record only for the stay diagnostic changes below. Historical test counts in older reports are not evidence of a new run.

Validated implementation head: `6c8e50755af8d08d7930c9b5799c7bda74ba3799`, tree `ef908bdf1a055d40d487d3a2adcb098fe9440c8b`. The following evidence commit adds this report only; its final head/tree and exact-head CI status are recorded in the draft PR and final delivery, avoiding a self-referential commit hash in this file.

F01 remains OPEN. Its candidate remains `aea042299bdc2b7fbc33945b0cb89ba0a7a04238`; this work does not certify or change it.

## Requirement matrix (inspected on `b6fbf4e`, then extended by this branch)

Legend: IMPLEMENTED (code present, permission-controlled, audited where it mutates, with a named test), PARTIAL (what is missing is stated), MISSING, BLOCKED (dependency stated), OUT_OF_SCOPE. "Evidence" names existing suites; whether they ran is stated in the validation record, not here.

| Requirement | Status | Source | Evidence / gap |
|---|---|---|---|
| Hotel directory: server pagination, filters, identity, lifecycle, empty/denied/conflict states, Add hotel | IMPLEMENTED | `apps/admin/app/(dashboard)/hotels/page.tsx`, `operations-hotels.service.ts` (`list`), `hotels/new/page.tsx` | `hotel-commercial.e2e-spec.ts`; `verify-hotels.cjs` |
| Hotel workspace tabs (overview, setup, rooms, amenities, images, policies, mappings, contracts, rates, inventory, quick update, distribution, bookings, audit) | IMPLEMENTED | `hotels/[id]/page.tsx`, `components/hotels/panels/*` | `verify-hotels.cjs`. Rate Plans and Rates Calendar live in "Contracts & Rate Plans" and "Rates & Inventory"; Quality & Publication is Hotel Setup plus Distribution & Readiness; no second editor was added |
| Setup, duplicate search, draft, maker-checker publication, stale-version rejection | IMPLEMENTED | `hotel-setup/*`, `hotel-publication.service.ts`, ADR 0021/0022 | `hotel-setup.e2e-spec.ts`, `strict-runtime-role-hotel-setup.e2e-spec.ts` |
| Rooms, amenities, images, policies; archive not delete; canonical occupancy rule | IMPLEMENTED | `hotel-rooms.service.ts`, `hotel-room-rules.ts`, `hotel-images.service.ts`, ADR 0027 | `hotel-room-rules.spec.ts`, `hotel-images.e2e-spec.ts`. Image rights, malware scan, EXIF stripping: MISSING (policy and a scanning service) |
| Supplier hotel/room/board mapping governance | IMPLEMENTED | `supply/mapping.service.ts`, ADR 0004/0009 | `supply.e2e-spec.ts`, `hybrid-match.spec.ts` |
| Contracts, markets, nationalities; sale dates vs stay dates | PARTIAL | `contract-market` rules (`supply/market-rules.ts`), ADR 0035 | `market-rules.spec.ts`, `contract-market-enforcement.e2e-spec.ts`. Booking-window display vs travel window remains PARTIAL |
| Rate plans, nightly integer-minor rates, NET markup, cancellation | IMPLEMENTED | `rate-certification/*`, `supply/markup-rules.ts`, ADR 0018/0033/0034 | `rate-certification.e2e-spec.ts`, `daily-rate-amount-positive.e2e-spec.ts`. Tax lines, supplements, extra-bed and child charges: MISSING (no charge model) |
| Inventory modes, shared pools, release deadlines, freshness | IMPLEMENTED | `supply/contracted-sellability.ts`, `stay-snapshot.ts`, `zoned-time.ts`, ADR 0030 | `inventory-semantics.spec.ts`, `zoned-time.spec.ts`, `inventory-pool*.e2e-spec.ts` |
| Pool capacity editing, per-plan consumption, provenance preserved | IMPLEMENTED | `inventory/pool-capacity.service.ts`, ADR 0036/0037 | `pool-capacity-editor.e2e-spec.ts`, `strict-role-rollout.e2e-spec.ts` |
| Distribution restrictions, agency suspension, markup controls | IMPLEMENTED | `supply/distribution-restrictions.ts`, `agent/agency-suspension.guard.ts`, ADR 0018/0019/0020 | `distribution-restrictions.spec.ts`, `markup-rules.spec.ts` |
| Supplier sandbox staging, checkpoints, lease fencing, quarantine | IMPLEMENTED (sandbox only) | `sandbox/sandbox-content-store.ts`, `docs/supplier-sandbox-integration.md` | `sandbox-content-staging.e2e-spec.ts`. No live supplier, by design |
| Agent search, authoritative recheck, no allocation on recheck | IMPLEMENTED | `agent/agent-search.service.ts`, `contracted-inventory.adapter.ts`, `offer-hold.service.ts` | `inventory-search-recheck.e2e-spec.ts`, `dubai-agent-search.e2e-spec.ts`. Hosted journey NOT_VERIFIED |
| Per-plan buyer-aware stay diagnostic | IMPLEMENTED | `hotel-stay-readiness.ts`, `operations-hotels.service.ts` (`sellability`) | `hotel-stay-readiness.spec.ts`, `hotel-commercial.e2e-spec.ts` (earlier commits on this branch) |
| **Unified readiness: seven gates, PASS/FAIL/UNKNOWN/NOT_APPLICABLE, criteria, references, action** | **IMPLEMENTED (this change)** | `packages/contracts/src/hotel-readiness.ts`, `supply/hotel-readiness.ts`, `operations-hotels.service.ts` (`readiness`), `panels/ReadinessPanel.tsx`, ADR 0038 | `hotel-readiness.spec.ts` (16), `hotel-readiness.e2e-spec.ts` (9, runtime role), `verify-hotel-readiness.cjs` (29) |
| Search/recheck certification evidence per hotel | MISSING (reported UNKNOWN) | `offer.recheck.*` audit rows carry the offer id only | Needs a per-hotel evidence record; see Remaining work |
| Child-age pricing, extra-bed policy, mixed-room parties, FX | MISSING | no schema, no policy | Child ages are validated and disclosed as not assessed |
| Production rollout, persistent roles, live suppliers, booking, payment | OUT_OF_SCOPE | n/a | Not performed |

## Unified readiness (this change)

ADR 0038. One read-only endpoint, `GET /admin/operations/hotels/:hotelId/readiness`, route `hotelReadiness` in `@bedbanks/contracts`. It composes `assessCompleteness`, `evaluateContractedStay` (with the stated buyer) and the existing agency controls. It does not replace the Hotel 360 window gates or the per-plan stay diagnostic; both classify reasons from `SELLABILITY_GATES`.

| Gate | Judged from | UNKNOWN when |
|---|---|---|
| CONTENT | Twelve publication requirements | Profile unreadable by the runtime role |
| MAPPING | `SUPPLIER_MAPPING_INVALID` per rate plan; hotel mapping when no plan exists | n/a |
| CONTRACT | Supplier, contract, plan, room, occupancy, stay rules, market and nationality | n/a |
| RATE | Every night priced in the stated currency; NET needs a markup rule | n/a |
| INVENTORY | Availability, stop-sell, closure, freshness, stock (plan or pool), ON_REQUEST | n/a |
| DISTRIBUTION | Published, rated hotel; agency suspension and restrictions | Agency restrictions unreadable |
| SEARCH_RECHECK_EVIDENCE | Nothing persisted per hotel | Always (the prediction is shown, labelled as a prediction) |

Rules asserted by tests: UNKNOWN is never FAIL; a missing rate or stock is a named failure, never zero; unknown nationality fails closed against a restricted contract; gates passing on different plans do not make a PASS verdict; unreadable agency controls remove predicted offers; the prediction agrees with Agent search for five nationality/market/restriction cases (`HR-E07`).

## Permission and database-principal matrix (additions)

| Operation | User permission | Database principal |
|---|---|---|
| Readiness without an agency | `supply.rates.read` | Existing runtime-role reads; profile read behind a SAVEPOINT |
| Readiness naming an agency | Above plus existing `agency.read` (shared check with the stay diagnostic) | Agency and DistributionRestriction reads; denial is UNKNOWN |

No grant, permission-catalogue entry, migration or role contract changed. The application under test in `hotel-readiness.e2e-spec.ts` and in the browser harness connects as `fbeds_api_login`: not superuser, not BYPASSRLS, not owner (asserted by `HR-E01`).

## Authority and workflow map

| Area | Existing authority | Audit finding / scope |
|---|---|---|
| Hotel directory and workspace | `operations-hotels.service.ts`, hotel directory and `[id]` page | Existing canonical IDs, tenant filtering, pagination, tab permissions and commercial assessment; preserve |
| Profile, amenities, images, policies | `hotel-setup` module; ADR 0021, 0022, 0027 | Existing setup and maker-checker publication; preserve. Publication does not enable transactions |
| Rooms | Rooms module and canonical occupancy rules | Existing authoring/archive/restore; no duplicate room model |
| Supplier hotel/room mappings | Supply mappings services and mapping approvals | Existing explicit approvals; no auto-match or supplier ID used as canonical identity |
| Contracts and rates | Supply contracts/rate plans, ADR 0029, 0035 | Existing integer money, NET markup and market/nationality rules; diagnostic loader now includes those rules |
| Inventory and pools | Canonical stay snapshot/evaluator, ADR 0030, 0037 | Existing ALLOTMENT/FREE_SALE/ON_REQUEST/CLOSED, shared counters, freshness and hotel-local release deadlines; preserve |
| Capacity and attribution | Pool capacity service and strict runtime contract | Existing protected counters, idempotency, audit and provenance; no change |
| Distribution | Agency suspension and distribution restrictions | Existing Agent controls; selected-agency diagnostic now assesses suspension and hotel/supplier restrictions |
| Agent search and recheck | Agent adapter, `evaluateContractedStay`, offer/recheck services | Preserve authoritative evaluator. Diagnostic is not proof of a hosted journey |
| Operations readiness | Existing sellability endpoint and Admin inspector | Add structured per-plan gates and buyer context; fix pooled remaining stock display |

Canonical relationships remain Hotel → RoomType → RatePlan → Contract → Supplier; contracts link to hotel through supplier hotel mappings and plans, not a new direct foreign key. Supplier room mappings resolve to canonical rooms. Board bases remain canonical plan references. Inventory is per plan or shared pool; three plans drawing from five rooms have five stock units.

## Implemented diagnostic slice

Enhances the existing GET sellability endpoint; no new endpoint, catalogue permission, table, migration or grant. Existing `supply.rates.read` remains mandatory. Providing an agency ID additionally requires existing tenant-scoped `agency.read` before agency information is loaded. Cross-tenant agency IDs return 404. Control read failures remain sanitized commercial-control errors, never unrestricted inventory.

Criteria: check-in inclusive/check-out exclusive; existing 1–31 night and party validation; optional canonical room and agency IDs; two-letter guest nationality; optional AED request currency. Market is derived server-side from the selected agency. No currency conversion is introduced. Per-room party is repeated uniformly for multiple rooms. Heterogeneous room parties, child ages and child pricing policies are not assessed.

The canonical stay evaluator handles each occupied night, mappings, contracts, rate basis, markup, occupancy, stock mode, stale inventory, stop-sell, CTA, CTD and hotel-local release rules. Existing suspension and restriction authorities narrow the result. No query allocates a hold or writes inventory. Missing pool nights remain unknown/missing, never zero. Capacity editing does not modify provenance or freshness in this change.

Gate states are per plan, never assembled from different plans into a false passing offer. Each gate carries reasons, hotel/room/plan references, evaluation time, a reference to the response stay criteria and permission-aware navigation. Buyer and requested currency context accompany those criteria. Missing buyer context, unspecified currency and unsupported child policy assessment are UNKNOWN. Unfamiliar blocking reasons remain FAIL. Absent plans produce no invented PASS gates. Agent search/recheck certification is always UNKNOWN here; hosted certification remains NOT_VERIFIED.

The UI clears results when criteria change and ignores late responses for old criteria. Whole-stay buyer eligibility is separate from supply-only night diagnostics. The workspace coverage label explicitly says buyer-independent.

## Permissions and database principals

| Operation | User permission | Database principal / access |
|---|---|---|
| Hotel workspace | `supply.hotels.read`; each tab keeps its existing permission | Existing forced-RLS runtime reads |
| Stay diagnostic | `supply.rates.read` | Existing hotel, room, mapping, contract, rate and inventory reads |
| Selected agency diagnostic | Above plus `agency.read` | Existing tenant-scoped Agency, DistributionRestriction and role/permission reads; no grants added |
| Profile publication and authoring | Existing setup/maker-checker permissions | Existing strict-runtime column write set and transactions; untouched |
| Capacity authoring | Existing preview/apply permissions | Existing protected column contract; no privilege expansion |
| Test fixture creation | Test harness only | Disposable owner connection; application under test uses provisioned non-owner/non-superuser/non-BYPASSRLS login in `inventory-runtime-http` |

## Workflow

1. Create the canonical hotel draft and complete existing setup requirements.
2. Author rooms, amenities, images and policies; submit and approve publication through the existing second-approver workflow.
3. Approve supplier hotel/room mappings and configure eligible contracts, canonical boards, rates, markup and restrictions.
4. Author inventory through existing protected workflows; preserve shared-pool identity, provenance and freshness.
5. Inspect a requested stay. Fix the named blocker through an authorized tab; reevaluate after the change. No diagnostic automatically publishes, approves, replenishes or enables transactions.
6. Run a real Agent search and authoritative recheck with the same criteria before certification. Hosted acceptance is a separate runbook gate.

## Files and migrations

Changes are limited to the contracts, existing operations controller/service, canonical gate presentation, Admin inspector and workspace label, new readiness presentation unit suite, two existing database HTTP suites, the existing browser harness and this report. No schema, migration or runtime-role contract changes.

## Validation record

Tools: Node v24.19.0 / pnpm 10.4.1. Nested scripts use a scratch-only pnpm wrapper because the environment default pnpm points at a different major; no repository tooling was changed.

| Exact command (pnpm 10.4.1) | Result |
|---|---|
| `pnpm install --frozen-lockfile --ignore-scripts` | PASS; client generation executed explicitly below |
| `pnpm --filter @bedbanks/api prisma:generate` | PASS; generation only, no database connection/migration |
| `pnpm check:architecture` | PASS |
| `pnpm check:schema` | PASS |
| `pnpm type-check` | PASS, 14/14; repeated on final implementation |
| `pnpm lint` | PASS, 14/14; one existing unused-disable warning; repeated on final implementation |
| `pnpm --filter @bedbanks/api test:unit` | PASS, 72 suites / 798 tests; 1 suite and 3 tests skipped; repeated on final implementation |
| `pnpm --filter @bedbanks/api test:unit -- hotel-stay-readiness.spec.ts` | PASS, 15/15 |
| `pnpm --filter @bedbanks/admin-console test` | PASS, 43/43 |
| `pnpm --filter @bedbanks/agent-portal test` | PASS, 103/103 |
| `pnpm --filter @bedbanks/admin-console build` | PASS; repeated on final implementation |
| `pnpm --filter @bedbanks/api build` | PASS; repeated on final implementation |
| `pnpm build` | BLOCKED: Agent Google Font fetch returns EAI_AGAIN for fonts.googleapis.com; no font or build-guard changes made |
| Database e2e / strict-role HTTP suites | BLOCKED locally; new cases are implemented but not claimed executed |
| Browser acceptance / hosted Agent acceptance | NOT_VERIFIED; no real browser/API journey executed |

Initial API unit execution overlapped client generation and failed with missing generated types; the complete run after generation passed. Initial root checks hit the environment's alternate pnpm; reruns use the pinned wrapper. Initial lint caught a duplicate import introduced here; corrected before the passing run. The existing browser harness is updated for the scoped wording and adds missing-buyer/certification and stale-verdict checks; those checks have not been executed. Added tests cover reason preservation, missing context, per-plan isolation, hosted-certification boundaries; HTTP buyer permissions/tenant isolation/market rules/suspension/restrictions; strict-role pooled-stock diagnostics and non-mutation.

Cached PostgreSQL binaries were extracted, but `runuser -u nobody` fails with `cannot set groups: Operation not permitted`; PostgreSQL cannot initialize as root. Database-dependent tests and real API/browser journeys are BLOCKED locally until a disposable runner executes them. Existing CI provisions PostgreSQL 16 and Node24/pnpm10.4.1; its results must be inspected before claiming database certification. No historical evidence is substituted for those runs.

## Validation of the unified readiness change (this session)

Node v24.21.0, pnpm 10.4.1, PostgreSQL 16 with pgvector, Redis, Chromium 1194 (Playwright 1.56.1). Everything ran against disposable local databases created for this run (`fbeds_hotel_check`, `fbeds_ci`) and torn down with the container. Code head for the runs below: `eb4a1aa478508aa335e06bddccb96df08ceec678`, tree `26804a21aba5bb2f87f32df08f931ea81ecf93e1` (it contained #278's commits merged in). Later commits are documentation and harness-assertion only. After #278 was merged the work was rebased onto `main` `3558c75`; the resulting tree `ee424a2b4f8881ee341fda7e2e909822d1ac4213` is identical to the tree of the last validated state (the browser runs and the harness assertions were executed on it), so no run is attributed to a tree it did not execute against except the database suites, which ran on the code at `eb4a1aa` (documentation and harness changes only since). No CI result for any head after `6c8e507` is recorded in this file; exact-head CI is reported on the draft PR.

| Check | Result |
|---|---|
| `pnpm prisma:validate`, `prisma:migrate:deploy` on an empty database, `prisma:migrate:status`, `prisma:migrate:drift` | PASS; all migrations applied; "No schema drift" |
| `pnpm check:architecture`, `pnpm check:schema` | PASS (24 controllers contract-checked) |
| `pnpm type-check`, `pnpm lint` | PASS 14/14 each; one existing unused-disable warning |
| API unit (`jest --runInBand`) | 74 suites, 818 tests PASS |
| `hotel-readiness.spec.ts` | 16/16 PASS |
| API database e2e, full run, fresh database, owner connection for fixtures | 64 suites / 566 tests PASS in the full run; two suites (`sandbox-content-staging`, `hotel-search-index`, 7 tests) failed only because my first invocation lacked `MAPPING_DATABASE_URL` and the required `fbeds_ci` database name, and PASSED on rerun with them |
| `hotel-readiness.e2e-spec.ts` (HR-E01..E09), application as `fbeds_api_login` | 9/9 PASS, including cross-tenant 404, 401/403, `agency.read` gate, criteria validation, connection reuse without leakage, no allocation or business audit, UNKNOWN under revoked grants, and prediction parity with Agent search |
| Admin tests, API build, Admin production build | 44/44 PASS; both builds PASS |
| Existing hotel browser harness `verify-hotels.cjs` (production Admin, owner-connected API; includes Add hotel, setup, publication, rooms, mapping, Quick Update, directory, states, keyboard, axe, 1280/768/390) | 166/166 PASS after correcting two assertions that still named the pre-rename header label |
| New browser harness `verify-hotel-readiness.cjs`, API connected as `fbeds_api_login` (confirmed in `pg_stat_activity`) | 29/29 PASS: gates, blockers, navigation, states, double submit, keyboard, 1280/768/390, axe, forbidden viewer, cross-tenant |

Not run, and not claimed: hosted environment, persistent databases, production-clone, live suppliers, the workspace `pnpm build` (the Agent font fetch is blocked without network), and a browser journey that goes on to a real Agent search and recheck in the browser (the Agent journey is covered by the database suites and by `HR-E07` parity, not by a browser run).

## Final gates

```
HOTEL_CONTENT_WORKFLOW=IMPLEMENTED_EXISTING (verify-hotels 166/166 owner-connected API)
HOTEL_READINESS_ASSESSMENT=IMPLEMENTED (unit 16, db 9, browser 29)
ROOM_OCCUPANCY_VALIDATION=PARTIAL (head-count and per-room limits enforced; child-age pricing, mixed-room parties not modelled)
MAPPING_GOVERNANCE=IMPLEMENTED_EXISTING (unchanged; surfaced as the MAPPING gate)
CONTRACT_RATE_VALIDATION=PARTIAL (integer money and NET markup enforced; tax lines, supplements, child charges missing)
INVENTORY_SEMANTICS_PRESERVED=YES (no inventory code changed; full e2e passed)
FRESHNESS_PROVENANCE_PRESERVED=YES (no inventory code changed; full e2e passed)
STRICT_ROLE_VALIDATION=PASS_FOR_THIS_CHANGE (readiness e2e and browser as fbeds_api_login; existing strict-role suites in the full run)
TENANT_ISOLATION=PASS (e2e HR-E02, HR-E08; browser cross-tenant)
AUDIT_IDEMPOTENCY=NOT_AFFECTED (no mutation added)
AGENT_SEARCH_RECHECK=DB_SUITES_PASS_ONLY (HR-E07 parity, inventory-search-recheck e2e); browser and hosted NOT_VERIFIED
BROWSER_ACCEPTANCE=PASS_LOCAL (166 + 29)
FINAL_HEAD_CI=SEE_DRAFT_PR
HOSTED_AGENT_MVP=NOT_VERIFIED
F01_STATUS=OPEN (candidate aea042299bdc2b7fbc33945b0cb89ba0a7a04238 untouched)
DRAFT_PR=#280 (follow-up to the merged #278)

PRODUCTION_DB_MIGRATION_EXECUTED=NO
PERSISTENT_ROLE_PROVISIONING_EXECUTED=NO
PRODUCTION_DEPLOYMENT_EXECUTED=NO
DNS_OR_ALIAS_CHANGED=NO
LIVE_SUPPLIER_ENABLED=NO
BOOKING_ENABLED=NO
PAYMENT_ENABLED=NO
```

The runtime role `fbeds_api_login` was provisioned only inside the two disposable local databases. The earlier remark in this file that database suites were BLOCKED locally describes that earlier session; this session had a working PostgreSQL.

## Next build order

1. Execute the new and existing database suites on disposable PostgreSQL with the strict application login; inspect exact-head CI and fix any failures before release.
2. Run the real setup/publication and buyer diagnostic-to-Agent-recheck browser journeys, including denied/error/loading states, keyboard, accessibility and 1280/768/390 layouts.
3. Resolve hosted topology/API/strict-role fixture prerequisites and run hosted acceptance independently; no alias cutover from this PR.
4. Define child pricing, mixed-room occupancy and remaining commercial policies before implementing those models.

## Database CI investigation

Initial CI run `37400603151` at `e66916cb0730aaf2bbfc7658ae941626b24d13f4` executed 65 e2e suites: 63 passed, 2 failed (562 passed / 2 failed tests). Both new diagnostic fixtures used lowercase agency codes and failed the existing uppercase `Agency_code_format` constraint before exercising the endpoints. Fixture codes are corrected to uppercase; the constraint and application behavior are untouched. Certification requires the corrected-head run to pass; the initial run is not a PASS.

## Remaining work

- Full child-age/extra-bed pricing, heterogeneous room parties, promotion stacking and explicit tax/supplement policies need separate business contracts; no invented rules.
- Hotel content completeness remains the existing setup checker; the published-content gate is not a replacement for its twelve publication requirements.
- Hosted Agent acceptance, real sandbox transport credentials and supplier-specific synchronization certification remain separate gates.
- Production-clone/F01 provenance and persistent strict-role rollout remain unresolved and unchanged.
- Image rights, malware scanning and source verification require separate validation; this change does not certify them.

## Safety

No schema, migration, persistent role provisioning, deployment, DNS, alias, booking, payment or live-supplier changes. All newly added HTTP fixtures are disposable test data only. No production authorization is implied.


## Post-merge database certification mission (2026-10-06 UTC)

This follow-up starts from main `3558c75beb27ff8c0fa65158e0041a07c08a9343`, tree `6691911ca5064ab2d421cb1f47af19cb684b9b4a`, after PR #278 merged. Branch: `fix/hotel-database-certification`. Earlier implementation and test records above remain historical. The published certification head, tree, final workflow attempts and counts will be recorded in the draft PR, outside this file's own commit hash.

The local environment has Node v24.19.0 and pnpm 10.4.1. It cannot host PostgreSQL: only UID/GID 0 are mapped (`/proc/self/uid_map` and `gid_map`), all process capabilities are zero, `setpriv` cannot change UID, and Docker is unavailable. No workaround weakens PostgreSQL or application-role safety. Database certification therefore executes on the authorized ephemeral `pgvector/pgvector:pg16` GitHub Actions service at localhost:5432/fbeds_ci, using vector and pg_trgm. This is engineering evidence, not a persistent-database rollout.

The CI migration-certification job now runs an explicit sequential hotel acceptance stage before full API e2e: hotel-commercial, inventory-runtime-http, pool-capacity-editor, hotel-setup, strict-runtime-role-hotel-setup/commercial/workflows/replay, inventory-search-recheck, inventory-pool-lifecycle and strict-role-rollout. Jest `--runInBand` prevents concurrent shared-role provisioning. The complete suite additionally covers mapping, tenant isolation and inventory rules. Generic fixture/authoring suites use the disposable owner; restricted acceptance suites explicitly change the API connection to the newly provisioned fbeds_api_login and test its real connection/privileges. Owner-run suites are not claimed as strict-role HTTP certification.

The service bootstrap owner password is replaced with a freshly generated, masked in-memory credential before migrations in both database jobs; later steps receive it through the runner environment without printing the URL. A new CI-only script `apps/api/scripts/certify-disposable-runtime-role.cjs` runs before targeted tests and after full e2e plus drift. It rejects non-test, non-Actions, non-loopback and non-fbeds_ci targets before opening a connection; requires PostgreSQL 16 and both extensions; generates a new random password in memory; provisions through the existing authoritative contract; connects separately as the login; verifies current_user and session_user, all contract attributes/grants/ownership/memberships, protected-column probes, and enabled plus forced RLS for every contract tenant table. It prints only sanitized identity/version/count evidence. Post-test re-provisioning is deliberate and disposable: destructive privilege-drift tests rotate/revoke grants during their cases. The final fresh connection verifies restored canonical grants, not a password left by a fixture suite.

No Prisma schema, historical migration, permission catalogue, application business logic or runtime-role grant changes are included. A verified RLS defect requires the new forward migration described below. Missing inventory, protected sold/held/identity columns, supplier provenance/freshness, commercial-control fail-closed behavior, audit/idempotency and UNKNOWN diagnostics retain their existing tests and authorities.

The GitHub branch-protection read returns 403 (integration access); repository ruleset listing returns an empty list, which does not establish classic branch protection. REQUIRED_CHECK_SET remains UNVERIFIED. Observed exact-head job success must be distinguished from required-check enforcement.

Local frozen install, explicit client generation, syntax/negative safety checks and repository guards are recorded separately from CI database runs. Final results, commands/counts, original failures and any retry are in the draft PR evidence record; until those jobs finish they are pending, not a pass. Website-only browser CI does not certify Hotel Admin/Agent browser acceptance. BROWSER_ACCEPTANCE=NOT_VERIFIED; HOSTED_AGENT_MVP=NOT_VERIFIED; F01_STATUS=OPEN, candidate unchanged at aea042299bdc2b7fbc33945b0cb89ba0a7a04238; RELEASE_AUTHORIZATION=NOT_GRANTED.

PRODUCTION_DB_MIGRATION_EXECUTED=NO; PERSISTENT_ROLE_PROVISIONING_EXECUTED=NO; PRODUCTION_DEPLOYMENT_EXECUTED=NO; DNS_OR_ALIAS_CHANGED=NO; LIVE_SUPPLIER_ENABLED_BY_THIS_WORK=NO; BOOKING_ENABLED_BY_THIS_WORK=NO; PAYMENT_ENABLED_BY_THIS_WORK=NO.


### Verified forced-RLS defect and minimum correction

Initial certification at b3d13e483612fcf5008ffd237714e9a6ba68a362 failed in migration-certification run 37403788601, job112076682123, after 51 migrations and pre-test drift passed. The new strict-login check reached protected-column probes, then exposed that RolePermission is listed as forced-tenant in the authoritative contract but has no ENABLE/FORCE RLS or policy in migration history. The script now emits safe assertion diagnostics while suppressing Prisma errors that might include credential-bearing provisioning SQL.

Forward migration 202610290003_role_permission_tenant_rls enables and forces RLS with USING and WITH CHECK predicates through Role.id = RolePermission.role_id and Role.tenant_id = fbeds_current_tenant_id(). The Role subquery also observes its own forced RLS. Required SELECT privileges on RolePermission and Role and execution of the existing tenant function are already held by the contract; no INSERT/UPDATE/DELETE or extra SELECT grant is needed or added. Missing tenant context yields no rows. Global Permission remains the non-tenant catalogue; this correction scopes only tenant role assignments to permission keys.

The existing api-runtime-role e2e suite now checks every forced-tenant contract table against pg_class and exercises direct RolePermission reads as the strict login across two synthetic tenants and no-context transactions on the same backend connection. Existing strict-role HTTP suites additionally exercise the real RBAC lookup. Fresh replay and upgrade suites discover the forward migration automatically. It is applied only to disposable CI databases; persistent execution remains owner-controlled and is not authorized here.


### Completed implementation-head evidence

Validated implementation SHA `6dc43207eb4d2327745182e321a83e23613bf513`, tree `322acf637c08d0921fa425713306d865fc036c55`. The following evidence-only commit records these results; its final SHA/tree and CI attempts are in PR #279, avoiding self-reference. Inspection is 2026-10-06 UTC. CI toolchain: Node v24.21.0, pnpm 10.4.1, PostgreSQL 16.15 (Debian 16.15-1.pgdg12+2), extensions vector/pg_trgm. Local toolchain remains Node v24.19.0/pnpm10.4.1.

| Command / check | Completed evidence at implementation head |
|---|---|
| Frozen install and explicit Prisma generation | Local and CI PASS |
| `pnpm check:architecture`, `pnpm check:schema` | Local and Schema integrity CI PASS |
| `pnpm type-check`, `pnpm lint` | Local14/14 PASS; CI recursive equivalents PASS; one existing lint warning |
| `prisma:validate`, `prisma:migrate:deploy`, `prisma:migrate:status` | CI PASS; empty disposable database replays52 migrations; status up to date |
| `prisma:migrate:drift` before/after suites | CI PASS, No schema drift both times (existing pgvector index tolerance unchanged) |
| `certify-disposable-runtime-role.cjs --rotate-owner` | Fresh masked owner credentials before migrations in both DB jobs |
| Strict-login certification before/after suites | PASS; current_user=session_user=fbeds_api_login; contract PASS,12 privilege probes,36 enabled+forced tenant tables |
| `test:e2e --` explicit12-suite Hotel acceptance list in CI | PASS,12 suites/180 tests, sequential `--runInBand` |
| `test:e2e -- sandbox-content-staging.e2e-spec.ts` | PASS,1 suite/4 tests |
| `pnpm --filter @bedbanks/api test:e2e` | PASS,65 suites/566 tests, no skips |
| `pnpm -r --if-present test` | PASS: API unit73/801 and e2e65/566; Admin43, Agent103, domain28, pricing4, money4, connector core32; no skips in these CI summaries |
| `pnpm -r --if-present build` | Push job112077733899 PASS, all14 workspace builds including Agent/Admin/API |
| Syntax and non-Actions/remote-target safety refusal | Local PASS; rejected with exit1 before connection |

Local API unit without a database:72 suites/798 tests PASS,1 suite/3 tests skipped. These skips are resolved in CI's73/801 run; the local command is not substituted for DB unit coverage. Architecture/type-check/lint were repeated after the RLS test additions. The new migration is not a Prisma schema edit and adds no privilege. Historical migration bytes are untouched.

| Workflow / event | Run / attempt | Jobs | Result at implementation head |
|---|---|---|---|
| CI push | [37404120701](https://github.com/rammyyadav-dot/bedbanks-system/actions/runs/37404120701),1 | Schema112077733917, migration112077733642, verify112077733899, website112077733834 | All PASS; full logs inspected |
| CI pull_request | [37404125379](https://github.com/rammyyadav-dot/bedbanks-system/actions/runs/37404125379),1 | Schema112077749694, migration112077749429, website112077749664 | PASS; migration checks complete |
| CI pull_request verify | Same run,1, job112077749676 | Unit/e2e pass; Agent production build fails | Unchanged Google Font loader TypeError (null reading1), Montserrat, loader.js122. Single failed-job retry requested; outcome recorded in PR #279 |
| Contract checks |37404125359,1 | Relevant workflow | PASS |
| Tenant isolation checks |37404125354,1 | Relevant workflow | PASS |
| Portal deployment configuration |37404125339 and37404120710,1 | PR and push | PASS |

All rows above use exact head_sha6dc43207eb4d2327745182e321a83e23613bf513. The final evidence head runs are audited separately in PR #279. The build failure is separate from database correctness and is not hidden or used to weaken assertions. No Agent font/config change is made in this mission.

Files changed: `.github/workflows/ci.yml`, `apps/api/scripts/certify-disposable-runtime-role.cjs`, `apps/api/test/api-runtime-role.e2e-spec.ts`, the forward RolePermission RLS migration, and this report. Owner fixture setup is distinguished from strict application acceptance; lifecycle simulations on owner connections do not enable booking or supplier calls.

Remaining release gates: required-check enforcement access, real Hotel Admin/Agent browser acceptance, hosted Agent acceptance, owner-reviewed persistent migration/role rollout, and separate F01 provenance completion. For persistent rollout, owner-side RolePermission authoring must use tenant context (or an explicitly authorized elevated provisioning principal) because FORCE RLS also applies to a non-BYPASSRLS table owner. No persistent rollout is executed or authorized here.
