# ADR 0075: Admin and Agent workspace boundaries

## Status
Accepted: the boundary rules, the target layout, the `check:app-boundaries` gate (it runs in `pnpm check:architecture`) and the buyer-only agent search projection (phase 2).
Accepted and done: phase 3 (the Agent's own contracts entry).
Proposed: the remaining phases (feature folders, removal of dead packages, audience entries for Admin and Supplier). Each phase is its own PR.

## Context
`apps/admin` is the operational control plane: suppliers, contracts, markup rules, FX, rate certification, finance, reconciliation, access and audit. `apps/agent` is the buyer surface: search, recheck, hold, checkout, bookings, wallet and credit. Both are Next.js apps that reach the NestJS API through a same-origin `/api/v1` proxy (ADR 0010, ADR 0055). The API is the only process that holds database credentials, supplier credentials and the commercial engine.

An inspection of the code on 2026-10-20 found:

| Finding | Effect |
| --- | --- |
| **The agent search wire format carries platform commercials.** Every rate in `POST /agent/search` included `netAmountMinor`, `markupAmountMinor`, supplier-cost `totalAmountMinor`, `supplierId`, `supplierRoomId`, `supplierRateId`, `providerId` and `contractId` (`packages/domain/src/search-offers.cjs` `validateSearchHotels`, `SearchRateOffer`). ADR 0018 added these fields for the shared evaluator. Agent display never reads them (only `apps/agent/services/hotel-service.test.mjs` mentions them). | Any agency user can read the platform's net cost and margin for every rate in browser devtools, and can work out which supplier is behind it. This was the one live commercial leak in the Agent. Fixed by phase 2. |
| No import-boundary enforcement. ESLint has no restricted-import rules, and nothing stops an app importing another app or Prisma. | The boundary was held only by reviewer discipline. Nothing currently crosses it. |
| `@bedbanks/contracts` has a single `.` export. `routes` is one object literal holding 21 agent paths next to 173 admin, 70 supply, 19 platform and 15 supplier paths. | **Corrected by measurement in phase 3.** The route map did *not* reach the browser: webpack drops the unused `routes` properties, and the Agent's `.next/static` held 0 non-agent API paths. What did ship was the Admin console's permission keys and department module table (57 permission keys such as `booking.bulk.assign` and `audit.export`, plus paths like `/commercial/markups`). `admin-departments.ts` builds that table with top-level function calls, which the bundler kept because the package declared no `sideEffects`. The API authorizes every call, so this was never a privilege bypass, but it showed agencies the Admin surface. Fixed by phase 3: both counts are now 0. |
| The commercial markup engine is server-only (`apps/api/src/commercial/commercial-markup.service.ts`). `@bedbanks/pricing` holds only basis-point arithmetic (`markupMinor`, `applyPercentMarkup`). The Agent uses it for its own display-only client markup (ADR 0065). | Correct today. The risk is that rule resolution gets "shared" into `@bedbanks/pricing` later and is bundled into the Agent. |
| `@bedbanks/types` declares `Money { amount: number }`. `@bedbanks/types`, `@bedbanks/validation` and `@bedbanks/config` are imported by no workspace. | A float money type sits one import away, against invariant 3, and three packages advertise capabilities nobody uses, against invariant 10. |
| `@bedbanks/ui` exports one `Button` and is used only by the Agent. Admin keeps its own shadcn components. | No real shared design system yet. |
| There is no `packages/database`. Prisma lives in `apps/api/prisma`. | Correct. See decision 3. |
| `docs/MONOREPO.md` still lists the API and Admin as "to be created". | Stale. This ADR supersedes its layout section. |

## Decision

### 1. Dependency direction
```text
apps/admin ─┐                      ┌─► @bedbanks/contracts   (routes, DTOs, envelopes, error codes)
apps/agent ─┼─► (HTTP /api/v1) ─┐  ├─► @bedbanks/domain      (provider-neutral types, pure validators)
apps/supplier┘                  │  ├─► @bedbanks/money       (integer minor units, ISO-4217)
apps/website                    │  ├─► @bedbanks/pricing     (pure basis-point arithmetic only)
                                │  └─► @bedbanks/ui          (presentational components, no data fetching)
                                ▼
                            apps/api ─► all of the above + Prisma + @bedbanks/connectors-*
```
- Apps never import another app. Shared packages never import apps.
- Browser apps (admin, agent, supplier, website) never import or declare `@prisma/*`, `prisma`, `@nestjs/*`, `@bedbanks/connectors-*` or `@bedbanks/api`.
- Integration tests (an app's `test/` directory or `*.integration.*`) may import another app to exercise the seam between them. Today that is `apps/api/test/admin-auth.integration.ts`.

`tools/app-boundary-check.ts` enforces all three rules.

### 2. Where commercial logic lives
| Logic | Home | Reachable from the Agent bundle? |
| --- | --- | --- |
| Markup rule storage, precedence and resolution, supplier net cost, margin, FX source rates | `apps/api/src/commercial`, `apps/api/src/agent/agent-search.service.ts` | Never |
| Basis-point and minor-unit arithmetic | `@bedbanks/pricing`, `@bedbanks/money` | Yes. Pure functions with no rules or data |
| Agent display-only client markup | `apps/agent/lib/client-markup.ts` (ADR 0065) | Yes. Never sent to the API |
| Admin rule-editing UI and previews | `apps/admin/features/commercial` | No (separate app) |

Target: the API returns the Agent its **sell price only**. Net cost, markup amount, applied rule IDs, margin, supplier/provider identity and contract IDs are never in an agent contract. Phase 2 enforces this for search. `@bedbanks/pricing` must stay free of rule types, rule precedence and anything tenant-specific. A function that needs a `MarkupRule` belongs in the API.

### 3. No `packages/database`
Prisma, the schema, migrations, runtime-role provisioning and the ledger single writer stay in `apps/api`. A shared database package would make `import { PrismaClient }` resolvable from every workspace and would break ADR 0008, ADR 0031, ADR 0032 and ADR 0062. If a second server process (a worker) needs the database, it becomes `apps/worker` and shares code through an API-internal library. Browser apps still never get it.

### 4. Target `apps/admin` layout
Routes stay thin. Data access is server-only. Feature code is grouped by bounded context, not by file type.
```text
apps/admin/
├── app/
│   ├── login/
│   └── (dashboard)/                    # route groups only: page.tsx, layout.tsx, loading.tsx, error.tsx
│       ├── dashboard/
│       ├── supply/                     # suppliers, connectors, mappings, hotels, rooms, inventory, board-basis
│       ├── contracting/                # contracts, rates/plans, rate-certification, markets, sellability
│       ├── commercial/                 # markups, fx-rates, pricing, distribution (restrictions, search-monitor)
│       ├── bookings/                   # bookings, queue, holds, cancellations, exceptions, service/cases
│       ├── finance/                    # wallets, ledger, payables, receivables, refunds, credit-notes, funding, reconciliation
│       ├── clients/                    # agencies, credit and suspension approvals
│       ├── governance/                 # access (roles, permissions, assignments), access-review, audit, compliance
│       └── platform/                   # tenants, settings, reliability, notifications, reports
├── features/                           # one folder per bounded context, mirroring the route groups
│   └── <context>/
│       ├── components/                 # client and server components for this context only
│       ├── data.server.ts              # 'server-only'; calls the API via lib/api/server-request.ts
│       ├── actions.ts                  # 'use server' mutations; idempotency key and permission check per call
│       └── <name>-ui.ts (+ .test.ts)   # pure view-model helpers (today's lib/*-ui.ts)
├── components/                         # app-wide only: layout, tables, dialogs, forms, status
├── lib/
│   ├── api/                            # server-env, server-request, client, errors ('server-only' where secrets are read)
│   └── auth/                           # session, capability-policy, route-access (UX only; the API decides)
└── proxy.ts
```
Migration is mechanical: `components/<ctx>`, `lib/data/<ctx>.ts` and `lib/<ctx>-ui.ts` move into `features/<ctx>/`. Moving a route folder changes its URL, so route-group renames such as `(dashboard)/supply/...` need redirects and are optional.

### 5. Target `apps/agent` layout
The Agent currently routes almost everything through one client component (`components/agent-portal.tsx`). The target gives each workflow step a real route, so it has its own error boundary, deep link and server data load.
```text
apps/agent/
├── app/
│   ├── (public)/                       # about, contact, news, support, access, login (unauthenticated)
│   └── (workspace)/                    # authenticated agency workspace; layout resolves session + agency context
│       ├── search/                     # search form, results, filters
│       ├── hotels/[hotelId]/           # room/rate options, recheck
│       ├── checkout/[holdId]/          # guest details, review, confirm (idempotency key per attempt)
│       ├── bookings/                   # list, [bookingId] detail, cancellation quote, documents
│       ├── finance/                    # wallet, credit line, funding receipts
│       └── account/                    # profile, client-markup preference, white-label settings
├── features/
│   ├── search/                         # components + search-attempt, search-page, result-window, filters
│   ├── booking/                        # checkout, recheck-attempt, guest-validation, booking-attention
│   ├── finance/                        # agency-credit, wallet, funding
│   ├── branding/                       # white-label theme tokens resolved from the agency context (API-provided)
│   └── account/
├── components/                         # shell, brand-logo, kpi
├── lib/                                # api-client (agent contracts only), format, session-events
└── proxy.ts
```
White-label branding is data the API returns for the session's agency, applied as CSS tokens. It is never a build-time variable and never chosen from a query string (invariant 1).

### 6. Shared packages, target state
```text
packages/
├── contracts/                          # split by audience; each subpath is independently importable
│   └── src/
│       ├── shared/                     # envelope, error codes, auth, pagination
│       ├── agent/                      # agent-search, agent-checkout, funding views, routes.agent
│       ├── admin/                      # operations, commercial, finance-reconciliation, hotel-*, routes.admin, routes.supply, routes.platform
│       └── supplier/                   # supplier-extranet, routes.supplier
├── domain/                             # provider-neutral types and pure validators (search offers, destinations)
├── money/                              # Money, minor units, ledger arithmetic
├── pricing/                            # pure arithmetic only; no rule types
├── ui/                                 # design tokens + presentational primitives used by 2+ apps
└── connectors/*                        # server-only; API is the only consumer
```
`@bedbanks/contracts` exports `.` (everything, for the API, Admin and Supplier) and `./agent` (auth and agent routes, envelope, checkout, smart search and agent funding types). The package is `sideEffects: false`. The Agent may import only `./agent`, and `check:app-boundaries` enforces it (`agent-contracts`). `./admin` and `./supplier` entries are added only if a measured bundle shows another audience's code leaking. `@bedbanks/types`, `@bedbanks/validation` and `@bedbanks/config` are removed because they are unused, and the float `Money` type goes with them. Zod schemas that the API and a client both need live beside their contract in `@bedbanks/contracts`. A component moves into `@bedbanks/ui` only when a second app needs it.

### 7. Secrets and environment
- Server-only env (`API_INTERNAL_URL`, `AUTH_API_ORIGIN`, cookie names) is read only in modules that `import 'server-only'`, such as `apps/admin/lib/api/server-env.ts`.
- `NEXT_PUBLIC_*` is restricted to `NEXT_PUBLIC_AGENT_API_URL` (Agent, test override). `next.config` `env:` is banned. `tools/public-env-check.ts` already enforces both.
- Supplier credentials are stored only as encrypted values or secret references, in the API (invariant 7). No browser app has a variable that could hold one.

## Migration phases
1. **This change.** Add `check:app-boundaries` to `check:architecture` and record this ADR. No runtime change.
2. **Done: strip commercials from the agent search projection (P0).** `POST /agent/search` now returns `AgentHotelOffer`/`AgentRateOffer` (`packages/domain`), built by `projectAgentHotels` in `AgentController.search`.
   - Kept: `offerId`, hotel and room type, `ratePlanId` (a canonical platform id that the UI and tests use to tell plans apart), plan and board names, occupancy, availability, cancellation, `total`, tax and fee, `sellAmountMinor`, payment type, priceIncludes, pay-at-hotel, promotion and supplements.
   - Dropped: `netAmountMinor`, `markupAmountMinor`, supplier-cost `totalAmountMinor`, `supplierId`, `supplierHotelId`, `supplierRoomId`, `supplierRateId`, `providerId`, `contractId`, `tenantId`, `canonicalHotelId`, `canonicalRoomTypeId`, `offerToken` and `source`.
   - Recheck and hold already resolve the stored offer server-side by `offerId`, so no request body changed. The search cache keeps the full internal offer; projection happens only at the controller.
   - `validateSearchHotels(..., audience: 'agent')` is the browser validator. It keeps `total.amountMinor === sellAmountMinor` and `tax + fee <= sell`. The `total = net + tax + fee` and `sell = total + markup` identities are API-side only.
   - The Agent's recheck call now sends the session tenant rather than a `tenantId` copied from the offer.
   - Tests: `agent-search.contract.spec.ts` fails if any dropped key reaches the response. The HTTP e2e suites (commercial markup, Dubai search, benchmark journey) assert the sell price and the absence of supply fields, and derive markup as sell minus the fixture's known net.
   - Deploy order: the Agent first, then the API. The new Agent accepts both shapes. The old Agent rejects the new shape as `mapping_unavailable`.
3. **Done: the Agent's own contracts entry.**
   - `packages/contracts/src/agent.ts` is exported as `@bedbanks/contracts/agent`. Auth and agent routes live in `agent-routes.ts`, and `routes.ts` composes them, so the root `routes` object is unchanged for the API, Admin and Supplier. `tools/contract-check.ts` reads both files.
   - The package declares `sideEffects: false`. No contract module runs code at load time.
   - All eight Agent imports use `@bedbanks/contracts/agent`, and the boundary check fails on any other contracts import in the Agent.
   - Measured in the Agent's `.next/static`: Admin permission keys went from 57 to 0, the Admin module table from present to absent, non-agent API paths stayed at 0, and agent paths stayed at 15.
4. Delete `@bedbanks/types`, `@bedbanks/validation` and `@bedbanks/config` after confirming they have no consumers.
5. Admin `features/` regrouping, one bounded context per PR, with no URL changes.
6. Agent route-per-step (`(workspace)/search`, `checkout/[holdId]`, `bookings/[bookingId]`). This is a UX change and needs its own ADR and e2e coverage.

## Consequences
- An app-to-app import, or a Prisma, NestJS or connector import in a browser app, now fails CI.
- The gate is regex-based on import specifiers. It does not follow re-exports through a shared package, so the `pricing` and `contracts` content rules in decisions 2 and 6 still rely on review for anything other than the agent search response (phase 2 contract test) and the Agent's contracts entry (phase 3 gate rule).
- Rollback: remove `check:app-boundaries` from `check:architecture` and delete `tools/app-boundary-check.ts`. Nothing at runtime depends on either.
