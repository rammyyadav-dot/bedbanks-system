# Hotel Deals & Promotions: workflow and mechanism (CTO draft)

Status: **Proposed. Nothing in sections 3 to 9 is built.** Section 1 is what exists today, verified in code. Section 2 is the gap with the "Create New Promotion" screen. Promote to ADR 0089 (next free number is to be confirmed) before any implementation, per the change protocol.

## 0. Terminology trap
"Promotion" is used for two unrelated things in this repo. This document covers only the first.
1. **Hotel promotion / deal**: a discount a hotel offers a buyer (ADR 0058, ADR 0067 F-09). Table `RatePlanPromotion`.
2. **Supplier promotion / feed promotion**: moving supplier-feed observations into contracted rates and stock (ADR 0082, 0083, 0084, `apps/api/src/supplier-promotion`, `mapping/promotion-rules.ts`). Not a discount.

## 1. What exists today (verified)
| Area | Fact | Where |
|---|---|---|
| Model | One promotion belongs to **one rate plan**. 4 kinds: `EARLY_BIRD`, `LAST_MINUTE`, `LONG_STAY`, `FREE_NIGHTS`. Percent in basis points (1..9000). | `schema.prisma` `RatePlanPromotion`, `supply/promotions.ts` |
| Conditions | Booking window, stay window (`WHOLE_STAY` or `NIGHTS_IN_WINDOW`), lead days, min nights, `discountBase` (`ROOM_AND_GUESTS` / `ROOM_ONLY`). Lead is counted in the **hotel's** calendar; unknown time zone means "does not apply". | `promotions.ts` |
| Selection | One promotion per stay (largest saving, tie to lowest id). Promotions flagged `combinable` may stack (FREE_NIGHTS first, then by id) only if the stack beats the best single. Max 20 per plan. | `selectPromotion`, ADR 0058, ADR 0067 F-09 |
| Pricing position | `base rate + guest lines - promotion = net after (>= 1 minor unit); + markup = sell`. One evaluator prices search, recheck, hold, simulator, readiness. | ADR 0058 |
| API | `GET/PUT /rate-plans/:id/promotions` (PUT replaces the full set atomically, version-checked), `POST /hotels/:id/promotions/bulk-apply` (idempotent, all-or-nothing). Permissions `supply.rates.read` / `supply.rates.manage`. | `supply.controller.ts:64-66`, contracts `rate-plan-lifecycle.ts` |
| Governance | Save moves the plan version, so an activation approval filed earlier is void; promotions are in the approval fingerprint; audit with before/after; clone does not copy promotions. | ADR 0058, 0057 |
| Admin UI | Per-plan `PromotionsPanel` and hotel-wide `HotelOfferPanel` (bulk apply). The tab "Deals & Promos" opens the `promotions` view of the rate-plan tab. | `apps/admin/components/commercial/PromotionsPanel.tsx`, `hotels/panels/HotelOfferPanel.tsx`, `HotelManagementTabs.tsx:19` |
| Not decided (ADR 0058) | Fixed-amount promotions, coupon codes, channel-only promotions, loyalty/member, contract or hotel scope, per-date guest lines. | ADR 0058 "Not decided here" |

I found no hotel-level promotion entity, no draft/activate lifecycle, no promotion approval and no promotion API outside the rate plan. The Admin department map still lists Promotions as `todo` (`packages/contracts/src/admin-departments.ts:194`). If the "Create New Promotion" screen exists in a branch I did not inspect, it is not on this one.

## 2. Gap: the "Create New Promotion" screen versus the backend
Invariant 10: a screen is not a capability. Each control below is classified so nothing is shown as live before it works.

| Screen control | Backend today | Verdict |
|---|---|---|
| Percent Off, Early Bird, Flash Sale (last minute), Stay X Pay Y / Free Night | Covered by `LONG_STAY`, `EARLY_BIRD`, `LAST_MINUTE`, `FREE_NIGHTS` | Wire now (P1) |
| Travel period, booking window, min length of stay | `stayFrom/To`, `bookFrom/To`, `minNights` | Wire now (P1) |
| Day-of-week applicability | Not in model | New rule (P2) |
| Room Types / Rate Plans scope | Per rate plan only | Wire via expansion (P1) |
| Fixed Amount Off | Undecided (ADR 0058) | Needs decision (P3) |
| Discount Subsequent Nights, Package Add-On | Not modelled | Needs decision (P3) |
| Channels, Source Markets, Agency Segments | No promotion field; channel overrides exist only as a proposal (ADR 0080 P5) | New audience rule (P2) |
| Member Only, Member Tiers | No loyalty concept | Hide until decided (P3) |
| Promotion Code | No coupon concept; redemption caps and abuse handling absent | Hide (P4+) |
| Priority "higher applied first" | **Contradicts** ADR 0058 "largest saving wins" | Decision D1 |
| Stacking Policy, Stacking Group, Compatible / Incompatible IDs, Same-Family Stacking | Only the boolean `combinable` | Decision D1 |
| Funding Source (Supplier funded) | No concept | Decision D3 |
| Min Sell Floor, Min Margin %, Max Discount %, Allow Below Net | Margin guards exist as pure functions (ADR 0080) and are not wired; net >= 1 floor exists | P2, after ADR 0080 P6 |
| Draft / Activate / Save & Activate | No lifecycle | P1 |
| Preview Simulator | Rate-plan simulator exists; no promotion preview | P1, must call the real evaluator |

## 3. Proposed model
**Deal** is the authoring aggregate at hotel level. It is **compiled into `RatePlanPromotion` rows** on the plans it targets. The evaluator stays the only pricing path (ADR 0058 principle 2); a deal never prices anything itself.

```
HotelDeal (tenant_id, hotel_id, code?, name, kind, status, version, rule JSON-free columns,
           scope: room_type_ids[] , rate_plan_ids[], audience, guard policy, funding)
   ──compile on ACTIVATE──▶  RatePlanPromotion (one per targeted plan, deal_id FK)
```
- Money: percent as basis points; fixed amounts as integer minor units plus ISO-4217 currency, never floats (invariant 3). Launch currency AED (ADR 0029).
- Columns, not an opaque JSON blob, for anything the evaluator reads; the evaluator input type stays in `packages/domain`/`supply`, transport-agnostic (dependency direction).
- Every table carries `tenant_id`, forced RLS and a `(tenant_id, hotel_id, status)` index. Tenant comes from the session only (invariant 1).

## 4. Lifecycle
```
DRAFT ──submit──▶ PENDING_APPROVAL ──approve──▶ SCHEDULED ──start date──▶ ACTIVE ──end/stop──▶ EXPIRED
  ▲                    │ reject                       │                       │ pause
  └────────────────────┘                              └──cancel──▶ CANCELLED  └──▶ PAUSED ──resume──▶ ACTIVE
```
- **Maker-checker** on activation, as for hotel publication (ADR 0022) and rate plan terms (ADR 0057). Maker holds `supply.rates.manage`; checker holds a new `supply.promotions.approve` (to be catalogued; the checker cannot be the maker). Pausing is allowed to the maker (emergency stop must be fast); resuming goes through the checker if any rule changed.
- Editing an ACTIVE or SCHEDULED deal creates a new version in DRAFT; the live version keeps selling until the new one is approved. No in-place edit of a live price rule.
- Activation is blocked unless every targeted plan is ACTIVE or being activated, is AED-denominated, has valid rates, and passes the guards in section 6.
- Start and end are enforced by the evaluator through the stay and booking windows, evaluated in the **hotel's** calendar, not by a cron that flips rows. A cron only moves status labels (SCHEDULED to ACTIVE to EXPIRED) and cannot make a promotion apply or stop applying.

## 5. Mechanism at search, recheck and booking
1. Search resolves tenant, channel, market and agency from the authenticated distribution credential (invariant 1). **Audience filters narrow, never grant**, and never come from a request field.
2. For each room and plan, the evaluator loads the plan's active promotions and runs the ADR 0058 order: base, guest lines, promotion, markup, sell.
3. Selection follows ADR 0058 and 0067: one best promotion, or a combinable stack when it saves more. Any new stacking rule (D1) lands in the evaluator and its spec first.
4. The offer carries the applied promotion id, name, kind and saving; the booking snapshot stores the same so a later change to the deal cannot reprice or dispute a confirmed booking.
5. Recheck and hold re-run the same evaluation; if the promotion no longer applies (expired, paused, window closed) the price changes visibly, never silently.
6. Failure policy: an unreadable rule, unknown hotel time zone or ambiguous audience means the promotion **does not apply** with a typed reason. It never discounts on a guess, and never returns a zero price (net after promotion >= 1).

## 6. Commercial guards (all pure functions, one place)
- Net after promotion >= 1 minor unit (exists).
- `MARGIN_NEGATIVE` FAIL, `MARGIN_SQUEEZE` WARN at 8%, `MARGIN_BLOCKED` below 3% (ADR 0080, tenant default). A deal whose worst case across its date range breaches FAIL cannot be submitted. "Allow below net" is not offered; any override is a separate, audited, approver-only decision (D2).
- Maximum discount cap and minimum sell floor per deal, stored as basis points and integer minor units.
- Conflict detection at submit: overlapping deals on the same plan and dates are listed with the selection outcome, so the maker sees which would win.
- Surfaced in the Commercial Integrity strip as a new "Promotion issues" counter and in rate certification findings. A hotel with promotion issues is **not** blocked from publishing unless an ACTIVE deal is in FAIL.

## 7. API and contracts (contracts first, invariant 4)
All in `@bedbanks/contracts` before the frontend consumes them; every controller declares and verifies a permission.

| Route | Permission | Notes |
|---|---|---|
| `GET /hotels/:id/deals` | `supply.rates.read` | filter by status, date |
| `POST /hotels/:id/deals` | `supply.rates.manage` | creates DRAFT; `Idempotency-Key` |
| `PUT /hotels/:id/deals/:dealId` | `supply.rates.manage` | version-checked |
| `POST .../deals/:dealId/preview` | `supply.rates.read` | read-only; runs the real evaluator; writes nothing |
| `POST .../deals/:dealId/submit`, `approve`, `reject`, `pause`, `resume`, `cancel` | manage / `supply.promotions.approve` | all idempotent; state machine in one pure module |

Every mutation writes an immutable audit event with before and after (invariant 8). No supplier payloads, tokens or guest PII are logged (invariant 7).

## 8. Admin UX flow
1. **List** (current empty state kept): status, kind, scope, dates, saving preview, issues. Counter in the tab label counts ACTIVE deals.
2. **Create**: only controls whose backend exists are enabled. Unbuilt controls are **absent**, not disabled and not labelled "coming soon" in a production build.
3. **Preview**: runs the evaluator for a chosen room, plan, dates and booking date and shows nightly net, promotion, markup and sell with the margin result. The preview inputs (net, B2B sell) are read from the plan's real rates, not typed in, so the preview cannot be made to disagree with the engine.
4. **Submit for approval**, then **Activate** appears only for the checker after approval. "Save & Activate" is removed for makers.
5. Rate plan view keeps showing compiled promotions read-only with a link to their deal; direct edits to a compiled row are refused.

## 9. Phasing
| Phase | Scope | Gate |
|---|---|---|
| P0 | ADR for this design; resolve D1 to D4 | Owner decisions |
| P1 | `HotelDeal` for the four existing kinds, scope expansion to plans, compile to `RatePlanPromotion`, lifecycle with maker-checker, preview, audit, list/create UI | Reviewed Prisma migration, rollback notes, tenant-index review, contracts, e2e |
| P2 | Day-of-week rule, audience (channel, market, agency segment) via authenticated credential, margin and cap guards | ADR 0080 P5/P6, evaluator specs |
| P3 | Fixed-amount, subsequent-night discount, add-on, member tiers | Own ADRs |
| P4 | Coupon codes with redemption caps and anti-abuse | Own ADR |

Rollback for P1: feature flag off hides the screens and stops compilation; compiled `RatePlanPromotion` rows remain valid on their own, so pricing is unchanged. The migration is expand-only.

## 10. Decisions needed from the owner
- **D1 Stacking and priority.** Keep ADR 0058 "largest saving wins, optional combinable stack", and drop Priority and Stacking Group from the screen (recommended); or introduce priority-ordered application, which changes the order of operations and every price.
- **D2 Below-net override.** Recommended: not offered in P1 to P2.
- **D3 Who funds a discount.** Today it is a supplier-side saving and the markup follows it (ADR 0058). Hotel-funded, platform-funded or shared funding changes ledger and settlement treatment (ADR 0062, 0077) and needs finance sign-off before any funding field is shown.
- **D4 Feed-managed plans.** The feed owns prices on a feed-managed plan (ADR 0082). Recommended: promotions are allowed there, since they are discounts on top of the feed price and never overwrite it, but this must be stated explicitly.

## 11. Test and release plan
Pure unit specs for the state machine and each new rule; evaluator specs that prove one price for search, recheck, hold and preview; e2e for maker-checker, idempotent replay, tenant isolation (a second tenant cannot read or preview a deal) and permission denial on every route. Run `pnpm check:architecture`, `pnpm type-check`, `pnpm lint`, `pnpm test` and the affected builds before merge.
