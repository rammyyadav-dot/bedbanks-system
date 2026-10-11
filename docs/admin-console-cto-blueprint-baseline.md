# Admin console CTO blueprint: baseline audit and requirement matrix

Baseline: branch `claude/awesome-shannon-ds37g8`, SHA `4e02e6e7fb90c1b0e826a91c9841db21b6e0de59` (merge of PR #300, tenant control center), 2026-10-11.
Method: static inspection of `apps/admin`, `packages/contracts` and the existing conformance records. **No tests, builds, browser runs or database checks were executed for this document**; "Built" below repeats what the cited repo docs claim and has not been re-verified at this SHA.

## Finding 1: the blueprint's premise is stale

The blueprint was written from a screenshot showing "UI only — mock data" and "Backend authorization enforced later". That is not the code at this SHA:

- `apps/admin/lib/admin-mvp-guards.test.ts` asserts the sidebar and pages must not contain "mock data" or "enforced later".
- `apps/admin/lib/types/admin.ts` states its types come from API contracts, not mocks.
- The Hotels directory, hotel profile, Quick Update, readiness and audit already use authorized API services (`docs/admin-hotel-mission-conformance.md`).
- Navigation is derived from `packages/contracts/src/admin-departments.ts`. Only `live` modules render, with a `requires` permission hint. The API remains the authorizer.

The screenshot may be another product or a stale build (the existing conformance record notes a similar mismatch with UAEWB). Do not treat it as evidence about this repo.

## Finding 2: requirement matrix (blueprint section vs repo)

Legend: Implemented / Partial / Missing / Blocked. Source claims are from `docs/admin-hotel-mission-conformance.md`, `docs/p04-postmerge-inventory-certification.md` and `docs/tenant-control-gap-matrix.md`, not re-run here.

| Blueprint requirement | Status | Notes |
|---|---|---|
| Department-grouped navigation | Partial | Exists, but groups differ from the blueprint's nine names. `nav-config.ts` hardcodes a "Business" section (Tenants, Agencies, Suppliers, Business users, Approvals) ahead of the contract-derived groups, and the contract lists Tenants/Users under Platform Administration as `planned`. Two sources of truth for one menu. |
| Permission-aware menus, secure direct routes | Partial | Menu hiding is a UX hint only. Direct-route enforcement is by the API (per CLAUDE.md invariant 2). A per-route server check in `proxy.ts` was not audited here. |
| Breadcrumbs | Implemented (unverified) | `components/layout/Breadcrumbs.tsx` and `flatNav`. |
| Hotels KPI strip | Partial | `HotelsSummary` shows total, ready/partial/blocked, mapping, rate and availability gaps, expiring contracts. Blueprint also asks for inactive/onboarding counts and stale-feed counts. Summary is capped by a scan limit and says so. |
| Hotels search, filters, server pagination | Implemented | Name, canonical id, external ids; URL-persisted filters. Source-type and tenant-scope filters are not evident. |
| Saved views on Hotels | Partial | Personal filter presets stored in this browser only (`lib/hotel-views.ts`, `HotelSavedViews.tsx`). Not shared across devices or people, no default view, no column memory. Server-side views (as Bookings has) still need a contract and API route. |
| Hotels bulk tools (assign owner, export, recertify) | Missing | No bulk action on the hotel directory found. Export of authorized data needs its own permission and audit design. |
| Configurable columns on Hotels | Missing | Column picker exists for Bookings only. |
| Hotel Profile tabs (Overview, Rooms, Contracts, Rate Plans, Quick Update, Rate Calendar, Inventory, Distribution, Bookings, Audit) | Implemented | Panels present under `components/hotels/panels`, plus Setup, Amenities, Images, Policies, Mapping. |
| Lifecycle separate from sellability | Implemented | Publication vs transaction enablement; sellability derived by the evaluator, not a boolean. |
| Activation-readiness gate with second approver | Implemented | 12 requirements, second approver (ADR 0022). |
| Onboarding wizard (8 steps) | Partial | Capabilities exist as tabs, not as a guided workflow with step state. |
| Quick Update (rates, inventory, stop sale, restrictions) | Implemented | Preview, atomic apply, stale-preview refusal, idempotency, audit, limits 5 plans / 500 plan-nights. Closed-to-departure is covered by inventory semantics. |
| Quick Update source-authority rules for channel-manager data | Blocked | No live supplier/channel manager; rate-source ownership only meaningful once a connector writes rates. |
| Pooled inventory Sold + Held <= Capacity under concurrency | Implemented (unverified here) | ADR 0030, pool tests claimed. Needs a re-run against Postgres. |
| Tenant lifecycle (verification, credit, suspension enforced by API) | Partial | Tenant control center merged (PR #300); see `docs/tenant-control-gap-matrix.md`. Markets, credit terms, sales ownership not confirmed. |
| Supplier/contract rights, amendment history | Partial | Contracts exist; market restrictions and amendment history not confirmed. Market/nationality enforcement is blocked on a market policy decision. |
| Pricing: net / margin / sell separation, FX | Partial | Integer minor units, per-night rounding, markup rules built. Currency conversion is AED-only by ADR 0029. Promotions not built. |
| Agent Search Monitor with no-result reasons | Missing | Listed `planned` ("Search monitor"). Sellability blockers by date/entity exist per hotel, but no cross-search monitor. |
| Booking ops queues, state machine, idempotency | Implemented | `/bookings/queue`, holds, cancellations, reconciliation, connectors. |
| Finance: receivables, ledger, wallets, funding | Implemented; Payables, Refunds, Credit notes Missing | Both are `planned` in the contract. |
| Command Center dashboard (sales, blocked, action, revenue loss) | Partial | `/dashboard` and `/exceptions` exist. Search-to-book funnel and supplier feed health depend on data that does not exist without live suppliers. |
| Strict runtime role, RLS, cross-tenant negative tests | Implemented (unverified here) | ADR 0003, 0008, `docs/strict-runtime-db-role.md`. Production-clone compatibility is BLOCKED per `docs/p04-postmerge-inventory-certification.md`. |
| Persistent database migration | Blocked | Needs the ADR 0013 human decision. |

## Finding 3: real gaps worth building, in order

P0 (small, contained, no schema change):
1. **Done in the follow-up commit:** single source of truth for navigation: move Tenants, Users and the "Business" grouping into `admin-departments.ts` and delete the hardcoded section in `nav-config.ts`. Today `planned: Tenants/Users` and a live Tenants menu entry contradict each other.
2. Hotels saved views and configurable columns, reusing the Bookings pattern. Server-side persistence needs a per-user view store and an API route in `@bedbanks/contracts` first (invariant 4); URL-only views would be a lower-risk first step.
3. Hotels summary: add inactive/onboarding counts to the contract and API, removing the scan cap or paginating the aggregate.

P1:
4. Guided onboarding checklist view on the hotel profile that reuses the existing readiness evaluator (no new evaluator).
5. Agent Search Monitor: persist no-result reason codes from the existing sellability blockers. Needs a design and ADR.
6. Hotels bulk actions: owner assignment and certified-recheck request, each audited and idempotent. Export needs a permission and an ADR.
7. Finance: payables, refunds, credit notes.

P2: reporting and commercial intelligence, promotions, market policy, channel-manager source authority. All depend on decisions or data that do not exist yet.

## What this change does not claim

No code was changed. No test, build, browser screenshot, CI result or restricted-role/cross-tenant certification was produced for this task, so deliverables 5 to 8 of the mission are not met. Before any of the items above ship, run `pnpm check:architecture`, `pnpm type-check`, `pnpm lint`, `pnpm test`, the strict-role e2e suite and the browser harness at the delivered commit, per CLAUDE.md.

## Follow-up: navigation single source of truth

`business` department (Tenants, live) added to `admin-departments.ts` with a leading "Business" sidebar group; the hardcoded section in `nav-config.ts` is removed and the planned "Tenants" placeholder dropped. Side effect: the old hardcoded entries "Business users" and "Approvals" no longer appear under Business; their routes (`/access-review`, `/reconciliation`) remain in Platform and Reservations under catalogue labels. Verified locally: admin tests 75 pass, contracts and admin `tsc --noEmit` clean, `permission-catalogue.spec` 10/10, `pnpm check:architecture` passes. Not run: lint, full API suite, browser, CI.

## Follow-up: Hotels saved views (browser-local)

Filter presets only: known `LIST_FILTER_KEYS`, values capped at 64 chars, 20 views, held in `localStorage` with every read and write guarded. Choosing a view only rewrites URL filters, so the API authorizes the query as before. Verified locally: admin tests 79 pass (4 new), `tsc --noEmit` clean, eslint clean on changed files, `pnpm check:architecture` passes, `next build` for the admin app succeeds. Not run: browser interaction, full API suite, CI.
