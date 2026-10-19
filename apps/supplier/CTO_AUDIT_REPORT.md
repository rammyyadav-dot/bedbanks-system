# fBeds Supplier Extranet: CTO Audit, Gap Analysis and Roadmap

**Date:** 2026-10-19 · **Scope:** `apps/supplier` plus the `apps/api` surface it consumes
**Supersedes:** the 2026-09-19 report (a mock-adapter prototype that no longer exists). **Builds on** `docs/supplier-extranet-cto-audit-2026-10-12.md` and ADR 0061, which hold the accepted roadmap. Where this report differs, those documents win.
**Verified this session:** `type-check`, `lint`, `test` (12/12), `next build`, `check:architecture` all pass.

## 1. Executive summary

The extranet is **secure and honest, but thin**. Authentication, tenant isolation, supplier-organization scoping, permission gating and fail-closed data handling are production-grade. Only four modules are live and all four are read-only: dashboard, hotels and rooms, contracts, bookings. The other 15 or so nav entries render an explicit "unavailable" state.

The platform backend is far ahead of the extranet, which is already known to the team (see the 2026-10-12 audit). `apps/api` has about 115 supply routes (contracts, rate plans, daily rates, availability, calendar import, promotions, cancellation and child policies, approvals), plus a ledger, supplier statements, a dispute queue and connector tables. The supplier-facing API exposes **9 routes** of that.

**Honest completion estimate: about 20% of a global-bedbank supplier extranet** (5 of about 25 capability areas live, all read-only). The main gap is not frontend polish. It is a missing supplier-scoped API layer over capabilities that already exist, which means sequenced backend work.

## 2. What is strong (keep)

| Area | Evidence |
|---|---|
| Tenant identity from server only | `lib/supplier-api.ts` takes the tenant from `/auth/me` memberships and rejects ambiguous ones (403). The browser never selects a tenant. |
| Supplier scoping is server-verified | The `x-fbeds-supplier-id` header is only a selector among the caller's ACTIVE memberships (`SupplierOrganizationGuard`). |
| Session handling | `session-cookie.ts` validates HttpOnly, Secure, SameSite and a 64-hex value, and fails on ambiguity. |
| Fail-closed data | The `booking()` parser returns 502 on an unrecognised shape. It never fills a gap with a zero or default. |
| Permission-gated reads | Every live page checks `supplier.extranet.*` permissions. |
| Money | Minor units plus ISO currency (`@bedbanks/money`). |
| Hardening | CSP `frame-ancestors`, HSTS, nosniff, Permissions-Policy, and a runtime API proxy that resolves per request. |
| Honesty | Unavailable modules say so and mutate nothing. This matches constitution invariant 10. |

## 3. Findings

| # | Sev | Finding | Status |
|---|---|---|---|
| F1 | High | The extranet exposes 9 routes; no booking answers, change sets, statements or onboarding | Open, see roadmap |
| F2 | Med | No `error.tsx`, `global-error.tsx`, `not-found.tsx` or portal `loading.tsx`, so an unhandled render error showed the framework default | **Fixed** |
| F3 | Med | The nav presented about 15 unavailable modules as if live | **Fixed**: only `live` routes are unmarked; the rest show "Not available" |
| F4 | Med | Dead mock code remained in the repo (`adapter.ts`, `mock-data.ts` with fabricated AED/OMR figures, `module-data.ts`) | **Fixed**: deleted, along with the test that asserted the adapter threw |
| F5 | Med | A11y: no skip link, no `:focus-visible` ring, no `aria-current`, no table captions, no reduced-motion | **Fixed** |
| F6 | Med | Body text is 8–9px across `globals.css`, below readable and WCAG-friendly sizes | Open: needs a design pass |
| F7 | Med | Test coverage is unit-only (12 tests). No component or page tests; the e2e spec `04-supplier-extranet` exists but was not run here (needs Postgres and the API) | Open |
| F8 | Low | Hotel/room parsers in `supplier-api.ts` are duplicated (`getHotel` and `listHotels` map the same shape) | Open |
| F9 | Low | Login and org-select actions have no rate-limit or lockout feedback at the portal; this relies on the API | Verify at API |
| F10 | Low | The Dockerfile and engines say Node 24.x; this session ran Node 22 (warning only) | Info |

## 4. Benchmark against global bedbank supplier extranets

Reference set: Hotelbeds, WebBeds, RateHawk, TBO and the Expedia/Booking.com partner extranets. Capabilities are from general industry knowledge of these products, not a feature-by-feature audit of each.

| Capability | Industry baseline | fBeds extranet | Backend exists? |
|---|---|---|---|
| SSO/2FA, roles | Standard | Session auth; no 2FA or SSO | Partial |
| Supplier onboarding and KYC | Guided, with document upload | Unavailable | Supplier model, no workflow |
| Property and room content | Self-serve, with approval | Read-only; private room note only | Yes (hotel-setup) |
| Contracts and rate plans | Self-serve | Read-only list | Yes (full lifecycle, approvals) |
| Rate and availability calendar, bulk edit | Core feature | Unavailable | Yes (`daily-rates`, `availability/bulk`, `calendar/*`) |
| Restrictions (MLOS, CTA/CTD, release, stop-sale) | Core feature | Unavailable | Yes (`DistributionRestriction`) |
| Allotments and release periods | Core feature | Unavailable | Yes (`InventoryPool`) |
| Promotions and early-bird | Common | Unavailable | Yes (`RatePlanPromotion`) |
| Cancellation, child and tax policy | Core feature | Visible only as plan flags | Yes (policy routes) |
| Booking inbox: confirm/reject, hotel confirmation no. | Core feature | Read-only list and detail | Partial (booking-ops) |
| Vouchers and rooming lists | Common | Unavailable | Partial |
| Statements, invoices, payment status | Core feature | Unavailable | Yes (`SupplierStatement`, reconciliation, disputes) |
| Reports and analytics | Common | Unavailable | Partial |
| Channel-manager / API connectivity | Common | Unavailable | Yes (`ConnectorDefinition`, credential refs) |
| Notifications and alerts | Core feature | None | Unknown |
| Audit trail visible to supplier | Common | None | Audit events exist |
| Team and user management | Standard | Unavailable | Memberships exist |
| Multi-language / currency display | Common | English only | n/a |

## 5. Roadmap to completion

The accepted order is ADR 0061 and the 2026-10-12 audit. Slices 1 (contracts) and 2 (bookings read) are done. Remaining slices, each needing an accepted ADR amendment before code:

| Slice | Deliverable | State |
|---|---|---|
| 3 | Supplier booking answers: confirm, on-request, reject, idempotent and audited | **Amendment 2 drafted in ADR 0061, awaiting acceptance** |
| 4 | Supplier change sets (stop-sale, availability, rate lines) into admin review, applied through existing supply services; needs pagination first | ADR needed |
| 5 | Calendar UI and CSV upload with a row-level error report | After 4 |
| 6 | Vouchers, rooming list, statements and invoices (read, integer minor units) | After finance model; fix the `number` money wire type (M8) first |
| 7 | Membership management, invitations, MFA, API credentials | Audit event design |
| 8 | Onboarding and content submission | Reuse ADR 0025/0027 |
| 9 | Channel-manager connectivity on the ADR 0060 connector kit | After 4 |

Direct supplier reads of rate amounts are deliberately **not** scheduled. ADR 0061 returns no amounts, and suppliers never write commercial data directly (decision 3). Rates reach suppliers only through slices 4 and 6.

Cross-cutting: readable type sizes (F6), browser tests in CI (F7), parser migration to shared contract types (F8).

## 6. Delivered in this change

- Removed fabricated mock data and the unused adapter (F4).
- Added error, global-error, not-found and portal loading boundaries (F2). The error boundary shows only the digest, never the message.
- Nav now distinguishes live from unavailable modules, covered by a test that every nav route has a page and that only the four API-backed modules are marked live (F3).
- Accessibility: skip link, focus ring, `aria-current`, table captions, reduced-motion (F5).

## 7. Not done, and why

- **Full 100%**: each remaining slice needs an accepted ADR amendment, migrations, and database-backed tests. No Postgres server was run in this session.
- **e2e run**: needs the database and API stack.
- **Type-size fix (F6)**: a visual redesign decision.
