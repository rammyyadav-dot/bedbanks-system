# ADR 0057: Rate plan terms and activation approval

## Status
Accepted as direction (owner instructed "go ahead with your recommendation", 2026-10-12). **Slices S2a (sale window, payment type, payment type on Agent offers) and S2b (plan-attached cancellation rule sets) S3 (plan-level buyer markets and nationalities) and S5 (four-eye activation) are implemented.** Every other slice is **not built**. Nothing here enables booking, payment or a supplier connection. ADR 0032 (privileged rate writes), ADR 0041 (activation lifecycle) and ADR 0014 (one sellability evaluator) are unchanged.

Companion: `docs/rate-plan-build-workflow-2026-10-12.md` (audit, benchmark, workflow, slice plan).

## Context
A rate plan is a flat row: contract, room, board, adults-only occupancy and a `refundable` flag. Cancellation terms, validity, market eligibility and payment model live on the contract or nowhere, so two plans of one contract cannot differ in what a buyer compares first.

## Decisions (owner-adopted recommendations D1 to D7)
| # | Decision |
|---|---|
| D1 | Activation will require a second approver. Suspension stays single-actor. A tenant therefore needs two holders of `supply.rates.manage` before the control is enabled. |
| D2 | The approver is a different holder of `supply.rates.manage`. A dedicated approver permission is a later change. |
| D3 | The lifecycle credential can still write `status` directly; the approval is application-level. A database trigger requiring an approved request is deferred. |
| D4 | "Creator cannot approve" means requester is not approver (service and database CHECK already). Last-editor is not enforced. |
| D5 | Clone gets its own narrow role (`fbeds_rateplan_clone`) with a trigger forcing `status = DRAFT`, after S2. Until then clone stays unavailable under the strict login. |
| D6 | Cancellation moves to reusable named policy sets linked from the plan, not per-plan rows. |
| D7 | Promotions and derived rates wait for a pricing-policy ADR (precedence, stacking, integer rounding, cycle detection). |

## Slice S2a (implemented): plan sale window and payment type
- `RatePlan.validFrom`, `validTo` (nullable `DATE`): the plan's own sale window. A null side inherits the contract on that side. The window can only narrow the contract, never extend it.
- `RatePlan.paymentType` (nullable enum `PREPAID | PAY_AT_HOTEL`): recorded as given, never defaulted. `DEPOSIT` is refused because it needs money semantics that are undecided.
- Migration `202611120001_rate_plan_validity_payment_type`: additive and nullable, plus `CHECK (valid_to >= valid_from)`. Existing plans keep inheriting the contract and no sellability result changes. Rollback notes are in the migration header. No new index: reads use `(tenant_id, status)` and the primary key. RLS, grants and the `fbeds_rateplan_ops` column grants are untouched.
- One rule, one place: `OUTSIDE_RATE_PLAN_VALIDITY` is raised by the canonical stay evaluator (Agent search, recheck, rate certification, Distribution & Readiness) and by the per-night Admin diagnostic, so they cannot disagree. The hold path, which carries its own contract-validity query, applies the same window.
- Activation readiness gains `PLAN_VALIDITY` (inside the contract term, ordered, not already over). An ACTIVE plan cannot be edited into a window that fails it (same rule as other readiness fields).
- Validation (`rate-plan-terms.ts`): strict calendar days (2026-02-30 is refused, not normalised), window inside the contract term, typed 400 codes `RATE_PLAN_VALIDITY_INVALID`, `RATE_PLAN_VALIDITY_OUTSIDE_CONTRACT`, `RATE_PLAN_PAYMENT_TYPE_INVALID`. On PATCH an absent key keeps the stored value and an explicit `null` clears it. A changed contract re-validates the window against the new term.
- Clone copies the window and payment type; it still creates a DRAFT only.
- **Fail-closed loading.** The narrow `select` lists in the loaders are loosely typed, so the compiler cannot force them to load the new columns. A missing column would silently skip the rule. `buildStaySnapshot` therefore throws `RATE_PLAN_WINDOW_NOT_LOADED` when the plan window was not loaded, and the two `select` loaders and the hold query were updated.

- **Payment type reaches Agents.** `SearchRateOffer.paymentType` gained `unspecified`. Contracted offers previously carried a hardcoded `prepaid` for every plan, which was an invented fact. They now carry the recorded value, and `unspecified` ("Payment terms not stated") when nothing is recorded. This is a visible change for every existing plan.

## Slice S2b (implemented): plan-attached cancellation rule sets (D6)
- `CancellationPolicy.policy_set` (nullable, up to 80 chars) names a set of rules within a contract; `RatePlan.cancellation_policy_set` (nullable) selects one. Migration `202611120002_cancellation_policy_sets`: additive, nullable, new `(contract_id, policy_set)` index, rollback notes in the header. `CancellationPolicy` has no tenant column; its forced RLS joins `Contract`, unchanged.
- Resolution is one pure function, `rulesForPlan` (`supply/cancellation-rules.ts`): no set = the contract default rules (rows with `policy_set` NULL), exactly today's behaviour; a named set = only that set; a named set with no rules is `missing` and **never falls back** to the default. Names are case-sensitive.
- Used by every reader of the rules so the buyer sees what is applied: Agent search offers, cancellation penalty quotes, voucher text, activation readiness, the shared stay evaluator (new reason `CANCELLATION_POLICY_MISSING`, so search, recheck, hold, the Admin simulator and Distribution & Readiness all agree).
- Write validation: set names validated; a plan can name only a set that exists on its contract, and only while refundable (typed 400 `RATE_PLAN_CANCELLATION_SET_INVALID|UNKNOWN|ON_NON_REFUNDABLE`). Absent key keeps, explicit null clears. Clone copies the set. An ACTIVE plan cannot be edited into a state activation would refuse.
- Fail-closed loading as in S2a: `buildStaySnapshot` throws `RATE_PLAN_CANCELLATION_NOT_LOADED` if a loader omitted the fields.
- Admin: rule sets shown grouped on the contract, a set name on new rules, and a rule-set picker on the plan form (refundable plans only; an unreadable contract is reported, not shown as "no sets").
- **Compared against the simulator:** the simulator and Agent search call the same evaluator; a unit test and SR-14 (search e2e) assert that a named-but-empty set removes the offer and that a named set yields its own deadline (11 days earlier than the default in the test).

## Slice S3 (implemented): plan-level buyer markets and nationalities
- `RatePlan.sales_markets` and `RatePlan.nationalities` (JSONB, default `[]`, `CHECK jsonb_typeof = 'array'`), ISO-3166 alpha-2 allow-lists with the same semantics as the contract's (ADR 0035): empty restricts nothing, non-empty is an allow-list, an unknown buyer never satisfies it, a malformed list refuses everyone. Migration `202611130001_rate_plan_markets`: additive, existing plans get `[]`, rollback notes in the header.
- **Narrow only.** A buyer must pass the contract rules **and** the plan rules (`planMarketReasons`, with plan-specific codes `RATE_PLAN_SOURCE_MARKET_NOT_ALLOWED`, `RATE_PLAN_NATIONALITY_NOT_ALLOWED`, `RATE_PLAN_MARKET_RULE_INVALID` so a refusal names its source). The API refuses codes outside a restricted contract's own list (`RATE_PLAN_MARKET_OUTSIDE_CONTRACT`), because they could never sell. Narrowing the contract afterwards is caught by the new activation check `PLAN_MARKETS` and by audit findings `PLAN_MARKET_OUTSIDE_CONTRACT` and `PLAN_MARKET_RULE_INVALID` (FAIL) and `PLAN_MARKET_RESTRICTED` (INFO).
- Enforced where the contract rules are: one evaluator for Agent search, recheck, hold and the simulator. Admin diagnostics without a buyer stay buyer-independent, as for the contract. The adapter reads the buyer's agency market whenever the contract **or the plan** restricts markets.
- Same fail-closed loading: `buildStaySnapshot` throws `RATE_PLAN_MARKETS_NOT_LOADED` if a loader omitted the lists (an undefined list would otherwise read as unrestricted).
- Edits: key left out keeps, `[]` or `null` clears; clone copies the lists; Admin plan form has both lists and shows the contract's own.
- **Channel** (a distribution channel as distinct from buyer market) is not modelled anywhere in the schema and is not part of S3. It needs its own decision.

## Slice S5 (implemented): four-eye activation (D1 to D4)
- **Flow.** `POST rate-plans/:id/activation-request` (version-bound, idempotent on `requestId`) -> `POST rate-plan-approvals/:id/approve|reject|cancel` by a different user -> `POST rate-plan-approvals/:id/execute` once. It reuses `ApprovalRequest` and `ApprovalService` (ADR 0016) with a new approval-only S3 catalogue key `rate_plan.activate` that refines `supply.rates.manage`. No schema change and no new grant. Routes and types are in `@bedbanks/contracts` first.
- **D1 always, with one explicit switch.** `RATE_PLAN_ACTIVATION_APPROVAL` defaults to `required`; `off` is an operator decision recorded in the audit event of every direct activation; any other value fails closed to `required`. It is an environment switch rather than a tenant setting because `TenantSettings` is a display-preferences table behind a dedicated write role, and a security control does not belong in it. Consequence accepted in D1 and written in the runbook: a tenant with one rate manager cannot activate until it has two or the environment runs `off`.
- **D2** the approver is a different holder of `supply.rates.manage`. **D4** requester != approver is enforced by the service and the existing database `CHECK`; the last editor is not blocked.
- **Bound to what was reviewed.** The request stores the plan version and a SHA-256 fingerprint of the plan terms and every dated rate of the plan occupancy from the request day (`rate-plan-fingerprint.ts`; stock counters excluded). Approval is refused if either moved since the request; execute is refused if either moved since the approval (`RATE_PLAN_CHANGED_SINCE_REQUEST|APPROVAL`). Loading another night after the request also voids it, by design. A request that can no longer succeed is superseded when a new one is filed.
- **Approval never waives a check.** Readiness is re-run inside the same Serializable lifecycle transaction, on the narrow `fbeds_rateplan_ops` connection, after the single-use claim (`ApprovalService.execute`, which releases the claim if the action throws, safe because the transition is version-checked and idempotent). The status audit event records mode, approval id, requester and approver; the executor is the event's actor.
- **Permissions.** `ApprovalService` does not check permissions, so every method of the new service checks `supply.rates.manage` (`supply.rates.read` to view). Suspension stays single-actor (it only removes exposure). Capabilities report the mode.
- **Not enforced by the database (D3).** A holder of the lifecycle credential can still write `status`. A trigger requiring an approved request is deferred.
- **Admin.** The plan list shows "Activation approval" instead of "Activate" when the server says `required`; the panel walks request, decide, apply with the server's per-user flags, and explains every refusal.
- **Tests and evidence.** 20 API e2e tests with two managers, a read-only and an other-tenant user (self-approval refused in the service and the database, edit or price change or extra night voiding approval, readiness not waived, concurrent execute, replay, tenant isolation, off and misspelt switch, suspension unaffected); unit tests for the switch, fingerprint, capabilities and the required-mode refusal; Admin tests; strict-role boot smoke phase D on the strict runtime login with the lifecycle role. Existing suites run with `RATE_PLAN_ACTIVATION_APPROVAL=off` from the shared test setup, stated there.

### Known limitation, not changed here (finding F13)
Cancellation penalties (`booking-cancellation.service`) and voucher text read the contract's **live** rules, not a copy frozen at booking. Editing a rule after a booking changes that booking's penalty. S2b routes these through the same resolver so they match the offer, but freezing the policy at booking is a booking-mutation change and needs its own decision.

### Not built
Child and extra-bed lines (S6), grid/CSV (S7), clone writer (S8), expiry sweeper (S9), promotions and derived rates (S10).

## Consequences
- The booking window (distinct from the stay window) is still contract-level.
- Mandatory approval (D1), when built, blocks a tenant with one rate manager. Staff first.
- `DailyRate.occupancy` vs `RatePlan.occupancy` must be settled before pax-mix pricing (finding F12).

## Evidence
See the "Verification" section of the pull request or session report. Anything not run is stated there as NOT RUN.
