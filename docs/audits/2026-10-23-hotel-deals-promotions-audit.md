# Hotel Deals & Promotions: CTO audit (2026-10-23)

Scope: the Hotel Deals & Promotions module of fBeds Admin. Method: repository inspection, then implementation and execution against a disposable PostgreSQL 16; every finding names the file and symbol. "Verified" means read in the checked-out tree. Anything not executed is marked **source-verified** or **hypothesis**. The implementation and the executed test evidence are in sections 8 and 9.

## 1. Preflight (verified)

| Item | Value |
|---|---|
| Repository root | `/home/user/bedbanks-system` (pnpm 10.4.1 monorepo; Turborepo; `apps/{admin,agent,api,supplier,website}`, `packages/{config,connectors,contracts,domain,money,pricing,types,ui,validation}`, `e2e`) |
| Branch / HEAD at start | `claude/magical-galileo-reat6o` at `7f9433f` (one docs commit above `593950a`, the merge of PR 453). Working tree clean, no untracked files other than the new work |
| API | NestJS (`apps/api`), Prisma 6, one canonical schema `apps/api/prisma/schema.prisma`, 116 forward migrations in `apps/api/prisma/migrations`, guarded by `pnpm check:schema` and `tools/migration-ledger-check.mjs` |
| Admin | Next.js app (`apps/admin`); its `AGENTS.md` warns that this Next version differs from training data and that `node_modules/next/dist/docs/` must be read first |
| Gates (CI `.github/workflows/ci.yml`) | `check:schema`, `check:architecture` (contracts, app boundaries, no-float, no-silent-fallback, ledger-single-writer, tenant-filter, public-env, runtime-db-role, aws-governance, workflow-permissions, framework-peers), migration deploy and drift, type-check, lint, unit and e2e (Jest on real PostgreSQL 16 + pgvector), Playwright release suite |
| Deployment target in the repository | AWS ECS Fargate (ADR 0040, `docs/runbooks/aws-ecs-deployment.md`, `infra/`), also Vercel and Render descriptors. Treated as stated by the repository; nothing was deployed or contacted |
| Local environment | Node 22.22 (repo wants 24.x), pnpm 10.4.1. A disposable PostgreSQL 16 cluster with pgvector was started in the scratchpad; all 116 existing migrations applied cleanly. Baseline: `promotions.spec.ts` and `contracted-sellability.spec.ts` 70/70 pass; `rate-plan-promotions.e2e-spec.ts` 13/13 pass |

## 2. How a promotion reaches a price today (execution path, verified)

```
Admin  PromotionsPanel / HotelOfferPanel  (apps/admin/components/commercial, hotels/panels)
  -> PUT /supply/rate-plans/:id/promotions , POST /supply/hotels/:id/promotions/bulk-apply   (supply.controller.ts:64-66, supply.rates.manage)
  -> SupplyService.replacePromotions / bulkApplyPromotion (supply.service.ts:697, 726): validatePromotions, version check, RatePlanPromotion rows, audit
  -> table RatePlanPromotion (migrations 202611170001, 202611200008)

Search / recheck / hold     ContractedInventoryAdapter.loadPlans  (agent/contracted-inventory.adapter.ts:202, include promotions)
Admin readiness / assessment / certification / inspector
                            assessPlanSelect (supply/assess-plan-select.ts) -> operations-hotels.service, rate-certification.service, SupplyService.sellability
  -> buildStaySnapshot (supply/stay-snapshot.ts:67)  maps rows to PromotionRule
  -> evaluateContractedStay (supply/contracted-sellability.ts:155) -> selectPromotion (supply/promotions.ts:110)
  order: rate + guest lines -> ONE promotion (or a combinable stack) -> supplements -> markup -> sell
Independent recomputation   rate-certification/rate-plan-audit.ts simulateStay (own rule mapping at line 325, calls selectPromotion)
```
Every surface funnels through `buildStaySnapshot`, and `StayPlanInput` fields are required so a loader that forgets one fails type-check. That is the integration point for any new promotion source.

## 3. Gap matrix

Severity: P0 critical security, tenant, financial or unauthorized-booking risk; P1 required for safe activation; P2 important; P3 enhancement.

### 3.1 Admin UI
| Verified finding | Evidence | Missing behaviour | Sev | Action |
|---|---|---|---|---|
| The "Deals & Promos" tab opens the rate plan view and says "Choose a rate plan below" | `HotelManagementTabs.tsx:19`; `hotels/[id]/page.tsx:76` | No hotel-level deal list, create, approval or detail screen. The Create-New-Promotion form in the brief does not exist in this tree | P1 | Build overview, create/edit, details, approval queue |
| Department map lists Promotions as `todo` | `packages/contracts/src/admin-departments.ts:194` | No navigation to a promotions module | P2 | Make it `live` once the module ships |
| Per-plan editor offers 4 kinds, windows, combinable, room-only | `PromotionsPanel.tsx` | No status, approval state, scope, audience or guards | P1 | New module; keep legacy editor, label its limits |

### 3.2 Data model
| Verified finding | Evidence | Missing | Sev | Action |
|---|---|---|---|---|
| `RatePlanPromotion` belongs to one plan, 4 kinds, percent in basis points, unique name per plan | `schema.prisma:666`, migration 202611170001 | No code, status, priority, version, scope above a plan, audience, fixed amount, weekday, caps, effective-date window, approval, owner | P1 | New `HotelDeal` + `HotelDealRatePlan` (composite tenant FKs, forced RLS, state-machine and immutability triggers) |
| Integrity in the database mirrors the validator | CHECK `RatePlanPromotion_shape_check` | Same discipline required for the new table | P1 | CHECKs, partial unique code index, immutability trigger |

### 3.3 Pricing
| Verified finding | Evidence | Missing | Sev | Action |
|---|---|---|---|---|
| One evaluator, integer minor units, half-up, net after promotion at least 1 | `promotions.ts:75-92`, ADR 0058 | Fixed-amount, subsequent-night, every-Nth-night-free, day-of-week and audience rules | P1 | Extend `promotions.ts` (pure) and its spec |
| No commercial floor on a promotion | `selectPromotion` has no sell, margin or discount-cap input | A promotion can take a night to 1 minor unit; no maximum discount, sell floor or margin check | P1 | Per-deal guards evaluated inside the evaluator; a breached guard drops the promotion and sells the base rate |
| `selectPromotion` chooses by largest saving; stacking only by `combinable` | `promotions.ts:110-127` | Stacking group, explicit exclusions, deterministic priority as tie-break | P2 | Add `stackingGroup`, `incompatibleWith`, priority as tie-break only |
| Promotion applies to the NET (supplier-side saving) and markup follows | ADR 0058 | Margin-based guards only meaningful for NET rates; SELL rates carry no net | P2 | SELL-basis night with a margin guard fails closed |
| Two mappings of rows to rules exist outside the snapshot builder | `rate-plan-audit.ts:325`, `supply.service.ts:55` | A new source must reach both or certification disagrees with search | P1 | One mapper; deals enter as ready rules through a required `dealRules` field |

### 3.4 Tenant isolation
| Verified finding | Evidence | Missing | Sev | Action |
|---|---|---|---|---|
| Forced RLS on `tenant_id` via `fbeds_current_tenant_id()`; every Prisma call must name the tenant (`check:tenant-filter`) | migration 202611170001; `tools/tenant-filter-check.ts` | New tables must follow it and have a cross-tenant e2e | P0 if absent | Forced RLS, composite FKs `(tenant_id, hotel_id)`, e2e for read, write, preview and approval across tenants |
| Another tenant's plan answers 404 for promotions | e2e `rate-plan-promotions.e2e-spec.ts` "another tenant's plan is not found" | Same for deals | P1 | 404 for every cross-tenant id |

### 3.5 Contracts
| Verified finding | Evidence | Missing | Sev | Action |
|---|---|---|---|---|
| A promotion sells only through an ACTIVE contract, in its validity, supplier ACTIVE, mapping MAPPED | `evaluateContractedStay` reasons `CONTRACT_INACTIVE`, `OUTSIDE_CONTRACT_VALIDITY`, `SUPPLIER_*` | Deal validation should say so before activation | P2 | Validation lists plan, contract and window blockers |
| A deal's period can exceed the plan's or contract's validity | not modelled | Warn at validation; evaluator still fails closed | P2 | Validation finding |

### 3.6 Inventory
| Verified finding | Evidence | Missing | Sev | Action |
|---|---|---|---|---|
| A promotion never creates or reserves stock; the evaluator judges stock separately | `evaluateContractedStay` | Nothing required: a deal must not touch inventory | P3 | Preview and tests assert no write |

### 3.7 Booking integration
| Verified finding | Evidence | Missing | Sev | Action |
|---|---|---|---|---|
| Search, recheck and hold use `loadPlans`; the offer carries `promotion {name, kind}` | `contracted-inventory.adapter.ts:520`, `:561` | Applied deal id for audit | P2 | Carry the deal id in the offer promotion |
| Booking tables are not writable by the API runtime role ("booking is disabled; finance-gated") | `runtime-role-contract.ts` `PRIVILEGED_WRITE_MODELS` | No redemption record can be written here | P2 | Redemption and attributed revenue reported as **not available**, never invented |
| Distribution API has scopes `search checkrate book` but search and book routes "join later" | `distribution.controller.ts:10` | Channel eligibility has only PORTAL today | P2 | Support channels `PORTAL` and `API`; a deal restricted to `API` never applies until an API search path exists |

### 3.8 Approval and audit
| Verified finding | Evidence | Missing | Sev | Action |
|---|---|---|---|---|
| **Promotions on a live plan change with one permission and no second person.** `replacePromotions` has no plan-status guard, takes effect immediately in search, and only moves the plan version | `supply.service.ts:697-717` | Maker-checker, price guardrails (F-13 covers rates, not promotions), caps | **P1 (open)** | Closed for deals by the new module. The legacy editor is left unchanged and recorded as an open finding with the recommendation to route live-plan discounts through deals |
| Maker-checker exists: `ApprovalService` (self-approval refused, idempotent request, single-use execute, audit) and a fingerprint-bound pattern (contract, FX, markup) | `approvals/approval.service.ts` | Deal approval | P1 | New approval action `promotion.activate` (S3, approval only, refines `supply.rates.manage`) |
| Approver permission is `supply.rates.manage` for FX, markup and rate plans, separation by user identity | `commercial-fx.controller.ts` | A dedicated approver permission would need a role-assignment migration | P2 | Follow the convention; record the limitation |
| Audit events are INSERT-only for the runtime role | `runtime-role-contract.ts` AuditEvent | Deal events | P1 | `promotion.deal.*` events with before/after hashes |

### 3.9 Runtime database role
| Verified finding | Evidence | Missing | Sev | Action |
|---|---|---|---|---|
| **On a strict deployment, authoring of `RatePlanPromotion` is a privileged path.** The runtime role reads it and never writes it; ADR 0032 states supply authoring answers the typed 403 `RUNTIME_ROLE_OPERATION_PROHIBITED` until a privileged path exists | `runtime-role-contract.ts:92, :256`; `docs/adr/0032-explicit-runtime-write-set.md:24` | The existing Admin promotion editors cannot save on a strict deployment (source-verified; not exercised in this session because the strict-role certification script requires the GitHub Actions environment) | P1 | The new tables follow the FX and markup pattern: the runtime role gets an explicit, column-level write set, so the module works on the strict role. Compiling deals into `RatePlanPromotion` was rejected for this reason |
| Background writes need a narrow role (`RATE_PLAN_OPS_DATABASE_URL` pattern) | `rate-plan-expiry-sweeper.service.ts` | A scheduler | P2 | See section 5: correctness does not depend on a job; persistence of the EXPIRED label is a reconcile action |

### 3.10 Scheduling
| Verified finding | Evidence | Missing | Sev | Action |
|---|---|---|---|---|
| The existing sweeper states "nothing it does is needed for correctness of sales": the evaluator refuses outside windows | `rate-plan-expiry-sweeper.service.ts` header | Same property for deals | P1 | Effective dates are judged by the evaluator in the hotel's calendar |

## 4. Supported promotion types (decision of this audit)

| Type | Supported | Basis |
|---|---|---|
| Percentage discount | Yes | existing percent semantics, new generic kind |
| Early bird | Yes | existing `EARLY_BIRD` |
| Flash sale | Yes | percent with a mandatory booking window |
| Stay X pay Y | Yes | existing `FREE_NIGHTS` (cheapest nights free, once per stay) |
| Discount on subsequent nights | Yes | new: night 1 full price, later nights percent off |
| Free night (every Nth) | Yes | new: one cheapest night free per full block of N nights |
| Fixed amount off | Yes, AED launch currency | integer minor units, per night or per stay, plan currency only |
| Package add-on | **Blocked** | Needs a priced inclusion (board upgrade) that changes what is sold, not the price. The only related model is `ContractSupplement`, which adds charges. Rejected with `PROMOTION_TYPE_UNSUPPORTED`; the UI shows it unavailable |

Audience: channel (`PORTAL`, `API`), source market (ISO country of the buying agency) and explicit agencies are supported. **Agency segments, member tiers and loyalty are not supported**: `Agency` has no segment or tier field (`schema.prisma:206`). Funding source: supplier-funded only (the discount reduces the supplier net, as ADR 0058 defines); platform- or hotel-funded needs a finance decision (ledger and settlement treatment). Below-net override: **not offered**; no code path can sell under net.

## 5. Scheduling decision
Activation and expiry are enforced by the evaluator through a deal's `activeFrom` and `activeTo` judged against the **hotel-local** date (unknown time zone means the deal does not apply). A missed job, a restart or a clock skew therefore cannot sell an expired deal or hold back a due one. Stored status labels (SCHEDULED to ACTIVE, ACTIVE to EXPIRED) are reconciled by an idempotent, audited `reconcile` action. A periodic sweeper needs a dedicated narrow database role (provisioning and verification CLIs, ADR 0084 pattern) and is **not built**; the runbook states how to wire it.

## 6. Risk register (status after implementation)
| ID | Risk | Sev | Status |
|---|---|---|---|
| R1 | Legacy per-plan promotion editor: no second approver, no caps, privileged path on the strict role | P1 | **Open, verified.** SD-05 proves the strict role refuses the write (`RUNTIME_ROLE_OPERATION_PROHIBITED` or `DATABASE_ROLE_NOT_PERMITTED`). Deals are the governed path; the editor is unchanged on purpose (ADR 0058 behaviour, existing tests) and flagged for a decision |
| R2 | A deal could undercut commercial floors | P1 | Closed: guards in the evaluator, 42 unit tests, e2e through search |
| R3 | A surface that forgets deal rules prices differently from search | P1 | Closed: required `dealRules`; Admin readiness, certification, inspector and simulator use the same loader; type-check and a runtime throw |
| R4 | Cross-tenant access to deals, plans, agencies or approvals | P0 if present | Closed: forced RLS (tested with a restricted role), composite FKs, tenant-filter gate, e2e isolation matrix (identical answers for foreign and missing ids) |
| R5 | Self-approval or single-actor activation | P0 if present | Closed: `ApprovalService` plus a database state machine; e2e and browser tests |
| R6 | Mass assignment of status, tenant, approval or override fields | P1 | Closed: allow-list parser, tested for 11 forbidden fields |
| R7 | Scheduler dependency | P1 | Closed: dates enforced in the evaluator; reconcile only persists labels |
| R8 | Redemption and attributed-revenue reporting | P2 | Not available by design (booking is not writable by the API role); shown as such |
| R9 | Agency segment, member tier, package add-on, platform-funded discount | P2 | Not supported; not shown as capabilities |
| R10 | Deploy ordering: migration before role provisioning makes search answer `provider_unavailable` | P2 | Documented in the runbook; the failure is closed, not silent (SD-06) |
| R11 | Approver is any `supply.rates.manage` holder who is not the maker | P2 | Open: follows the repository convention for FX, markup and rate plans; a dedicated approver permission is a later change |
| R12 | A distribution API search does not exist, so `API`-limited deals apply nowhere | P3 | Documented and shown in the Admin |

## 7. Decision records
See `docs/adr/0089-hotel-deals-and-promotions.md` and the lifecycle and semantics specification `docs/hotel-deals-promotions-workflow.md`.

## 8. Executed verification (2026-10-24, local disposable PostgreSQL)
Environment: PostgreSQL in a throwaway cluster (`trust` authentication), Node 22.22 (repository requires 24.x), `GITHUB_ACTIONS=true` set only to let the disposable-database certification script run locally. No production system, deployment or external connector was touched.

| Check | Result |
|---|---|
| `pnpm check:architecture` | PASS |
| `pnpm --filter @bedbanks/api test:unit` | PASS: 186 suites passed, 1 skipped; 1984 tests passed, 14 skipped |
| `pnpm type-check`, ESLint on the changed API code | PASS |
| `jest --config ./test/jest-e2e.json --runInBand hotel-deals strict-runtime-role-hotel-deals strict-runtime-role-workflows` | PASS: 3 suites, 62 tests (includes the concurrent-create race, strict-role deal lifecycle W-01c and the W-11 privilege coverage) |
| Full API e2e regression | The single run aborted on the Node heap limit after 99 of 120 suites. The remaining suites were run in a second batch with a larger heap: 19 passed, 1 skipped. See the two failures below. |
| Browser release suite `e2e/tests/08-hotel-deals.spec.ts` against production builds on the strict role | PASS (44 passed, 1 skipped) |

Failures observed and their cause, not hidden:
- `booking-ops-role.e2e-spec.ts` BO-E08 and `rate-plan-clone-role.e2e-spec.ts` (application connection): both assert that a wrong password is refused. The local cluster uses `trust` authentication, so any password is accepted. Environmental. Neither touches deals. Not re-run against a password-authenticated server.
- `strict-runtime-role-workflows.e2e-spec.ts` W-11 failed before W-01c existed (HotelDeal and HotelDealRatePlan writes unexercised). Fixed by adding W-01c; it passes.

Defects found by this verification and fixed: an approval request left pending when submit lost a race (now withdrawn); a pending request of a deal that had moved on offered for decision (history now shows only the bound or a settled request); two concurrent creates with one idempotency key (second now replays the first; a real code clash still answers `DEAL_CODE_TAKEN`).

Not run: the migration against a production-shaped database copy, load or performance tests, an accessibility scanner (no dependency in the repository), booking-time revalidation end to end (booking is not writable by the API runtime role; the recheck path is covered).
