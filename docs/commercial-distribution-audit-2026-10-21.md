# Commercial and Distribution Engine: CTO audit (2026-10-21)

Scope: `apps/admin` Commercial, Distribution and Rate Certification, read with `apps/api/src/{commercial,supply,distribution,rate-certification}`, `packages/{pricing,money,contracts}` and `apps/api/prisma/schema.prisma`. Items marked **verified** were read in code; the pricing package tests were run in this session.

## Verdict
**Amber.** The governed core is real and well built: integer-money markup, maker-checker activation, forced RLS, audit events, a single evaluator, and a read-only simulator. The requested engine is a superset of it. The gaps are model gaps (cascade, fixed amounts, targeting, FX risk margin, stay rules, channels), not defects in what exists.

## Requested capability against the code
| Requested | State | Evidence |
|---|---|---|
| `/commercial/markups` | **Live**, percent only | `commercial/markups/page.tsx`, `commercial-markup.service.ts` |
| `/commercial/fx` | **Live** at `/commercial/fx-rates` (route name differs from the brief) | `commercial-fx.service.ts`, `supply/fx.ts` |
| Cascade Base, Supplier Contract, Agency Tier, Client, Global Override | **Not built.** Today the single most specific rule wins (client > market > hotel > supplier > default); layers never compound. No agency-tier or global-override concept | `supply/markup-rules.ts` |
| Fixed-amount markup | **Not built** (`basisPoints` only) | `CommercialMarkupRule` |
| Per destination, star category, chain | **Not built.** Scope is tenant, supplier or hotel. `Hotel` has `city`, `countryCode`, `starRating`; no chain field exists | schema |
| Multi-currency FX, buffer | **Live**, controlled, maker-checker, one ACTIVE rate per pair | `FxRate` |
| Volatility safety margin, rate staleness | **Not built.** One `bufferBp` (max 2 000); no max age, so an old ACTIVE rate keeps selling | `FxRate` |
| `/distribution/restrictions` | **Live but narrower**: hides a hotel or supplier from one agency. No min/max LOS, booking window or blackout. `minStay`, `maxStay`, `releaseDays` exist on the rate plan only | `DistributionRestriction`, `RatePlan` |
| `/distribution/channels` | **Not built**; catalogued as planned ("Markets and channels"). B2B XML/JSON distribution credentials exist (ADR 0075) with no per-channel price or rule overrides | `admin-departments.ts` |
| `Simulator.tsx` | **Live** (read-only, reconciles to an independent recomputation). Shows one markup per night, no layer trace | `rate-certification/Simulator.tsx` |
| `FindingList.tsx` margin squeeze, parity alerts | **Partly.** Finding codes cover zero or very high markup; no margin-floor or channel-parity code | `contracts/rate-certification.ts` |
| `rules/` rule-engine definitions | Not applicable as files: rules are tenant data with approval, not code | ADR 0018 |

## Risks found
1. **Stale FX sells silently** (high): an ACTIVE rate has no expiry, so a forgotten rate keeps pricing bookings.
2. **No margin floor** (medium): a zero-percent rule is only a WARN finding; nothing flags a squeeze from FX plus promotions.
3. **No parity check** (medium): per-agency markup rules can sell one stay at different prices, and nothing measures it.
4. **Documentation drift** (low): the brief says `/commercial/fx`; the live route is `/commercial/fx-rates`.

## Built in this change
Pure, transport-agnostic, BigInt-only code in `@bedbanks/pricing`, 9 new tests (13 pass in the package): `applyMarkupCascade`, `selectCascadeLayers` (most-specific per layer, ties throw), `convertWithMargin` (buffer plus volatility, staleness refusal, currency exponents), `checkMargin`, `checkChannelParity`. Not imported by the API or Admin, so no behaviour changes and nothing is presented as a capability. Design and phased plan: [ADR 0080](adr/0080-commercial-distribution-engine.md).

## Deliberately not built
No migration, route, contract or Admin screen. A schema change needs a reviewed Prisma migration and the ADR 0013 grant decision; a UI before its contract would break invariant 4. The cascade also changes pricing semantics, so it needs the shadow comparison in ADR 0080 P1 first.

## Business decisions (answered 2026-10-21) and what remains
Answers are recorded in ADR 0080. Remaining: confirm the parity reading (both thresholds must be exceeded), the cached-rate fallback policy (conflicts with invariant 5), and the chain-data source name.

Original questions, for the record:
1. Should layers compound (as proposed) or sum their markups against the original net?
2. Parity tolerance and margin floors: values, and per tenant or per channel?
3. Maximum FX rate age and the volatility margin per currency pair.
4. Chain taxonomy: a source for `chainCode` (none exists on `Hotel`).
