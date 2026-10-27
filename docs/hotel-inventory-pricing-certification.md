# Hotel inventory and pricing chain certification

Evidence for: hotel master → room → contract → daily rates → supplements → promotions → markup → Agent search, with stop-sell, allotment and availability tested at every stage. Spec: `apps/api/src/supply/hotel-pricing-chain.spec.ts` (44 tests). No schema, route or runtime behaviour changed; this is test evidence only.

## What was exercised
The spec builds a plan with `buildStaySnapshot` and decides it with `evaluateContractedStay`, the one evaluator Agent search, recheck, hold, Admin readiness and the Sellability Inspector share ([ADR 0030](adr/0030-inventory-and-allotment-semantics.md), [ADR 0067](adr/0067-hotel-contracting-correctness-and-governance.md)). Markup is resolved per night with `markupResolverFor`, exactly as search does. Pure unit tests: no database, clock or network (`now` is injected).

## Worked price (3 nights, NET 30,000 AED minor/night, HOTEL markup 15%)
| Step | Per night | Rule |
| --- | --- | --- |
| Contracted NET rate | 30,000 | daily rate |
| Promotion LONG_STAY 10% | 27,000 | half-up, before supplements |
| Compulsory supplement 5,000 | 32,000 | never discounted |
| Markup 15% | +4,800 → **36,800** | on the net after promotion and supplement |
| Stay, 1 room | **110,400** (net 96,000 + markup 14,400) | `net + markup = total` asserted |
| Stay, 2 rooms | 220,800 | every component multiplies by rooms |

Markup rounding is exact: 33,335 × 15% = 5,000.25 → 5,000. Totals are `bigint`; no floating point.

## Results by stage
| Stage | Certified behaviour |
| --- | --- |
| Hotel master / room / board / supplier | Unpublished hotel, inactive room, suspended supplier, unmapped supplier hotel: unsellable, no price |
| Contract | Not ACTIVE, stay outside validity, currency mismatch: unsellable |
| Rate plan | Not ACTIVE, min/max stay: enforced |
| Daily rates | Missing night, zero amount, unverified basis: never priced as free, `DAILY_RATE_MISSING_OR_INVALID` / `RATE_AMOUNT_BASIS_UNVERIFIED` |
| Supplements | Added after promotion, before markup; foreign-currency supplement blocks the sale |
| Promotions | Applies when qualified; non-qualifying leaves rate untouched; saving reported |
| Markup | HOTEL > SUPPLIER > TENANT_DEFAULT; ended rule falls back; mid-stay rule prices only its nights; NET with no rule is never sold or shown at net; SELL ignores markup |
| Stop-sell | Any single stay night closes the whole stay with `totalMinor/netMinor/markupMinor = null`; beats plentiful stock and promotions; departure-date and out-of-stay stop-sells do not block; lifting restores the same price |
| Allotment | remaining = allotment − sold − held; stay reports tightest night; exactly-enough rooms sells, one more does not; held counts as taken; one exhausted night sells out the stay; over-sold row is `NO_INVENTORY`; pooled plans draw from the pool day (`POOL_EXHAUSTED`) |
| Availability | Missing row or pool day is `AVAILABILITY_MISSING` (never zero, never open); CTA first night only; CTD from the departure-date row only; night min-stay through the stay; release deadline instant not sellable (hotel-local, Asia/Dubai); stale supplier stock `INVENTORY_STALE`; FREE_SALE sells uncounted, ON_REQUEST priced but `on_request` and not eligible, CLOSED never sells |
| Read-only | Two evaluations return equal results and the input rows are unchanged |

## Verification run
- `jest src/supply src/inventory`: 42 suites, 720 tests, all pass.
- `tsc --noEmit` (api): clean. `eslint` on the new spec: clean.
- `pnpm check:no-float`, `pnpm check:no-silent-fallback`: pass.

## Not covered (so not certified here)
- HTTP and database behaviour (tenant isolation, RLS, hold/confirm counter moves): existing `inventory-*.e2e-spec.ts` and `dubai-agent-search*.e2e-spec.ts` need PostgreSQL and were not run in this session.
- Admin screens and the browser verifiers in `tools/admin-ops-verify`.
- FX conversion, child/extra-guest lines, deals engine, event supplements, buyer markets and tiered (agency/market) markup beyond what is cited above; other specs cover them individually.
- Production data and supplier connector inventory.

## Documentation drift noticed
`docs/rate-certification.md` (Applicability table) still says promotions and event supplements are not modelled, and that the pricing is "one contracted rate and one markup rule per night". The code now has plan promotions ([ADR 0058](adr/0058-promotions-and-derived-rates-pricing-policy.md)), hotel deals and event supplements ([ADR 0089](adr/0089-hotel-deals-and-promotions.md)). That table was left untouched; it should be reconciled by whoever owns that record.
