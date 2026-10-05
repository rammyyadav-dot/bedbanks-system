# ADR 0033: Rate plan audit and distribution certification

## Status
Accepted for the API, Admin UI and tests in this change. It adds no migration, no table, no permission and no privilege.

## Context
fBeds prices a night from one chain: Hotel, RoomType, RatePlan, Contract, DailyRate, DailyAvailability and, for NET rates, one ACTIVE `CommercialMarkupRule`. One evaluator, `evaluateContractedStay`, decides what Agent search can sell, and the Hotel Operations assessor (`assessHotel`) already reuses it.

Two gaps remained.

1. **The evaluator refuses or prices, it does not audit.** It cannot say *why a plan is a risk before anyone searches*. One case is concrete and was confirmed against the schema: `DailyRate_values_check` allows `amount_minor >= 0`, and the evaluator rejects only a negative amount, so a zero-amount SELL rate is a priced night that sells for nothing. Wrong-currency rows, rows with no verified basis, dead rows for another occupancy and duplicate plans were also only visible one night at a time.
2. **No hotel-level answer to "is this safe to distribute?"**

A pricing-audit specification written for another bedbank described layers, promotions, an agent extra markup, event supplements, SGL/DBL/TPL columns, a Meal Plan Master, a Bulk Rate Loader and whole-AED rounding. None of those exist in fBeds ([docs/rate-certification.md](../rate-certification.md) lists them). This ADR reshapes that request onto the model fBeds really has.

## Decision

### 1. A read-only audit over the existing evaluator
`apps/api/src/rate-certification/rate-plan-audit.ts` is pure (no I/O, no clock). It never decides what sells: sellable nights and per-night reasons come from `assessHotel` and `evaluateContractedStay`. It classifies stored rows and reports where the data would make the evaluator refuse, price wrongly, or leave a person to decide. The service loads the same rows search prices from, inside the caller's tenant transaction (RLS), and writes nothing.

### 2. Certification is an observation, not a switch
Plans are `PASS`, `WARN` or `FAIL`; hotels are `NOT_READY`, `READY_WITH_WARNINGS` or `CERTIFIED`. Nothing stores or reads these values: no flag gates search, recheck, holds or booking, because none exists and inventing one would create a second sellability authority (invariant 10). A plan that is not `ACTIVE` is reported as not live and never failed.

### 3. Findings and severities
`FAIL` means a priced night would be wrong, refused or ambiguous: zero amount, currency other than the plan's, no verified basis, NET without an applicable markup rule, a plan currency that is not enabled (ADR 0029) or differs from the contract's, occupancy above the room maximum, a live plan under a contract that is not ACTIVE, no priced night in the window, a code shared by two live plans of a hotel, a logical duplicate plan. `WARN` means it sells today but needs a person: rate gaps, mixed NET/SELL, rows outside the contract, rows for another occupancy, availability gaps, nothing sellable, code format, an expiring contract, recorded sales markets or nationalities, a zero or very high markup rule.

**Documented deviation: sales markets.** The contract records `salesMarkets` and `nationalities`, but search does not apply them. A recorded market is therefore a `WARN` (the plan is sold to every agency) and a blank record is silent. Making either a `FAIL` would certify no plan, and the audit must not pretend a market restriction is enforced.

### 4. Row classes
Each loaded `DailyRate` row is `VALID`, `QUARANTINED` (zero amount, wrong currency or unverified basis), `DEAD` (another occupancy), `OUTSIDE_CONTRACT` or `BLOCKED_NO_MARKUP`. Duplicate (plan, date, occupancy) keys are impossible because the table has a unique key, so there is no ambiguous class and no merge. Overlapping ACTIVE markup rules for one target are impossible because of a partial unique index, so there is no overlap check.

### 5. Code governance is advice
Codes should match `^[A-Z0-9]+(-[A-Z0-9]+)*$` (max 32). A non-matching live plan gets a `WARN` and, when it does not collide with another code of the hotel, a *suggested* code. Nothing renames a plan.

### 6. A read-only simulator
`POST /admin/rate-certification/simulate` prices a stay through `evaluateContractedStay` and returns per-night rate, basis, markup basis points, half-up markup and sell, plus an independent recomputation (rate plus `markupMinor` per night, times rooms) and whether it reconciles. It writes no hold, rate, audit event or row, so it needs no idempotency key. Money is integer minor units in decimal strings; there is no floating point and Admin formats them with the existing `formatMinorUnits`.

### 7. Fail closed, never "no rules"
The audit reads ACTIVE markup rules through the shared loader. A denied or failed read throws `CommercialControlUnavailableError` (503 `COMMERCIAL_CONTROL_UNAVAILABLE`, ADR 0031): a certification must never report NET plans as unpriced because a read failed.

### 8. Authorization and the strict role
Every route needs the existing `supply.rates.read` permission through a formal role (`SupplyPermissionGuard`); tenant identity comes from the session. Every table the audit reads is already SELECT-granted to `fbeds_api` (checked by the strict-role e2e), so no privilege changes.

### 9. Bounded work
A request loads at most 200 hotels and audits live plans in name order until a budget of 60,000 plan-nights (about 0.2 ms each) is spent; the response says `scanCapped` when either limit trimmed it. The window is 1 to 365 nights (default 90).

### 10. Remediation is a to-do list
Findings map to P0 (price integrity), P1 (coverage, duplicates, expiry, unenforced markets) and P2 (hygiene), each with a plain-language next step. There is no bulk action, no auto-repair and no "fix everything" control, and the UI has no write control other than the simulator.

## Consequences
- Operators can see zero-amount and wrong-currency rows before an Agent does. The evaluator is deliberately unchanged: rejecting a zero amount there is a pricing-behaviour change that needs an owner decision (it could also be done by a CHECK `amount_minor > 0` after the existing data is reviewed). Until then, the audit is the control that reports it.
- Not certified here: a plan with live availability the audit cannot see (supplier connectors), booking-time pricing (booking is disabled) and production data (no approved clone).
- Revisit if a distribution-ready flag is ever added: it must be written by an approved, audited action and read by the evaluator, not by this module.
