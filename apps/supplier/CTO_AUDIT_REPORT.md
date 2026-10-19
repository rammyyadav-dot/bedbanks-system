# fBeds Supplier Extranet: CTO Audit, Gap Analysis and Roadmap

**Date:** 2026-10-19 · **Scope:** `apps/supplier` plus the `apps/api` surface it consumes
**Supersedes:** the 2026-09-19 report. That report described a mock-adapter prototype that no longer exists.
**Verified this session:** `type-check`, `lint`, `test` (12/12), `next build`, `check:architecture` all pass.

## 1. Executive summary

The extranet is **secure and honest, but thin**. Authentication, tenant isolation, supplier-organization scoping, permission gating and fail-closed data handling are production-grade. Only four modules are live and all four are read-only: dashboard, hotels and rooms, contracts, bookings. The other 15 or so nav entries render an explicit "unavailable" state.

The platform backend is far ahead of the extranet. `apps/api` has about 115 supply routes (contracts, rate plans, daily rates, availability, calendar import, promotions, cancellation and child policies, approvals), plus a ledger, supplier statements, a dispute queue and connector tables. The supplier-facing API exposes **9 routes** of that.

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
| F1 | High | The extranet exposes 9 of the supplier-relevant capabilities; no rates, availability, restrictions, promotions, statements or onboarding | Open, see roadmap |
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

Every item must follow the constitution: contracts first in `@bedbanks/contracts`, a permission declared on each controller, idempotency on mutations, immutable audit events, tenant-index review for schema changes, and an ADR for architectural choices. Suppliers author **Draft** submissions only. Approval and publication stay with fBeds staff, as the README states.

| Phase | Deliverable | Needs |
|---|---|---|
| P1 (read-only parity) | Extranet reads for rate plans and daily-rate calendar, availability and allotments, restrictions, promotions, cancellation policies | New supplier-scoped controllers over existing services; DB-backed tests |
| P2 | Statements, invoices, payment status, dispute view | Supplier-scoped read over `SupplierStatement`; finance review |
| P3 | Booking responses (confirm/reject with hotel confirmation number) | Idempotent mutation, audit event, ADR |
| P4 | Draft authoring: rates, availability, restrictions via calendar import preview, then submit for review | Existing `calendar/preview` and `import/preview` logic; approval workflow reuse |
| P5 | Onboarding state machine and document upload | Schema migration, storage decision (ADR) |
| P6 | Team management, 2FA, notifications, supplier-visible audit log | Auth work |
| P7 | Connectivity self-service (channel manager) | Connector and credential-reference work; security review |
| Cross-cutting | Readable type sizes (F6), e2e in CI, component tests, i18n | Design and QA |

Phases P1 to P2 are the biggest value for the least risk. They only read data that already exists.

## 6. Delivered in this change

- Removed fabricated mock data and the unused adapter (F4).
- Added error, global-error, not-found and portal loading boundaries (F2). The error boundary shows only the digest, never the message.
- Nav now distinguishes live from unavailable modules, covered by a test that every nav route has a page and that only the four API-backed modules are marked live (F3).
- Accessibility: skip link, focus ring, `aria-current`, table captions, reduced-motion (F5).

## 7. Not done, and why

- **Full 100%**: the remaining capabilities need new API endpoints, migrations and approval workflows. These cannot be verified without Postgres and the API, and they carry financial and security impact that needs review per the constitution.
- **e2e run**: needs the database and API stack.
- **Type-size fix (F6)**: a visual redesign decision.
