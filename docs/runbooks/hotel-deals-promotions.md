# Runbook: hotel deals and promotions (ADR 0089)

Audience: revenue managers, platform operators and on-call engineers. Nothing here deploys, enables booking or touches production data by itself; every command is read-only unless it says otherwise.

## 1. What runs where
| Piece | Where | Notes |
|---|---|---|
| Authoring, approval, lifecycle, simulator | API `PromotionsModule`, `/admin/commercial/promotions` | Needs `supply.rates.read` to read, `supply.rates.manage` to change. Approval is a different person (`ApprovalService`). |
| Pricing | The one stay evaluator (`supply/contracted-sellability.ts`) | A deal is read by `supply/deal-rules.loader.ts` for search, recheck, hold, Admin readiness, rate certification and the inspector. |
| Dates | The evaluator, in the hotel's calendar | No scheduler decides whether a deal sells. |
| Status labels | `POST /admin/commercial/promotions/reconcile` (Admin: "Update statuses") | Idempotent, audited. Saves STARTED and ENDED labels the calendar already applies. |

## 2. Release and deploy (do not run against production without approval)
1. Apply the forward migration `202612050001_hotel_deals` with the owner credential: `pnpm --filter @bedbanks/api prisma:migrate:deploy:owner`. Check `prisma:migrate:status:owner` and `prisma:migrate:drift` ("No schema drift").
2. Re-provision the runtime role from the contract: `ops:provision-api-runtime-role` (owner only), then `ops:verify-...`/`scripts/certify-disposable-runtime-role.cjs` on a disposable copy. The contract now lists `HotelDeal` and `HotelDealRatePlan`.
3. Deploy the API, then the Admin. Search reads the new tables on every request; without the grants it answers `provider_unavailable` (the control fails closed), so do step 2 before step 3.
4. Smoke: create a draft, validate, submit as one user, approve and activate as another, confirm Agent search shows `promotion`, pause, confirm the price returns.

Rollback: stop activating deals (suspend every ACTIVE or SCHEDULED deal from the Admin; stopping is always allowed), then remove the module and drop the tables as listed in the ADR. Prices fall back to the base rate plus plan promotions as soon as deals stop loading.

## 3. Day-to-day operations
- **Stop a deal now:** open it, Pause (a reason is required; resume later) or Suspend (integrity problem; coming back needs a new version and a new approval). Both take effect on the next search and recheck.
- **A deal looks live but should have ended:** it has not sold since its end day (the evaluator ignores it). Press "Update statuses" to save the EXPIRED label, or read `effectiveStatus` on any list or detail.
- **A deal will not activate:** the response lists the validation findings (`DEAL_VALIDATION_FAILED`). Common causes: no ACTIVE rate plan, currency mismatch for a fixed amount, the window already ended, an agency or excluded deal that no longer exists. The approval is released, so fix the cause and activate again; if the terms must change, Return to draft (new version, new approval).
- **Why did a buyer not get the discount:** open the deal, Simulator tab, enter the stay, market and channel. The trace says `NOT_ELIGIBLE`, `GUARD_BREACHED` (which guard), `OUTRANKED` or `EXCLUDED_BY_STACK_RULE`. A deal limited to a market, agency or channel never applies to an unknown buyer or channel.
- **Search answers `provider_unavailable`:** check the API log for `commercial_control_unavailable` with `control: "hotel_deals"`. `reason: denied` means the runtime role lacks SELECT on `HotelDeal` or `HotelDealRatePlan` (re-provision the role); `malformed` means a row broke the contract (a SCHEDULED deal without a start date, an unknown kind): fix or suspend that deal with the owner tools.
- **Reconcile after an outage:** nothing is lost. Run "Update statuses"; it only moves SCHEDULED to ACTIVE and ACTIVE, SCHEDULED or PAUSED to EXPIRED where the hotel calendar already says so.

## 4. Suspending safely on a critical failure
Suspend is a single idempotent call per deal: `POST /admin/commercial/promotions/:dealId/suspend` with `{ "reason": "..." }`. To stop all deals of a hotel, list its ACTIVE and SCHEDULED deals (`GET /admin/commercial/promotions?hotelId=...&status=ACTIVE`) and suspend each. There is deliberately no bulk "activate".

## 5. Scheduler and recovery
No job is required for correctness. If a periodic label update is wanted, build it as a separate worker on its own narrow database role (the pattern of ADR 0084: provision and verify CLIs, INSERT-only audit, no other table), calling the same `reconcile` logic per tenant. Until then the label is saved when someone presses "Update statuses" or calls the endpoint. A missed run cannot sell an expired deal or hold back a due one.

## 6. Security checks to repeat after any change
`pnpm check:architecture` (tenant filter, no-float, runtime role), `pnpm --filter @bedbanks/api test:unit`, `test:e2e -- hotel-deals strict-runtime-role-hotel-deals`, and for the strict role `scripts/certify-disposable-runtime-role.cjs` on a disposable PostgreSQL. A change to `runtime-role-contract.ts` must regenerate the matrix (`ops:render-runtime-role-doc`).

## 7. Known limits
Redemption, attributed revenue and margin reports are unavailable (booking is not writable by the API runtime role). Package add-on, agency segments, member tiers, platform-funded discounts and a below-net override are not supported and are not shown as capabilities. The API channel is accepted but unused until a distribution search exists. The older per-plan promotion editor has no approval and is a privileged path on the strict role.
