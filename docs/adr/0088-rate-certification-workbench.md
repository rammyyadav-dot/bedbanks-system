# ADR 0088: Rate Certification workbench tab

## Status
Accepted for the Admin UI in this change. It adds no API route, migration, table, permission or privilege, and it amends [ADR 0033](0033-rate-plan-audit-and-distribution-certification.md) only in how the page is used, not in what the audit does.

## Context
Fixing a certification finding meant leaving `/rate-certification` for the hotel's Quick Update tab, finding the same plan again, then coming back to see whether the finding cleared. The night grid, the findings and the editor already exist; they were on three different screens.

## Decision
1. `/rate-certification?tab=workbench&ratePlanId=…` shows one rate plan: its findings (`FindingList`), its night-by-night grid (`NightGrid`, extracted from the plan audit page, so both render the same evaluator verdict) and the existing hotel `QuickUpdatePanel` with that plan preselected.
2. The audit stays read-only and stores nothing (ADR 0033 §2). The workbench adds no write path: Quick Update calls the existing `routes.adminHotelSetup.quickUpdatePreview` and `quickUpdateApply`, so preview, server-side permission checks, idempotency key, fingerprint, required reason and the audit event are unchanged. The UI shows the editor only to callers with `supply.rates.read` and `supply.rates.manage` or `supply.availability.manage`; the API remains the authority.
3. After an apply, the plan audit is re-read (without discarding the form's confirmation) so findings and row classes reflect what was saved. Nothing in the workbench marks a plan certified.
4. Tenant identity is unchanged: the hotel and plan ids are looked up through tenant-scoped reads and the API re-validates them.

## Consequences
- `docs/rate-certification.md` no longer says the page has no editing; the audit routes are still read-only.
- No new contract is needed. If the workbench ever needs its own route (for example a combined grid with inventory), it goes in `@bedbanks/contracts` first.
