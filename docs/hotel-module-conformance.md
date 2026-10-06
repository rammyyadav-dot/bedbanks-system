# Hotel module audit and stay diagnostics

## Source and scope

Implementation base: `b6fbf4e7947213980b448a758b978f7cd7602673`, tree `67cd5e7180b5d7e8f25f4dc973b0edc7a7fa5652`. Branch: `feat/hotel-module-readiness-and-workflows`. This report supersedes the older module conformance record only for the stay diagnostic changes below. Historical test counts in older reports are not evidence of a new run.

Validated implementation head: `6c8e50755af8d08d7930c9b5799c7bda74ba3799`, tree `ef908bdf1a055d40d487d3a2adcb098fe9440c8b`. The following evidence commit adds this report only; its final head/tree and exact-head CI status are recorded in the draft PR and final delivery, avoiding a self-referential commit hash in this file.

F01 remains OPEN. Its candidate remains `aea042299bdc2b7fbc33945b0cb89ba0a7a04238`; this work does not certify or change it.

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

## Next build order

1. Execute the new and existing database suites on disposable PostgreSQL with the strict application login; inspect exact-head CI and fix any failures before release.
2. Run the real setup/publication and buyer diagnostic-to-Agent-recheck browser journeys, including denied/error/loading states, keyboard, accessibility and 1280/768/390 layouts.
3. Resolve hosted topology/API/strict-role fixture prerequisites and run hosted acceptance independently; no alias cutover from this PR.
4. Define child pricing, mixed-room occupancy and remaining commercial policies before implementing those models.

## Remaining work

- Full child-age/extra-bed pricing, heterogeneous room parties, promotion stacking and explicit tax/supplement policies need separate business contracts; no invented rules.
- Hotel content completeness remains the existing setup checker; the published-content gate is not a replacement for its twelve publication requirements.
- Hosted Agent acceptance, real sandbox transport credentials and supplier-specific synchronization certification remain separate gates.
- Production-clone/F01 provenance and persistent strict-role rollout remain unresolved and unchanged.
- Image rights, malware scanning and source verification require separate validation; this change does not certify them.

## Safety

No schema, migration, persistent role provisioning, deployment, DNS, alias, booking, payment or live-supplier changes. All newly added HTTP fixtures are disposable test data only. No production authorization is implied.
