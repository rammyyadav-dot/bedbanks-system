# ADR 0075: Admin and Agent workspace boundaries

## Status
Accepted: the boundary rules, the target layout, and the `check:app-boundaries` gate (it runs in `pnpm check:architecture`).
Proposed: the phased migration below (contracts split, feature folders, removal of dead packages). Each phase is its own PR.

## Context
`apps/admin` is the operational control plane: suppliers, contracts, markup rules, FX, rate certification, finance, reconciliation, access and audit. `apps/agent` is the buyer surface: search, recheck, hold, checkout, bookings, wallet and credit. Both are Next.js apps that reach the NestJS API through a same-origin `/api/v1` proxy (ADR 0010, ADR 0055). The API is the only process that holds database credentials, supplier credentials and the commercial engine.

An inspection of the code on 2026-10-20 found:

| Finding | Effect |
| --- | --- |
| **The agent search wire format carries platform commercials.** Every rate in `GET /agent/search` includes `netAmountMinor`, `markupAmountMinor`, supplier-cost `totalAmountMinor`, `supplierId`, `supplierRoomId`, `supplierRateId`, `providerId` and `contractId` (`packages/domain/src/search-offers.cjs` `validateSearchHotels`, `SearchRateOffer`). ADR 0018 added these fields for the shared evaluator. Agent display never reads them (only `apps/agent/services/hotel-service.test.mjs` mentions them). | Any agency user can read the platform's net cost and margin for every rate in browser devtools, and can work out which supplier is behind it. This is the one live commercial leak in the Agent. |
| No import-boundary enforcement. ESLint has no restricted-import rules, and nothing stops an app importing another app or Prisma. | The boundary was held only by reviewer discipline. Nothing currently crosses it. |
| `@bedbanks/contracts` has a single `.` export. `routes` is one object literal holding 21 agent paths next to 173 admin, 70 supply, 19 platform and 15 supplier paths. | The Agent client bundle ships the whole internal API map, so any agency user can read the admin surface (credit approvals, ledger, markups, platform). The API authorizes every call, so this is not a privilege bypass. It is reconnaissance material and a design smell. |
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

Target: the API returns the Agent its **sell price only**. Net cost, markup amount, applied rule IDs, margin, supplier/provider identity and contract IDs are never in an agent contract. Today the search response breaks this (see Context). Phase 2 fixes it. `@bedbanks/pricing` must stay free of rule types, rule precedence and anything tenant-specific. A function that needs a `MarkupRule` belongs in the API.

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
`@bedbanks/contracts` exports `./shared`, `./agent`, `./admin` and `./supplier`. The Agent may import only `./shared` and `./agent`, and the boundary gate enforces that once the split lands. `@bedbanks/types`, `@bedbanks/validation` and `@bedbanks/config` are removed because they are unused, and the float `Money` type goes with them. Zod schemas that the API and a client both need live beside their contract in `@bedbanks/contracts`. A component moves into `@bedbanks/ui` only when a second app needs it.

### 7. Secrets and environment
- Server-only env (`API_INTERNAL_URL`, `AUTH_API_ORIGIN`, cookie names) is read only in modules that `import 'server-only'`, such as `apps/admin/lib/api/server-env.ts`.
- `NEXT_PUBLIC_*` is restricted to `NEXT_PUBLIC_AGENT_API_URL` (Agent, test override). `next.config` `env:` is banned. `tools/public-env-check.ts` already enforces both.
- Supplier credentials are stored only as encrypted values or secret references, in the API (invariant 7). No browser app has a variable that could hold one.

## Migration phases
1. **This change.** Add `check:app-boundaries` to `check:architecture` and record this ADR. No runtime change.
2. **Strip commercials from the agent search projection (P0).** Add a separate agent-facing offer type and projector in the API. It keeps `offerId`/`offerToken`, `total`, tax and fee breakdown, supplements, pay-at-hotel, cancellation and availability, and drops `net*`, `markup*`, supplier-cost `totalAmountMinor`, `supplier*`, `providerId`, `contractId` and `tenantId`. Recheck and hold must resolve those fields server-side from `offerId`/`offerToken` before this lands. The agent validator keeps the `total.amountMinor` check and loses the `sell = total + markup` identity, which stays an API-side invariant. Add a contract test that fails if a forbidden key appears in an agent response.
3. Split `@bedbanks/contracts` into audience subpaths and keep the root `.` export as a re-export during transition. Move the Agent to `./agent` and `./shared`. Then extend the gate to fail if the Agent imports `@bedbanks/contracts` or `./admin`, and confirm by building the Agent and searching `.next/static` for `/admin/` paths.
4. Delete `@bedbanks/types`, `@bedbanks/validation` and `@bedbanks/config` after confirming they have no consumers.
5. Admin `features/` regrouping, one bounded context per PR, with no URL changes.
6. Agent route-per-step (`(workspace)/search`, `checkout/[holdId]`, `bookings/[bookingId]`). This is a UX change and needs its own ADR and e2e coverage.

## Consequences
- An app-to-app import, or a Prisma, NestJS or connector import in a browser app, now fails CI.
- The gate is regex-based on import specifiers. It does not follow re-exports through a shared package, so the `pricing` and `contracts` content rules in decisions 2 and 6 still rely on review until phases 2 and 3 add a response contract test and subpath enforcement.
- Rollback: remove `check:app-boundaries` from `check:architecture` and delete `tools/app-boundary-check.ts`. Nothing at runtime depends on either.
