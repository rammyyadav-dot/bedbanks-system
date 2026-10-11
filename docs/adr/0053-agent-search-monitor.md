# ADR 0053: Agent Search Monitor (no-result explanations)

Status: **v1 built (outcome monitor, no new storage).** The root-cause SearchOutcome table below remains Proposed and blocked on data-handling decisions.

## v1 as built
Without waiting for retention/PII decisions, v1 reads the audit events Agent search already writes (`hotel.search`, `hotel.search.mapping_unavailable`) and, new in this change, a best-effort `hotel.search` event with status `provider_unavailable` when the source throws (previously nothing was recorded). `GET /admin/operations/search-monitor?days=1..30` (permission `audit.read`, tenant RLS) returns counts by status, day and destination plus recent problem searches; page `/distribution/search-monitor`. No new table, no nationality, no agency, no new retention: audit retention applies. Cached answers and unconfigured-source answers are not recorded, so counts are of executed searches, and the page says so. It reports **what** happened, not **why a rule removed an offer**; per-reason histograms still need the SearchOutcome design below. Verified: `search-monitor.spec.ts`, and Postgres e2e `SEARCH-MONITOR` in `hotel-commercial.e2e-spec.ts` (403/401, status counts, tenant isolation). Not run: browser, strict-role variant, CI.

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
