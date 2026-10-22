# ADR 0080: Commercial and Distribution Engine, cascading markup, FX margin, distribution rules

## Status
**Proposed.** Only the pure computation core is built (`@bedbanks/pricing`: `cascade.ts`, `fx.ts`, `guards.ts`, with tests). Nothing is wired to the evaluator, API, database or Admin UI, so no route or screen may present any of it as a capability (CLAUDE.md invariant 10). Each phase below needs its own review before it ships.

## Context
The audit in `docs/commercial-distribution-audit-2026-10-21.md` found that markups (ADR 0018, 0067 F-11), controlled FX (ADR 0067 F-12), agency restrictions (ADR 0019) and rate certification (ADR 0033) are live, but the pricing model is "most specific rule wins", not a cascade. There are no fixed-amount markups, no destination/star/chain targeting, a single FX buffer with no volatility margin or staleness limit, no stay-rule restrictions, no channel overrides, and no margin or parity findings.

## Decisions
1. **Layers.** Markup is a fixed-order cascade on the running amount: base net, `SUPPLIER_CONTRACT`, `AGENCY_TIER`, `CLIENT`, `GLOBAL_OVERRIDE`. At most one rule per layer: the one naming the most target fields wins; a tie in one layer is a configuration error that is surfaced, never resolved by guessing. Targets: supplier, hotel, country, city, star rating, chain, agency, agency tier.
2. **Adjustments.** Percent (integer basis points, half up per layer, as `markupMinor`) or fixed minor units in the plan currency. Only the global override may `SET_SELL`. No layer may take the price below net.
3. **Trace.** Every priced night keeps the per-layer trace (rule id, before, delta, after) so the simulator, audit and booking snapshot can reproduce the price. The evaluator remains the single pricing path (ADR 0058).
4. **FX.** Buyer rate = mid rate widened by `bufferBp + volatilityBp` (total at most 2 500 bp), always against the buyer. A rate older than its `maxAge` is refused, not used. One rounding step, half up, with per-currency minor-unit exponents. Rates stay maker-checker activated.
5. **Guards.** `MARGIN_NEGATIVE` (FAIL), `MARGIN_SQUEEZE` (WARN; percent or absolute floor) and `CHANNEL_PARITY_VIOLATION` (FAIL; spread over the lowest channel price above a tolerance) are computed by pure functions and surfaced as rate-certification findings.
6. **Distribution rules** (min/max LOS, booking window, blackout dates) narrow what a channel can sell, never grant access or change a price, and are evaluated in the same evaluator as `minStay`/`maxStay`/`releaseDays` today. Channel overrides are rows keyed by tenant and channel; the channel comes from the authenticated distribution credential, never a request field (invariant 1).

## Business decisions (2026-10-21, recorded; thresholds are defaults, tenant level with channel override)
1. **Compounding by default, flat per rule.** A percent adjustment carries `base: 'RUNNING'` (default) or `'NET'` (flat against the original net, for GSA or corporate contracts). Implemented in `applyMarkupCascade`.
2. **Margin and parity.** Margin is measured on the sell price: under 8.00% is a WARN (`MARGIN_SQUEEZE`), under 3.00% is a FAIL that blocks distribution (`MARGIN_BLOCKED`). Parity against the public B2C baseline flags only when the variation exceeds both 0.50% and one major unit of the currency (interpretation of "or absolute variance"; confirm). Implemented as `DEFAULT_MARGIN_POLICY` and `checkParityAgainstBaseline`; the per-tenant and per-channel storage is phase P2.
3. **FX.** Stable majors (USD, AED, EUR, GBP): 30 to 50 bp volatility margin, 4 hour maximum age. Any corridor with another currency (INR, THB, AZN): 100 to 150 bp, 1 hour. Hard expiry at 12 hours. Implemented as `fxCorridorPolicy`, `fxRateFreshness`, `fxVolatilityOutOfBand`; THB and AZN added to the supported minor-unit table.
4. **Open conflict: no cached-rate fallback.** The proposal to "fall back to cached safe rates" when a feed stalls contradicts invariant 5 unless it is an explicit policy. Until a policy defines who may sell on a cached rate, for how long, with what extra margin and with what alert, a stale or expired rate is refused. A stalled feed therefore stops sales in that corridor.
5. **Chain data.** Source hierarchy: canonical hotel master registry, then supplier feed values at ingestion, then operator-verified mapping in the Admin mapping workspace. This extends ADR 0009 and 0059 and needs a nullable `chainCode` on the canonical hotel (phase P2 migration). The repo has no registry named "Escanva"; the canonical hotel table is the registry unless you mean an external dataset, which needs its own ADR.

## Phases (each a separate reviewed change)
| Phase | Content | Needs |
|---|---|---|
| P1 | **Done as an adapter:** `supply/markup-cascade-adapter.ts` prices today's rules through the cascade engine; `markup-cascade-adapter.spec.ts` proves the same sell price and refusal for every rule set, buyer and net tested. Not called by the evaluator, so no flag is needed yet: with one layer there is nothing to shadow. A flag and shadow run become meaningful when P2 allows more layers | Done |
| P2 | **Migration written** (`202612030001_commercial_cascade_fx_margin_chain`), validated on a disposable local PostgreSQL 16 only; not applied to any persistent environment. Nothing reads the new columns yet. Agency tier deferred. Original scope: `layer`, `adjustment_kind`, `fixed_amount_minor`, target columns on markup rules; `volatility_bp`, `max_age_seconds` on FX rates. Forced RLS, `(tenant_id, status)` and `(tenant_id, layer)` indexes, expand-only, rollback notes | Prisma migration review, ADR 0013 runtime grant decision |
| P3 | Contracts in `@bedbanks/contracts`, then API `GET/POST /admin/commercial/markups` v2, permission `supply.rates.manage`, audit events | Contract check |
| P4 | Admin: layered rule editor and trace in the Simulator; FX volatility and age columns | P3 shipped |
| P5 | Restrictions (LOS, windows, blackouts) and channel overrides; `distribution.rule.approve` is already catalogued as planned | Permission promotion to enforced |
| P6 | Margin and parity findings in rate certification | P1 |

## Consequences
- Existing single-winner rules remain valid: one rule is a one-layer cascade.
- Compounding layers change prices only when more than one layer matches; P1's shadow run must show zero unexplained differences before the flag is turned on.
- Rollback for the built code: nothing imports it yet, so deleting the three files restores the prior state.
