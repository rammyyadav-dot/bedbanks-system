# ADR 0053: Agent Search Monitor (no-result explanations)

Status: Proposed. **Not built. Blocked on data-handling decisions.**

## Finding
Per-hotel sellability blockers by date, room, plan and supplier already exist (`sellability`, `readiness`, `distribution`). No record of *which Agent searches returned nothing, and why* is persisted, so a cross-search monitor has no data source. The contract lists "Search monitor" as a planned module with no route (invariant 10).

## Proposed design
- Persist one `SearchOutcome` row per Agent search: tenant, agency, destination/hotel scope, stay dates, occupancy, a canonical reason-code histogram (missing mapping, no inventory, contract expired, market restriction, invalid rate, supplier timeout), counts, duration and a request id. Reason codes reuse the existing evaluator vocabulary (`COMMERCIAL_REASON_TEXT`); no new classifier.
- A supplier failure is recorded as `SUPPLIER_ERROR` or `SUPPLIER_TIMEOUT` and is never reported as "no availability" (invariant 5).
- Write path is best-effort and non-blocking: a failed monitor write must never fail or slow a search.
- Read path: a new permission (for example `distribution.search_monitor.read`), tenant RLS, aggregate-first with drill-down.
- No guest data, no raw supplier payloads, no free text (invariant 7). Nationality and agency identifiers are the sensitive fields.

## Decisions needed
Retention period; whether nationality/agency may be stored; sampling versus full capture at production volume; the strict-role grant for the write path (the Agent search role currently has no such table). Needs a reviewed migration, rollback notes and a tenant-index review.
