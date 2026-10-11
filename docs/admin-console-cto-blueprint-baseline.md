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
| Hotels KPI strip | Partial | Draft, incomplete and suspended profile counts added (exact, tenant-wide, from a `groupBy` on `Hotel.contentStatus`). `HotelsSummary` shows total, ready/partial/blocked, mapping, rate and availability gaps, expiring contracts. Blueprint also asks for inactive/onboarding counts and stale-feed counts. Summary is capped by a scan limit and says so. |
| Hotels search, filters, server pagination | Implemented | Name, canonical id, external ids; URL-persisted filters. Source-type and tenant-scope filters are not evident. |
| Saved views on Hotels | Partial | Personal filter presets stored in this browser only (`lib/hotel-views.ts`, `HotelSavedViews.tsx`). Not shared across devices or people, no default view, no column memory. Server-side views (as Bookings has) still need a contract and API route. |
| Hotels bulk tools (assign owner, export, recertify) | Partial | Bulk **owner assignment** built (max 25 hotels, needs `supply.hotels.manage`, reason required). It loops the existing single-hotel Setup save, so each hotel is authorized, version-checked, idempotent and audited by the API; there is no bulk endpoint. **Export built** (ADR 0051, `supply.hotels.export`, granted to no role). Recertification request: **not built**; the existing rate-certification module is read-only, so there is nothing to re-run (ADR 0052). |
| Configurable columns on Hotels | Missing | Column picker exists for Bookings only. |
| Hotel Profile tabs (Overview, Rooms, Contracts, Rate Plans, Quick Update, Rate Calendar, Inventory, Distribution, Bookings, Audit) | Implemented | Panels present under `components/hotels/panels`, plus Setup, Amenities, Images, Policies, Mapping. |
| Lifecycle separate from sellability | Implemented | Publication vs transaction enablement; sellability derived by the evaluator, not a boolean. |
| Activation-readiness gate with second approver | Implemented | 12 requirements, second approver (ADR 0022). |
| Onboarding wizard (8 steps) | Partial | Capabilities exist as tabs. The 12-requirement publication checklist (`HOTEL_PUBLICATION_REQUIREMENTS`, shown in Setup/Publication and Overview completeness) already covers the identity/content/room gates, so a second checklist would compete with it and was **not** built. A guided step flow across contracts, rates and mapping remains unbuilt. |
| Quick Update (rates, inventory, stop sale, restrictions) | Implemented | Preview, atomic apply, stale-preview refusal, idempotency, audit, limits 5 plans / 500 plan-nights. Closed-to-departure is covered by inventory semantics. |
| Quick Update source-authority rules for channel-manager data | Blocked | No live supplier/channel manager; rate-source ownership only meaningful once a connector writes rates. |
| Pooled inventory Sold + Held <= Capacity under concurrency | Implemented (unverified here) | ADR 0030, pool tests claimed. Needs a re-run against Postgres. |
| Tenant lifecycle (verification, credit, suspension enforced by API) | Partial | Tenant control center merged (PR #300); see `docs/tenant-control-gap-matrix.md`. Markets, credit terms, sales ownership not confirmed. |
| Supplier/contract rights, amendment history | Partial | Contracts exist; market restrictions and amendment history not confirmed. Market/nationality enforcement is blocked on a market policy decision. |
| Pricing: net / margin / sell separation, FX | Partial | Integer minor units, per-night rounding, markup rules built. Currency conversion is AED-only by ADR 0029. Promotions not built. |
| Agent Search Monitor with no-result reasons | Partial: outcome monitor built from audit events (ADR 0053 v1); per-reason explanations still missing | Listed `planned` ("Search monitor"). Sellability blockers by date/entity exist per hotel, but no cross-search monitor. |
| Booking ops queues, state machine, idempotency | Implemented | `/bookings/queue`, holds, cancellations, reconciliation, connectors. |
| Finance: receivables, ledger, wallets, funding | Implemented; Payables, Refunds, Credit notes Partial: read-only supplier payables accrual built (ADR 0054 slice 1); read-only refund register built (ADR 0054 slice 2, the ledger filtered to REFUND); credit notes, manual refunds and settlement remain unbuilt (accounting policy and restricted write role needed) | Both are `planned` in the contract. |
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

## Follow-up: Hotels summary profile-status counts

`HotelCommercialSummary.profileStatus` (draft, incomplete, complete, suspended, archived) is exact over the whole tenant and not limited by the scan cap. The scan cap itself is **not** removed: readiness, mapping, rate, availability and contract counts still cover the first alphabetical hotels, and `scanCapped` still says so. The tiles are profile approval states, not sellability. Verified locally: contracts, API and admin `tsc --noEmit` clean (API after `prisma generate`), `src/admin-operations` jest 89/89. Not run: the Postgres-backed e2e suite (no database server in this environment), browser, CI. No e2e assertion was added for the new field because it could not be run.

## Follow-up: bulk owner assignment

`lib/hotel-bulk-owner.ts` and `HotelBulkOwner.tsx`; selection checkboxes appear on the Hotels list only with `supply.hotels.manage`. Sequential, per-hotel fresh concurrency token, per-hotel idempotency key reused on retry, a failure never aborts the rest and is listed per hotel. Hotels already owned by the chosen user are skipped. Not atomic across hotels by design; the result summary says so per hotel. Verified locally: admin tests 83 pass (4 new, using injected fakes), `tsc`, eslint, `next build`, `pnpm check:architecture`. **Not verified:** behavior against the real API/Postgres, the audit rows it produces, browser interaction. A cross-tenant negative test is not applicable to the UI loop but is covered by the existing Setup endpoint's tests, which were not re-run.

## Follow-up: export and the three blocked items

Built: Hotels CSV export (ADR 0051): new permission, data-only migration, audited, row-capped, formula-safe, UI button gated on the permission. Verified locally: contracts/API/admin `tsc`, jest `src/admin-operations` + agent permissions + commercial (106 pass, including new `hotel-export.spec.ts`), admin tests 83, eslint on changed admin files. **Not verified:** the migration against Postgres, the endpoint end to end, the audit row, a cross-tenant negative test, a browser download. A reviewer must run the strict-role e2e before release.

Not built, with ADRs stating the decision each needs: recertification request (0052), Agent Search Monitor (0053), finance payables/refunds/credit notes (0054). They need schema, restricted roles and policy answers, and none can be tested without a database server here.

## Follow-up: recertification interim

ADR 0052 option 1 only: a "Re-check readiness" link per hotel row to the existing readiness tab. No tracked request exists. `tsc`, eslint and admin tests re-run; no browser check.

## Correction and follow-up: Postgres was available

Earlier entries said no database server existed here. That was wrong: Postgres 16 is installed; it needed `apt-get install postgresql-16-pgvector` to apply the migrations. With it, all migrations (including `202611110001`) apply cleanly and `hotel-commercial.e2e-spec.ts` passes 27/27, covering export (permission, tenant isolation, audit), summary profile status and the search monitor. Still not run: browser, the strict-role (`fbeds_api`) e2e variants, the full API suite, CI.

## Follow-up: Search Monitor v1 and payables slice 1

Built and verified against Postgres (`hotel-commercial.e2e-spec.ts` 28/28, including the non-bypass runtime-role test, which now also runs export, the monitor and payables; `strict-runtime-role-commercial` 22/22): Search Monitor v1 (ADR 0053), supplier payables accrual (ADR 0054 slice 1). Admin tests 83, `tsc` for API and admin, `next build`, `pnpm check:architecture`, `src/admin-operations` jest 98. Not run: browser, full API e2e suite, CI.

## Browser evidence

`tools/admin-ops-verify/verify-admin-blueprint.cjs` against a real API process (local disposable Postgres, owner connection with the test-only role-guard override), the production Admin build and headless Chromium: 16/16 checks pass (Business nav group, saved views save/apply/delete, profile-status tiles, CSV download with tenant-only rows, bulk owner assign and idempotent re-apply, Search Monitor and Payables render, breadcrumb, read-only viewer sees no export or selection controls, no page errors). Screenshots were captured locally (not committed). Found and fixed on the way: the breadcrumb showed a duplicate trailing segment ("Search monitor / search-monitor") for routes that are themselves navigation entries, a pre-existing bug for several routes. Not covered: axe accessibility on the new pages, narrow-viewport layout, the strict-role API variant, CI.

## Browser evidence update: accessibility and layout

`verify-admin-blueprint.cjs` now also runs axe (WCAG A/AA) on the Hotels list, Search Monitor and Payables, and checks for horizontal page overflow at 1280, 768 and 390 px: 28/28 pass. axe found real colour-contrast failures in the new saved-views and period controls (labels and inputs inherited grey #7b7b76 at 3.94:1); fixed by setting explicit text colours. Not run: the strict-role API variant, CI.

## The six e2e suites that failed on the baseline

Three were environment only: `inventory-runtime-roles` and `inventory-hold` need `DATABASE_URL` with `?schema=public` and `MAPPING_DATABASE_URL`; `hotel-search-index` needs `MAPPING_DATABASE_URL`; `sandbox-content-staging` only runs against `fbeds_ci`. With the right environment they pass (16/16, 4/4). Two were stale tests, now updated to the current, intentional API behaviour: `supply.e2e-spec.ts` (settlement currency is AED-only per ADR 0029; administrators can no longer author `sold`; audit payload is `before`/`after`) and `dubai-agent-search.e2e-spec.ts` (the API now refuses to deactivate the last room of a published hotel, so that gate is exercised by a fixture change). Both pass (19/19, 9/9). No production code changed for these.

## Follow-up: refund register

`/finance/refunds` (finance.read): the existing ledger endpoint filtered to REFUND entries; read-only. Browser check now 33/33 (axe and overflow included). Credit notes and manual refunds deliberately not built; ADR 0054 records why and a proposed default awaiting your approval.

## Follow-up: credit notes (ADR 0054 slice 3)

Credit notes already exist as frozen `CREDIT_NOTE` booking documents (issued for cancelled bookings, numbered `CN-<booking reference>`, edit-proof by trigger), so the accepted proposal for a new gapless numbering and issuing system would have created a second source of truth. Not built; ADR 0054 now records the correction and the decisions still open. Built instead: a read-only credit note register (`/finance/credit-notes`), verified by Postgres e2e `CREDIT-NOTE-REGISTER` (403/401, only CREDIT_NOTE documents, tenant isolation, unreadable amount shown as unknown) in `hotel-commercial.e2e-spec.ts` (29/29).

## Merge note

Another author pushed to this branch (merges of main and a relative-date rewrite of `supply.e2e-spec.ts`). The automatic merge combined that rewrite with my earlier edits of the same file and left it uncompilable (`day` undefined). I restored the other author's self-consistent version of the file (`32dc3be`), which passes 19/19; my edits to that file are dropped as redundant.
