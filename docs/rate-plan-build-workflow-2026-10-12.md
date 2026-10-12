# Hotel Admin: Rate Plan build workflow, audit and delivery plan (CTO draft)

Date: 2026-10-12. Baseline: `origin/main` `5e25807` (PR #315 merge), branch `claude/ecstatic-dijkstra-oo1zfd`.
Status: **Direction adopted 2026-10-12 (owner: "go ahead with your recommendation"); decisions recorded in ADR 0057.** Slice S2a is built (see section 10); all other slices are not. Booking, payment and live supplier connections stay disabled.

Method: read `CLAUDE.md`, ADR 0041 (+ amendments), the two 2026-10-11 rate plan audits, `enriched-rate-plan-workflow.md`, `admin-hotel-module-blueprint.md`, the Prisma models (`RatePlan`, `DailyRate`, `DailyAvailability`, `Contract`, `CancellationPolicy`, `ChildPolicy`, `BookingLeadTimeRule`, `RoomType`, `BoardBasis`, `InventoryPool`), `@bedbanks/contracts` routes, and the Admin rate components. **Not done in this pass:** no test, build, migration replay or browser run (no PostgreSQL here); statements about test results are quoted from the 2026-10-11 evidence, not re-verified.

---

## 1. Verdict

The rate plan **foundation is sound and governed**; the rate plan **product is not yet a global-bedbank-grade rate plan**.

- **Strong (keep, do not rebuild):** one sellability evaluator shared by Agent search and rate certification; integer minor units + currency; NET/SELL basis on every daily rate; readiness-gated activation with optimistic concurrency and before/after audit; PATCH-status bypass closed; atomic calendar preview/apply with stale-cell checks; Quick Update; shared inventory pools; narrow `fbeds_rateplan_ops` role.
- **Weak (build next):** a plan is a flat row (contract + room + board + adults-only occupancy integer + a `refundable` flag). Most of what a buyer compares on a global bedbank (cancellation terms, payment type, market/channel, validity window, child/extra-bed pricing, promotions, derived rates, tax breakdown) lives at contract level, or nowhere.
- **Release posture:** CONDITIONAL, unchanged from the 2026-10-11 verdict. Hosted certification, `fbeds_rateplan_ops` provisioning, the clone-writer decision and four-eye approval need people.

## 2. Benchmark: what "matching global bedbanks" means

Global bedbanks (Hotelbeds, WebBeds, TBO, RateHawk, Expedia Rapid class) model a sellable rate as the cross product below. This is a capability target, not a copy of any provider's schema (invariant 9: provider types stay in connector packages).

| # | Dimension | Bedbank norm | fBeds today | Gap |
|---|---|---|---|---|
| 1 | Hierarchy | Hotel > room > rate plan > daily rate | Same (`RatePlan` per room/board/occupancy) | None |
| 2 | Board | RO/BB/HB/FB/AI per plan | `BoardBasis` per tenant, 1 per plan | None |
| 3 | Occupancy | Adults + children with ages, per-pax-mix pricing | `occupancy` = adults integer; `DailyRate` unique on (plan, date, occupancy) | **Partial**: no child/extra-bed price lines |
| 4 | Rate basis | Net (cost), sell, commissionable | `RateAmountBasis` NET/SELL; markup rules (ADR 0018) | None |
| 5 | Taxes/fees | Itemised, included/excluded, payable at property | `taxesIncluded`, `feesIncluded` booleans + JSON metadata | **Partial**: no itemised model |
| 6 | Cancellation | Per-plan tiered policy, non-refundable plans, deadlines | Contract-level `CancellationPolicy`; plan has `refundable` only | **Partial**: not plan-attached |
| 7 | Payment type | Prepaid / pay-at-hotel / deposit | None on plan | **Missing** |
| 8 | Market/channel | Country/nationality/channel eligibility per plan | Contract-level `salesMarkets`, `nationalities` (ADR 0035); enforced only when the request names a buyer | **Partial**: not per plan |
| 9 | Validity | Plan-level effective from/to, booking window, stay window | Inherits contract term; `BookingLeadTimeRule` is contract-level | **Missing** at plan level |
| 10 | Restrictions | Min/max stay, CTA, CTD, stop-sell, release | All present (plan + `DailyAvailability`) | None |
| 11 | Allotment | Allotment / free sale / on request / pooled | `InventoryMode` + `InventoryPool` (ADR 0030/0036) | None |
| 12 | Promotions | Early bird, long stay, last minute, free night | None | **Missing** |
| 13 | Derived rates | Plan = parent +/- amount or % | None | **Missing** |
| 14 | Bulk authoring | Calendar grid, CSV/channel-manager import with dedup + error file | Quick Update, calendar preview/apply API; no grid editor, no import | **Missing** |
| 15 | Lifecycle | Draft > review > approved > live; suspend; expire | DRAFT/ACTIVE/SUSPENDED/EXPIRED; readiness-gated; no approval; nothing writes EXPIRED | **Partial** |
| 16 | Clone | One click | Built; refused under strict role (no writer) | **Blocked** |
| 17 | Observability | Sellability trace, "why not sellable" | Rate certification + simulator (ADR 0033), Distribution & Readiness | None |

## 3. Audit findings

Severity: P0 can corrupt money or expose inventory; P1 blocks a bedbank-grade launch; P2 is quality.

| ID | Sev | Finding | Evidence | Constitution |
|---|---|---|---|---|
| F1 | P1 | Cancellation terms are contract-wide; a plan only carries `refundable`. Two plans of one contract cannot have different deadlines or penalties. | `CancellationPolicy.contractId` only; `RatePlan.refundable` | 5, 10 |
| F2 | P1 | No plan-level validity or booking window. A seasonal rate needs a separate contract. | `RatePlan` has no date columns | 10 |
| F3 | P1 | Child/extra-bed pricing is a contract-level supplement (`ChildPolicy.supplementMinor`), not a rate line, and the plan form edits adults only. | `ChildPolicy`; `RatePlanForm` "Occupancy (adults)" | 3 |
| F4 | P1 | Sales markets/nationalities are enforced only when the caller supplies a buyer, and the blueprint lists plan eligibility as not guaranteed on every path. | `contracted-sellability.ts` L88/L130; blueprint s5, s11 | 1, 5 |
| F5 | P1 | Activation is a single-actor action. Blueprint principle 8 (maker-checker for sensitive transitions) is not applied to rates. | ADR 0041 Amendment 3 s5 | 8 |
| F6 | P1 | Clone is unavailable under the strict runtime login; operators must re-key plans. | ADR 0041 Amendment 3 s1 | 8 |
| F7 | P1 | Hosted/production-clone certification of the lifecycle role is not done; activation under a strict login without `RATE_PLAN_OPS_DATABASE_URL` is a refused 403. | 2026-10-11 verdict A1-A3 | 6 |
| F8 | P2 | Plan form is one 12-field page, not a guided build; an incomplete draft cannot be staged with a progress view. | `RatePlanForm.tsx` (117 lines) | 10 |
| F9 | P2 | No inline calendar grid; bulk work goes through Quick Update or API. | 2026-10-11 matrix | - |
| F10 | P2 | `EXPIRED` is never written by any application path; expiry relies on contract validity checks. | ADR 0041 | 10 |
| F11 | P2 | Authoring tests that need PostgreSQL (replay, drift, strict-role, browser) did not run in this audit. | environment | - |
| F12 | Info | `DailyRate.occupancy` and `RatePlan.occupancy` both exist; settle in design review which is authoritative before adding pax-mix pricing (unique key is `ratePlanId, stayDate, occupancy`). | schema | 3 |

No P0 found in the rate plan path on this reading. The previous P0 (PATCH status bypass) is documented as closed and guarded by `rate-plan-status-writers.spec.ts`.

## 4. Target workflow: build a hotel rate plan in Admin

Actors: **Contract manager** (`supply.contracts.manage`), **Rate manager** (`supply.rates.manage`), **Inventory manager** (`supply.availability.manage`), **Approver** (a different holder of `supply.rates.manage`, or a new approver permission: decision D2), **Auditor** (`audit.read`).

```
Hotel published + mapped + contract ACTIVE        (preconditions, read-only here)
        |
  [1 Define] -> [2 Terms] -> [3 Price] -> [4 Stock] -> [5 Verify] -> [6 Approve] -> [7 Activate]
     DRAFT        DRAFT        DRAFT        DRAFT      readiness +    request ->      ACTIVE
                                                       simulation     decide(other)
                                                                            |
                                            [8 Operate: Quick Update / calendar / suspend / clone]
                                            [9 Retire: expire or suspend with reason]
```

| Stage | Who | What happens | Gate to leave the stage | Existing / New |
|---|---|---|---|---|
| 0 Preconditions | system | Hotel exists and is published; supplier mapping MAPPED; contract ACTIVE and in term; at least one active room; board bases defined | Checklist shows each blocker by name | Existing (readiness evaluator) |
| 1 Define | Rate manager | Pick contract, room, board, adults, currency, code. Save as DRAFT at any point; incomplete is allowed | Code unique per contract; currency matches contract; occupancy within room capacity | Existing form; **New**: staged wizard with progress (F8) |
| 2 Terms | Rate manager | Stay rules (min/max, release time), **plan-attached cancellation policy**, **payment type**, **market/channel eligibility**, **validity and booking window**, tax/fee inclusion | Terms internally consistent; refundable plan has a cancellation rule; validity inside contract term | **New** (F1, F2, F4, payment type) |
| 3 Price | Rate manager | Per night and occupancy: amount in minor units, NET or SELL declared. Then **child/extra-bed lines**, later **derived** and **promotion** rules. Calendar grid or CSV import with dedup and an error file | Every night between first and last rated night priced; positive integers; plan currency; basis classified | Existing preview/apply API; **New**: grid (F9), child lines (F3), import |
| 4 Stock | Inventory manager | Allotment, free sale, on request or shared pool; stop-sell, CTA, CTD, release | Future availability rows or a pool link | Existing (ADR 0030/0036) |
| 5 Verify | system + Rate manager | Run readiness checklist and the read-only **simulator** (ADR 0033) for sample stays; compare with Agent search result | `ready = true`; simulator shows the intended sell price and terms | Existing |
| 6 Approve | Rate manager (requester) then a **different** approver | Request bound to plan `updatedAt` + a content hash of terms and prices; approver reviews the diff; decision audited | Edit after request voids it; approver != requester (service + DB CHECK) | **New**, reuses `ApprovalRequest` (ADR 0016/0022 pattern); needs D1-D4 |
| 7 Activate | system on `fbeds_rateplan_ops` | Conditional `updateMany`, readiness re-run at commit, one transaction with audit | Stale version = 409 `RATE_PLAN_CHANGED`; failed check = 409 `RATE_PLAN_NOT_READY` | Existing (activate); approval hook is **New** |
| 8 Operate | Rate / Inventory manager | Quick Update (preview, reason, idempotency key), calendar changes, clone to DRAFT | Stale preview refused; strict-role limits respected | Existing; clone writer pending (F6) |
| 9 Retire | Rate manager | Suspend (single actor, reason >= 3 chars, immediate); expiry when validity ends; EXPIRED is final, clone instead | - | Existing; expiry job **New** (F10) |

Invariant checklist per stage: tenant from session only; permission declared on every controller method; integer minor units, no floats; contracts in `@bedbanks/contracts` before the Admin consumes them; supplier failure never turned into demo inventory; mutations idempotent; immutable audit event for every privileged or financial change; no guest PII or raw payloads in logs.

## 5. Delivery plan (small, reviewable slices)

Each slice: feature branch, `pnpm check:architecture`, `pnpm type-check`, `pnpm lint`, `pnpm test`, affected builds, an ADR where it is a design choice, and for any schema change a reviewed Prisma migration with rollback notes and a tenant-index review. No `prisma migrate dev` against production history.

| Slice | Content | Schema? | Depends on | Closes |
|---|---|---|---|---|
| S0 | Operator work: provision `fbeds_rateplan_ops`, set `RATE_PLAN_OPS_DATABASE_URL`, hosted/prod-clone certification per `docs/runbooks/rate-plan-ops-role-certification.md` | No | people | F7 |
| S1 | Owner decisions D1-D7 recorded in a new ADR ("Rate plan terms and approval") | No | - | enables all |
| S2 | Plan-attached terms: reusable cancellation policy set linked from the plan, `paymentType`, `validFrom/validTo`, booking window. Evaluator reads plan terms first; contract fallback only by explicit policy. Contracts types first | Yes | S1 | F1, F2 |
| S3 | Plan-level market/channel eligibility enforced in the shared evaluator on every path (search, recheck, hold), with a rejected-reason in the trace | Yes | S2 | F4 |
| S4 | Guided wizard (stages 1-5) over the same API; save-as-draft; readiness panel always visible | No | S2 | F8 |
| S5 | Four-eye activation via `ApprovalRequest` (new catalogue key e.g. `rate_plan.activate`, version-bound, apply on the lifecycle connection, readiness re-run). `POST .../activate` stops being one-actor | Contracts only | D1-D4 | F5 |
| S6 | Child and extra-bed price lines with an explicit pax-mix model; settle F12 first | Yes | S2 | F3 |
| S7 | Calendar grid editor + CSV import (dedup, per-row error file), reusing preview/apply | No | S2 | F9 |
| S8 | Clone writer (`fbeds_rateplan_clone` + trigger forcing DRAFT) if D5 approves | Yes (trigger, grants) | D5 | F6 |
| S9 | Expiry sweeper writing EXPIRED when validity ends (pattern ADR 0005) | No | S2 | F10 |
| S10 | Promotions and derived rates, only after a pricing policy ADR (cycle detection, integer rounding, precedence) | Yes | D7 | benchmark rows 12-13 |

Recommended order: **S0 and S1 in parallel, then S2, S3, S4, S5, S6, S7, S9; S8 and S10 on decision.** S2 is the critical path because F1/F2 are what a buyer compares first.

## 6. Test and evidence gates (per slice)

- Unit: pure evaluator cases for every new rule (terms, validity, market, approval binding).
- API e2e on disposable PostgreSQL: tenant isolation (cross-tenant is 404), permission denial with `permission.denied` audit, stale version 409, concurrent activation (exactly one wins), self-approval refused, idempotent replay.
- Strict role: `ops:strict-role-boot-smoke` phases A/B/C extended to each new write path; a new writer gets its own role verifier with probes.
- Migration: fresh `migrate deploy`, `migrate status`, drift check, forced-RLS table list updated.
- Browser: wizard journey, approval journey (two users), grid editor, with screenshots.
- Search parity: Agent search result equals the simulator result for the same stay (ADR 0033).
- Anything not executed is reported as NOT RUN, never as passed.

## 7. Decisions needed from the owner

| # | Decision | Recommendation |
|---|---|---|
| D1 | Four-eye activation: always, per-tenant setting, or above a threshold | Always for activation; suspension stays single-actor. Consequence: a tenant needs two `supply.rates.manage` holders |
| D2 | Who approves | A different holder of `supply.rates.manage` now; a dedicated approver permission later |
| D3 | Accept that the lifecycle credential can still write `status` directly (no DB trigger) | Accept for launch; revisit with a trigger requiring an approved request |
| D4 | "Creator cannot approve": requester only, or also last editor | Requester only (already DB-enforced); last editor needs a new column |
| D5 | Clone writer: separate narrow role with DRAFT-forcing trigger, or leave out of strict environments | Separate role, after S2 |
| D6 | Cancellation model: per-plan rows or reusable named policy sets linked to plans | Reusable policy sets (bedbank norm; fewer rows to keep consistent) |
| D7 | Pricing policy for promotions and derived rates (precedence, stacking, rounding) | Defer until after S7 |

## 8. Risks

- Moving cancellation to plan level changes what Agent search shows. Ship with an explicit fallback policy and compare against the simulator before switching (invariant 5).
- Mandatory approval blocks tenants with one rate manager (same consequence as ADR 0022). Staff before enabling.
- Adding pax-mix pricing without settling F12 risks two sources of truth for occupancy.
- Every new writer to `RatePlan` must pass `rate-plan-status-writers.spec.ts` and be listed in ADR 0032's write set.

## 9. Not in scope

Booking, payment, wallet, supplier confirmation and any live connector. No merge, deploy, flag, RLS or financial privilege change is proposed or made by this document.

## 10. Progress

| Slice | State | Where |
|---|---|---|
| S1 decisions D1-D7 | DONE (adopted as recommended) | ADR 0057 |
| S2a plan sale window + payment type | **BUILT**, certified on disposable PostgreSQL 16 + pgvector | ADR 0057; migration `202611120001`; `rate-plan-terms.ts`; evaluator, activation, hold path, Admin form |
| S2b plan-attached cancellation (named rule sets) | **BUILT**, certified on disposable PostgreSQL; strict-role boot smoke 42/42 | ADR 0057; migration `202611120002`; `cancellation-rules.ts` |
| Payment type on Agent offers | **BUILT** (`unspecified` replaces the hardcoded `prepaid`) | ADR 0057 |
| S3 plan-level buyer market + nationality | **BUILT** (narrow-only, enforced in the shared evaluator); channel NOT modelled | ADR 0057; migration `202611130001` |
| S0 operator provisioning / hosted certification | OPEN (people) | runbook |
| S5 four-eye activation | **BUILT** (default required; explicit `off` switch; runbook `docs/runbooks/rate-plan-activation-approval.md`) | ADR 0057 |
| S4, S6-S10 | NOT BUILT | - |

| F5 | closed in application code (D3: the lifecycle credential can still write status) | S5 |
| F4 | closed for plan-level market and nationality lists | S3 |
| F13 (new) | Cancellation penalties and vouchers read live contract rules, not a copy frozen at booking | open, needs a booking decision |

Finding status: F1 closed by S2b for offers, penalties and vouchers (via one resolver). F2 (plan validity) closed for the sale window; the booking window stays contract-level. Payment type is recorded but not yet shown to Agents. F1, F3-F10 remain open.
