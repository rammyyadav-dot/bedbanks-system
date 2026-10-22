# CTO scan and bug report, 2026-10-22

**Branch:** `claude/eager-pascal-t6aqqk` (base `a6a99bb`, `main` as of 2026-10-22)
**Earlier audit:** `CTO_AUDIT_REPORT.md` (2026-10-01, commit `62b1c5f`). This report does not repeat it; it records what a fresh scan found since.
**Depth:** a targeted scan, not a line-by-line audit. Section 5 lists what was not covered. Every finding below says whether I verified it or only observed it.

## 1. Verdict

**Amber, unchanged.** All automated gates pass, no critical defect was found, and the tenant, permission, money and secret controls I sampled held up. The open items are a test suite that does not finish locally, one untracked dependency advisory, a structural gap against the constitution (permissions are enforced but not declared on supplier controllers), and a supplier UI that is honest about being mostly unavailable but has rough edges.

## Fix status (updated the same day)

| ID | Status | What changed |
| --- | --- | --- |
| BUG-01 | **Open** | Needs the CI database setup to reproduce; not attempted here. |
| BUG-02 | Fixed | `js-yaml@^5` override to `^5.4.1` in root `package.json`; `pnpm audit --prod` now lists only BUG-03. |
| BUG-03 | **Open, tracked** | Waits on a Prisma release that carries `deepmerge-ts` 8. Allowlist expires 2026-12-31. |
| BUG-04 | Fixed | `SupplierPermissionGuard` plus `@RequireSupplierPermission` on all 17 supplier routes; fails closed. Test walks every route. See ADR 0088. Service checks kept. |
| BUG-05 | Decided | No key needed for a replace-style note save. Recorded in ADR 0088. |
| UX-01 | Fixed | Unavailable pages use a muted grey dot. |
| UX-02 | Fixed | Disabled search box removed from the top bar. |
| UX-03 | Fixed | Hotel detail uses a plain definition list. |
| UX-04 | Fixed (contrast); text size open | `tests/08-supplier-a11y.spec.ts` runs axe (WCAG 2.1 A/AA) over 15 supplier pages and passes. It first found colour-contrast failures only (ratios 2.5 to 4.4 against 4.5 needed) in the sidebar, page eyebrow, breadcrumbs, table headers and sub-text, and back link; colours were darkened or lightened to pass, and the blanket `opacity: .62` on unavailable nav items was removed. **Still open:** much supplier text is 7 to 9 px, which axe does not flag but is hard to read; that needs a design decision, as does grouping the unavailable nav items. |
| UX-05 | Fixed | Dead `properties` page files deleted; the redirects stay. |
| MAINT-01 | **Open** | Splitting `supply.service.ts` and `operations-hotels.service.ts` is a refactor that needs its own change. |
| MAINT-02 | Fixed | One `formatCoordinate` helper in `hotel-setup/hotel-decimal.ts`. |
| MAINT-03 | Started | `no-explicit-any` is now a lint warning in production code (not tests), so new uses show up. The existing uses are still to be removed. |

Verified after the fixes: `pnpm check:architecture`, `pnpm type-check`, `pnpm lint` pass; API unit tests 1885 pass (23 new); supplier unit tests pass; live Playwright API-security (S1–S10), supplier (X1–X6), screenshot and accessibility specs pass, against a fresh stack built from this branch.

## 2. Gate results (run on this branch)

| Gate | Result |
| --- | --- |
| `pnpm check:architecture` (11 checks: contracts, app boundaries, no-float, no-silent-fallback, ledger single writer, tenant filter, public env, runtime DB role, AWS governance, workflow permissions, framework peers) | Pass |
| `pnpm type-check` | Pass, 15/15 packages |
| `pnpm lint` | Pass, 14/14 packages |
| API unit tests (`jest --runInBand`) | Pass: 183 suites, 1862 tests, 14 skipped |
| Package and app unit tests (domain, money, pricing, connectors-core, validation, supplier, agent, website) | Pass |
| API e2e suite (`test:e2e`) | **Did not complete here, see BUG-01** |
| Playwright Supplier extranet X1–X6 plus new screenshot spec | Pass, 9/9 against a live stack |
| `pnpm audit --prod` | 2 advisories, see BUG-02 and BUG-03 |
| `tools/dependency-audit-check.mjs` | Pass (the one high advisory is on the allowlist) |

Not a bug, but note it: this container runs Node 22 and the repo requires 24. Everything ran, with an engine warning.

## 3. Bugs and risks to fix

Severity: **High** blocks release; **Medium** fix this sprint; **Low** schedule.

### BUG-01 (Medium, verified here, not yet confirmed in CI): API e2e suite crashes with a V8 heap out of memory
- **Evidence:** `pnpm test` exited 134. The `@bedbanks/api` e2e stage (`jest --config ./test/jest-e2e.json --runInBand`) died with `FATAL ERROR: Ineffective mark-compacts near heap limit` at about 2 GB, after several DB-backed specs failed (`rate-plan-approval`, `booking-finance`, `rate-plan-derived`, `inventory-admin`, `hotel-readiness`). Those failures are probably because I did not provision the CI database environment here, so I cannot say the suite itself is broken.
- **What is real:** one process runs every e2e spec in sequence and its heap grows until it hits the default limit. Failures made it worse here, and with more specs it can happen in CI too.
- **Fix:**
  1. Reproduce with the CI database setup and check whether CI passes with room to spare.
  2. Find leaking specs (apps or Prisma clients not closed in `afterAll`; run `jest --detectOpenHandles`).
  3. Shard the e2e suite across CI jobs or restart the worker periodically, instead of only raising `--max-old-space-size`.
- **Done when:** the full e2e run finishes in CI with heap well under the limit, and a heap-growth guard is in place.

### BUG-02 (Low, verified): moderate advisory GHSA-r3ph-w7gj-g6xm in `js-yaml` 5.3.0 is not tracked
- **Path:** `apps/api > @nestjs/swagger@11.4.7 > js-yaml@5.3.0`. Needs `>=5.4.1`.
- **Why low:** Swagger is not served in production (`main.ts:78`, ADR 0062).
- **Gap:** the existing override in the root `package.json` only covers `js-yaml@^4`, and the audit gate only fails on high and critical, so this will never be noticed.
- **Fix:** add a `js-yaml@^5` override to `>=5.4.1` in `pnpm.overrides`, then re-run `pnpm audit --prod`.

### BUG-03 (Low, verified, already accepted): high advisory GHSA-ggr8-5vv4-36mx in `deepmerge-ts` 7.1.5
- Reached only through the Prisma CLI config loader. Accepted in `security/audit-allowlist.json` with an expiry of **2026-12-31**.
- **Action:** put a ticket against the Prisma upgrade that carries `deepmerge-ts` 8 before the expiry date. If it is not ready by then, the dependency gate will start failing every PR.

### BUG-04 (Medium, verified in code): supplier extranet controllers enforce permissions in services, not on the route
- **Constitution rule 2:** every tenant-scoped API controller "declares and verifies a permission".
- **What I found:** `supplier-extranet.controller.ts` and `supplier-change-sets.controller.ts` declare only guards (`SessionAuthGuard`, `TenantContextGuard`, `SupplierOrganizationGuard`). The permission is checked inside the service with `requirePermission(...)`. I sampled hotels, rooms, contracts, room drafts and the change-set routes and each one checks a permission, so I found **no hole today**. I did not read the booking-answer service (`this.answers.answer`).
- **Risk:** a new route can be added with guards but no `requirePermission` call, and nothing would fail. Compare `booking-ops`, which declares `@RequireBookingAction(...)` on the route.
- **Fix:** add a route decorator plus guard for supplier permissions (as `booking-ops` does), and add a test that walks every supplier route and fails if one lacks a declared permission.
- **Done when:** the route test exists and passes.

### BUG-05 (Low, observed): `PATCH /supplier/.../rooms/:roomId/draft` takes no idempotency key
- Saving a private room note is a replace, so it is naturally repeatable, and it is not on the constitution's list of mutations that need idempotency (booking, cancellation, wallet, payment, webhook).
- **Action:** record the decision either way, as a line in an ADR, so nobody has to rediscover it.

### UX-01 (Low, verified in screenshots): status dot colour contradicts the label
- On unavailable pages the eyebrow reads "UNAVAILABLE" with a **green** dot (for example `/rooms`). Green reads as healthy.
- **Fix:** neutral or amber dot for unavailable modules. Check the shared `SupplyWorkflowUnavailable` component.

### UX-02 (Low, verified): the top-bar search box is always shown and always disabled
- Placeholder says "Search is not available". This is the kind of placeholder control rule 10 warns about. **Fix:** hide it until search exists.

### UX-03 (Low, verified): read-only hotel detail renders as input-looking boxes
- `/hotels/:id` shows property type, status, mapping and city inside bordered boxes that look editable, while the page says edits are unavailable. **Fix:** use a plain definition list.

### UX-04 (Low, observed, needs measuring): disabled navigation is hard to read
- The "NOT AVAILABLE" badges and greyed items are small and dim, and "Inventory submissions" wraps its badge onto two lines. I eyeballed this and did not measure contrast. **Fix:** add an axe accessibility scan to the Playwright supplier spec.
- At least 10 sidebar items are marked unavailable. That is honest, but consider collapsing them into one "Coming later" group so the working areas (Dashboard, Properties, Contracts, Bookings) stand out.

### UX-05 (Low, verified): dead page files behind redirects in the supplier app
- `app/(portal)/properties/*` (`page`, `new`, `[propertyId]`, `[propertyId]/rooms`) are unavailable stubs, but `next.config.mjs:30-31` already redirects every `/properties/*` path to `/hotels/*` (checked live: 307). The page files can never render. **Fix:** delete the `properties` page tree and keep the redirects.

### MAINT-01 (Low, verified): oversized files
- `apps/api/src/supply/supply.service.ts` 1060 lines; `admin-operations/operations-hotels.service.ts` 842 lines. Split along responsibility before more is added.

### MAINT-02 (Low, verified): the same `dec` helper is copied three times
- `hotel-setup.service.ts`, `hotel-profile-summary.ts`, `operations-hotels.service.ts`. It formats hotel coordinates, not money, so rule 3 is not affected. Move to one shared helper.

### MAINT-03 (Low, verified): 51 `any` uses in non-test API code
- Worth a lint rule (`no-explicit-any` as warn, then error) and a burn-down.

## 4. Checked and clean

- **No money floats found.** The `toFixed` hits are hotel coordinates and search-vector numbers, not prices.
- **No hardcoded secrets** matched the credential pattern in apps or packages (outside tests and examples).
- **Swagger is off in production** (ADR 0062). Login throttling exists (`auth/login-throttle.ts`).
- **Raw SQL** (`$executeRawUnsafe`) appears only in DB role provisioning tooling, with identifiers validated against `^[a-z][a-z0-9_]{2,62}$`. No request-path use found.
- **Tenant isolation, live:** Playwright X3–X6 show each supplier sees only its own hotel, a read-only member is limited, and a revoked member sees nothing.
- **Honest unavailable states:** the supplier portal states plainly that publication and booking are unavailable and creates nothing from those screens.
- **Idempotency on supplier writes:** booking answer and change-set create/replace/submit/withdraw all take an `Idempotency-Key`.

## 5. Not covered (do not read this report as clean for these)

- The agent portal, admin console and public website were not reviewed visually or by code beyond the shared gates.
- Booking, finance posting, ledger, reconciliation and connector code were not read line by line. The earlier audit's gate on live supplier connectivity and booking certification still stands.
- The API e2e suite was not run to a result (BUG-01).
- No load, penetration, accessibility-tool or backup/restore testing.
- Infrastructure (AWS, Render, Vercel configuration) was only covered by the static governance check.

## 6. Suggested order of work

1. BUG-01: get the e2e suite finishing reliably in CI.
2. BUG-04: route-level permission declaration and its guard test.
3. BUG-02 and BUG-03: the override now, the Prisma ticket before 2026-12-31.
4. UX-01, UX-02, UX-03, UX-05: one small supplier-portal PR.
5. UX-04: axe scan in the new screenshot spec.
6. MAINT-01 to MAINT-03: opportunistically.

## 7. Evidence

Live supplier screenshots (desktop and mobile) are produced by `e2e/tests/07-supplier-screenshots.spec.ts` into `e2e/.artifacts/screenshots/supplier/` (git-ignored); see `docs/runbooks/e2e-release-suite.md`.
