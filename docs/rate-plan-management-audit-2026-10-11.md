# Room Rate Plan Management: baseline and gap matrix

Baseline: branch `claude/fervent-archimedes-9ugbfp`, HEAD `5e145867c5daaad02b83475c832a78ab72e172ae` (PR #297 merge), clean tree. `AGENTS.md` does not exist at the root (`CLAUDE.md` is the constitution; `apps/admin/AGENTS.md` is Next.js guidance). Reused: `RatePlan`, `DailyRate`, `DailyAvailability`, `InventoryPool`, contract policy tables, `supply/contracted-sellability`, atomic calendar preview/apply, Quick Update, rate certification. No second pricing engine added.

| Requirement | Status | Evidence |
|---|---|---|
| Hotel > room > plan > contract hierarchy | IMPLEMENTED (existing) | `RatePlan` schema; hotel tabs |
| Hotel-scoped Rate Plans listing, counts, filters, paging | IMPLEMENTED (this change) | `RatePlansPanel`, portfolio `statusCounts` |
| Create/edit plan | IMPLEMENTED (existing, single form, not a wizard) | `RatePlanForm` |
| Clone | IMPLEMENTED (this change) | `cloneRatePlan`, spec |
| Activate/suspend with readiness checklist and concurrency | IMPLEMENTED; PATCH bypass closed (ADR 0041 Amendment 1); strict-role writer still missing | ADR 0041 |
| Calendar read, preview/apply with stale-cell checks | IMPLEMENTED (existing); inline grid editor MISSING | ADR/doc `enriched-rate-plan-workflow.md` |
| Quick Update, restrictions (min stay, CTA, CTD, stop sell) | IMPLEMENTED (existing) | `QuickUpdatePanel` |
| Occupancy codes SGL/DBL/TPL | PARTIAL: one plan per occupancy integer; no CNB/extra-bed pricing schema | schema |
| Board supplements, child/extra bed pricing, derived rates, promotions | MISSING (no schema; needs pricing policy) | conformance doc |
| Cancellation policy attached per plan | PARTIAL: contract-level schedule; plan has `refundable` only | schema |
| Market/channel eligibility per plan | PARTIAL: contract-level markets only | ADR 0035 |
| Four-eye activation approval | MISSING | not reviewed |
| Plan validity dates (effective from/to) | MISSING (inherits contract term) | schema |
| Audit history by field/date | PARTIAL: lifecycle events now carry before/after; calendar events already do | |
| Strict-role/RLS/replay/drift/browser tests | BLOCKED: no PostgreSQL server in this container | |

## Verification run here
- `rate-plan-activation.spec.ts` (15) and `rate-plan-lifecycle.spec.ts` (service, mocked transaction): pass.
- API jest (`--runInBand`): all suites pass after updating the portfolio mock for `groupBy`.
- Admin unit tests 74/74; API and Admin and contracts `tsc --noEmit` clean; eslint clean on changed areas; `pnpm check:architecture`, `check:schema` pass; Admin production build passes.
- NOT RUN: e2e suites, migration replay, drift, strict-role probes, browser tests, screenshots, Agent Dubai fixtures.

Booking, payment and supplier confirmation are untouched and remain disabled.
