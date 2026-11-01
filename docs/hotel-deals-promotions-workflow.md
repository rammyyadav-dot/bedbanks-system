# Hotel deals and promotions: lifecycle, pricing semantics, API and controls

Status: **Implemented for the scope in ADR 0089** (this replaces the 2026-10-23 proposal that first sat in this file). What is not built is listed in section 11 and is not shown as a capability anywhere. Evidence and test results: `docs/audits/2026-10-23-hotel-deals-promotions-audit.md`. Operations: `docs/runbooks/hotel-deals-promotions.md`.

Terminology: "promotion" also names the supplier-feed promotion of ADR 0082 to 0084 (moving feed observations into contracted rates). That is unrelated and untouched.

## 1. Model
`HotelDeal` (one per promotion, tenant and hotel scoped) and `HotelDealRatePlan` (the plans it applies to). A deal is **not** copied into `RatePlanPromotion`: ACTIVE deals are read at pricing time and become `PromotionRule` objects for the one evaluator.

| Concern | Rule |
|---|---|
| Tenant | `tenant_id` on both tables, forced RLS through `fbeds_current_tenant_id()`, composite foreign keys `(tenant_id, hotel_id)` and `(tenant_id, rate_plan_id)`, tenant taken only from the session |
| Identity | unique per tenant: `code` (case-insensitive), `idempotency_key`; never deleted (ARCHIVED), no DELETE grant |
| Deletion | `ON DELETE RESTRICT` everywhere; a plan in a deal cannot be deleted |
| Version | `version` starts at 1, +1 on every draft edit and every return to draft; approvals bind to `(version, SHA-256 fingerprint of the canonical terms)` |
| Concurrency | `expectedVersion` on edit, submit and return-to-draft; `SELECT ... FOR UPDATE` and conditional `UPDATE ... WHERE status AND version` on every transition |
| Money | integer minor units (`BIGINT`) plus an ISO-4217 currency (FIXED_OFF only); percentages in basis points; sent over the API as decimal strings |
| Time | `active_from/to`, book and stay windows and weekdays are dates in the **hotel's** calendar (`Hotel.time_zone`); an unknown hotel day means the deal does not apply |
| Retention | deals, approvals and audit events are kept; nothing is purged |

## 2. Lifecycle
```
DRAFT -> PENDING_APPROVAL -> APPROVED -> SCHEDULED -> ACTIVE -> PAUSED <-> ACTIVE
   ^           |   |            |           |          |  \-> SUSPENDED -> DRAFT (new version) | ARCHIVED
   |<----------+   +-> REJECTED -+-> DRAFT   +-> EXPIRED -> ARCHIVED
```
| Step | Who | What the server does |
|---|---|---|
| Create / edit draft | `supply.rates.manage` | Parses with an allow-list (unknown fields refused), checks scope inside the hotel and tenant, audits field-level changes. Saving never activates. |
| Validate | `supply.rates.read` | Returns findings against the live catalogue. ERRORs block submit and activation. |
| Submit | `supply.rates.manage` | Re-validates, fingerprints the terms, files approval `promotion.activate` (idempotent on `requestId`), locks the deal. |
| Approve / reject | a **different** `supply.rates.manage` holder | `ApprovalService` refuses the maker (403) and a second decision (409). A reason is required and kept. |
| Activate | `supply.rates.manage` (may be the maker) | Single-use. Re-checks status, version, fingerprint, validation and that the window has not ended under a row lock. Becomes ACTIVE, or SCHEDULED when `activeFrom` is in the hotel's future. Records `activatedBy`. |
| Pause / resume | `supply.rates.manage` | Pause needs a reason; resume re-validates. |
| Suspend | `supply.rates.manage` | Reason required, always allowed. Coming back needs return-to-draft, a new version and a new approval. |
| Return to draft | `supply.rates.manage` | From REJECTED, SUSPENDED or APPROVED. Raises `version`, clears fingerprint, approval and activation; earlier approvals can never activate the new version. |
| Expire | the calendar | `effectiveStatus` is EXPIRED the day after `activeTo`; the evaluator stops applying it that day. "Update statuses" persists the label. |
| Archive | `supply.rates.manage` | From DRAFT, REJECTED, PAUSED, SUSPENDED or EXPIRED. |

The same graph is enforced by the database trigger `fbeds_hotel_deal_guard`.

## 3. Supported types: exact semantics
All types discount the **supplier net** of an eligible night before the markup (ADR 0058), so the platform margin follows. A night never falls below 1 minor unit. Rounding: half up on integer minor units, per night. Taxes and fees are not separate in contracted rates (taxes inclusive per plan flags) so nothing is split; supplements are added **after** the deal and are never discounted. "Eligible night" means the night is inside the travel window when the mode is `NIGHTS_IN_WINDOW`, and on one of the deal's weekdays when a weekday list is set.

| Type | Applies when | Effect | Required fields |
|---|---|---|---|
| `PERCENT_OFF` | stay has at least `minNights` (default 1) | `percentBp` off every eligible night | `percentBp` |
| `EARLY_BIRD` | booking lead (hotel days from today to check-in) >= `minLeadDays` | `percentBp` off every eligible night | `percentBp`, `minLeadDays` |
| `FLASH_SALE` | today is inside `bookFrom..bookTo` (both required) | `percentBp` off every eligible night | `percentBp`, `bookFrom`, `bookTo` |
| `STAY_X_PAY_Y` | nights >= X (`minNights`) and the stay keeps a paid night | the cheapest `freeNights` (X minus Y) eligible nights are free, **once per stay**; ties: the later date is free | `minNights`, `freeNights` |
| `SUBSEQUENT_NIGHTS` | nights >= `fromNight` | night 1 up to `fromNight`-1 full price; `percentBp` off from `fromNight` on | `percentBp`, `fromNight` (2 to 365) |
| `EVERY_NTH_FREE` | nights >= N (`minNights`) | one cheapest eligible night free per **full block** of N nights (7 nights, N=3: two free) | `minNights` = N |
| `FIXED_OFF` | plan currency equals the deal currency | `amountMinor` off each eligible night (`PER_NIGHT`) or split over the eligible nights in integers, first nights taking the remainder (`PER_STAY`); a night is capped at net minus 1 and, with a room-only base, at the room rate; capped nights simply take less | `amountMinor`, `currency`, `amountScope` |
| `PACKAGE_ADD_ON` | **refused** (`PROMOTION_TYPE_UNSUPPORTED`) | it changes what is sold, not the price | n/a |

Common options: `stayWindowMode` (whole stay inside the window, or only the nights inside), `discountBase` (room and guest lines, or room only), `weekdays`, `activeFrom/To`, `priority`, `combinable`, `stackingGroup`, `incompatibleDealIds`, audience lists and guards.

Expected outputs: the Agent offer carries `promotion { name, kind }` and the total already includes the saving; recheck reprices through the same path; the Admin simulator returns per-night base net, deal, supplements, net after, markup and sell, totals with and without the deal, margin, and a trace of every rule considered.

## 4. Pricing order and safeguards
`rate + guest lines` then **one** promotion (or a combinable stack) then `+ supplements` then `+ markup` then `sell` (then one FX conversion). One evaluator prices every surface; a deal never prices itself.
- **Selection:** the larger saving wins; equal savings go to the higher `priority`, then the lower id. Priority never overrides a guard, an eligibility rule or a larger saving. The same deal id applies once.
- **Stacking:** only `combinable` deals, never in the same `stackingGroup`, never when either lists the other in `incompatibleDealIds`; free-night types first, then by id; used only when the stack saves more than the best single, and every guard is judged on the whole stack.
- **Guards** (per deal, judged on the nights it changed, on net plus markup): `maxDiscountBp` (of the net before the deal), `minSellFloorMinor`, `minMarginBp` (on the sell price). A breach, or a guard that cannot be verified (a SELL-basis rate has no known net; no markup information), means the deal is not applied and the buyer gets the base rate. A discount above 50% must carry a sell floor.
- **Below net:** impossible. There is no override, no field and no permission for it. Any request carrying one is refused.
- **Fail closed:** unreadable deals stop search (`provider_unavailable`); an invalid or ineligible deal is simply not applied and the base rate stands; a base rate that cannot be sold stays unsellable (a deal never rescues it); an unknown buyer, market, channel or hotel day never satisfies a restriction.
- **Audience:** `channels` (`PORTAL`, `API`), `sourceMarkets` (buying agency country), `agencyIds`: allow-lists that narrow and never grant. The channel is stated by the pricing caller. No segment or tier exists.

## 5. API (`@bedbanks/contracts`, `routes.adminCommercial`)
Read = `supply.rates.read`; write = `supply.rates.manage`. Errors use the standard envelope; codes below are in `error.code`.

| Route | Purpose |
|---|---|
| `GET /admin/commercial/promotions` (`hotelId`, `status` as it applies today, `kind`, `q`, `page`, `pageSize`) | list |
| `GET .../summary`, `GET .../approval-queue` | counts by what applies today; promotions awaiting a decision with live validation |
| `POST .../` | create draft (`idempotencyKey`, `hotelId` required) |
| `GET/PUT .../:dealId` | read with capabilities; replace a draft (`expectedVersion`) |
| `POST .../:dealId/validate`, `/preview` | findings; read-only price simulation (writes nothing) |
| `POST .../:dealId/submit`, `/withdraw`, `/pause`, `/resume`, `/suspend`, `/return-to-draft`, `/archive` | lifecycle |
| `POST .../approvals/:approvalId/approve`, `/reject`, `/execute` | decision (a different person), activation (single use) |
| `POST .../reconcile` | persist started and ended labels (idempotent) |
| `GET .../:dealId/audit-log`, `/performance` | approvals and audit events; honest operations data |

Notable codes: `DEAL_FIELD_NOT_ALLOWED`, `PROMOTION_TYPE_UNSUPPORTED`, `DEAL_FUNDING_UNSUPPORTED`, `DEAL_CODE_TAKEN` (409), `IDEMPOTENCY_KEY_REUSED` (409), `DEAL_CHANGED` (409), `DEAL_TERMS_LOCKED` (409), `DEAL_VALIDATION_FAILED` (409 with findings), `DEAL_TRANSITION_NOT_ALLOWED` (409), `DEAL_NOT_AWAITING_ACTIVATION` (409), `DEAL_NOT_FOUND` / `NOT_FOUND` (404 for another tenant's id, identical to a missing one).

## 6. RBAC and approval matrix
| Action | Permission | Separation of duties |
|---|---|---|
| Read, list, validate, preview, audit | `supply.rates.read` | none |
| Create, edit, submit, withdraw, pause, resume, suspend, archive, return to draft, reconcile | `supply.rates.manage` | none |
| Approve / reject | `supply.rates.manage` (approval action `promotion.activate`, S3) | decider must differ from the requester |
| Activate | `supply.rates.manage` | needs an APPROVED request bound to the current version and fingerprint; recorded separately from the decision |
Tenant scope only: the catalogue marks region and property scope as business scope until the backend enforces it (ADR 0015). A dedicated grantable approver permission is a later change.

## 7. Validation findings (ERROR blocks, WARNING informs)
ERROR: invalid hotel time zone, window already ended, rate plan missing or of another hotel, no ACTIVE plan, fixed-amount currency matches no plan, unknown agency or incompatible deal, a deal incompatible with itself. WARNING: plan or contract not ACTIVE, plan currency mismatch, dates outside plan or contract validity, no stored rates ahead, discount not below the lowest rate, margin guard on SELL-basis rates, sell floor above existing SELL rates, API channel not distributed, overlap with another live or pending deal.

## 8. Audit
`promotion.deal.created|updated|submitted|approved|rejected|activated|paused|resumed|suspended|returned_to_draft|archived|started|expired`, plus `approval.requested|approved|rejected|executed|cancelled` and `permission.denied`. Each carries actor, tenant, deal id, request id and the change (field names and values; never notes or descriptions). `AuditEvent` is insert-only for the runtime role.

## 9. Error behaviour summary
400 invalid input (all problems listed together); 403 no permission or self-approval; 404 unknown or other tenant's id; 409 state, version, idempotency or validation conflict; 503/`provider_unavailable` only for an unreadable mandatory control. Nothing is written on a refused request.

## 10. Channels and distribution
Only the Agent portal prices deals. The distribution API has scopes but no search route yet, so `API`-limited deals apply nowhere and the Admin shows the channel as not published. No connector accepts promotion publication; none is simulated.

## 11. Not built, not shown as capability
Package add-on; agency segments; member tiers and loyalty; platform- or hotel-funded discounts; a below-net override; guest-redeemed promotion codes; redemption, attributed-revenue and margin reporting (booking tables are not writable by the API role); external channel publication; a periodic status sweeper (needs a dedicated role); a dedicated approver permission; changes to the legacy per-plan promotion editor.
