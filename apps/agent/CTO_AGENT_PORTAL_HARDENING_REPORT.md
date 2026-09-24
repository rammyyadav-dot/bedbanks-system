# fBeds Agent Portal — Canonical Search Offer Contract

**Base:** `main` at `6a0a27487468654e04f171f83ff425d9d158eb39` (PR #72 merged).  
**Branch:** `feat/agent-canonical-search-offers`  
**Release decision:** Agent search contract can be reviewed; booking remains disabled.

## Capability register

| Capability | Classification | Evidence / next gate |
|---|---|---|
| Session authentication | REAL-NOW | Existing cookie-based login/context/logout retained. |
| Tenant selection | REAL-NOW | Existing membership guard and RBAC remain on search; tenant header requests context only. Existing cross-tenant and suspended-tenant guard tests retained. |
| Canonical search contract | REAL-NOW | Version 1 nested hotel → room → rate shape in `@bedbanks/domain`; supplier/API and API/browser boundaries use the same runtime validator. Valid mapped adapter offers can render live without frontend joins. |
| Live supplier inventory | BLOCKED-PENDING-SUPPLIER | The only registered adapter is unconfigured. It returns `provider_unavailable` and no offers. A real adapter must supply independent IDs and authoritative prices. |
| Demo inventory | CORRECTLY-EMPTY-NOW | Explicit nonproduction switch only, separate sample type and display. Never used on production API failure. |
| Rate selection | REAL-NOW | Valid, unexpired offers can be selected with their room, supplier reference/token, search context, board, policy and total retained in memory; no recheck or booking transition is enabled. |
| Rate recheck | BLOCKED-PENDING-SUPPLIER | Route remains unavailable; requires real offer-token lookup and authoritative changed/expired/unavailable states. |
| Finance credit decision | BLOCKED-PENDING-BACKEND | Summary read path retained; backend booking eligibility decision is not implemented. |
| Prebook, booking, voucher and booking history | BLOCKED-PENDING-CERTIFICATION | API prebook/booking paths remain unavailable, no supplier call or booking persistence is attempted. |

## Contract and rejection rules

`SearchHotelOffer.rooms[].rates[]` carries hotel, room, rate plan, board basis, supplier hotel/room/rate IDs, optional opaque offer token, expiration, occupancy, availability, cancellation terms and `Money { amountMinor, currency }`. The validator checks IDs and parent references, distinct offers, exact request occupancy/currency, safe integer minor units, valid dates and unexpired offers. It strips unknown fields and rejects an entire malformed supplier response as `mapping_unavailable`, exposing no supplier credentials. It does not derive room, board, policy or price from display strings. The Agent validates the version and echoed search context before rendering. Its money formatter changes only presentation, using integer minor units.

The API distinguishes `available`, `no_availability`, `provider_unavailable` and `mapping_unavailable`. Authentication and access errors remain 401/403 at the HTTP boundary. The form submits visible destination, dates, room count, adult count and child ages; nationality IN and currency AED are displayed as fixed parameters. The demo dataset remains separate from live offers.

## Verification and migration impact

- Local focused tests: `node --test packages/domain/src/search-offers.test.cjs apps/agent/services/hotel-service.test.mjs` — **16 passed**.
- API contract and tenant guard tests must run in full-repository CI. Full pnpm validation and build are pending CI on this branch.
- No Prisma schema or migration changes. No database was modified. The existing migration governance and empty PostgreSQL CI certification remain mandatory for release.

## Remaining work

Connect a real supplier adapter that emits canonical IDs without guessing; implement authenticated rate recheck using its opaque token and exact search context; add a backend-authoritative finance decision; certify transactional persistence/idempotency and confirmation/voucher delivery. The current PR does not activate any of these capabilities.
