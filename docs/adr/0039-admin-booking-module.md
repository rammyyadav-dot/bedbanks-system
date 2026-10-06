# ADR 0039: Admin booking module

## Status
Accepted by the owner on 2026-10-06 (answers to the three questions are recorded in the spec's decisions 5 to 7). Phase 1 is being implemented; later phases are still design.

## Context
`docs/booking-module-spec.md` turns the read-only Admin bookings screen into an operations queue with ten statuses, SLA rules, supplier jobs, finance events and documents. `docs/booking-module-gap-table.md` compares it with `main`. Decisions already taken (spec, 2026-10-06): build in the monorepo (API plus Admin) under `CLAUDE.md`; extend and map existing models rather than duplicate them; `Closed` is a lock (`closedAt`), not a status; migrate the four-value `BookingStatus` to the ten statuses with an explicit mapping; keep `BOOKING_ENABLED=false` and the Agent booking routes unavailable; Admin manual entry behind `ADMIN_MANUAL_BOOKING_ENABLED` (default false).

## Proposed decisions
1. **One status path.** `transitionBooking(bookingId, toStatus, actor, reason, payload)` in a framework-free module under the API booking domain is the only code allowed to write `Booking.status`. It checks the allowed-transition map, an expected `version`, writes a `BookingEvent` and an `AuditEvent` in the same transaction, and is idempotent per key. A test scans the source tree for any other write.
2. **Status migration (forward-only).** `PENDING` is renamed to `PENDING_SUPPLIER`; `CONFIRMED`, `CANCELLED`, `FAILED` keep their names; `ON_REQUEST`, `AMEND_REQUESTED`, `CANCEL_REQUESTED`, `CHECKED_OUT`, `NO_SHOW`, `REJECTED` are added. No existing row changes meaning. `closedAt` is added, null for all existing rows. Rollback notes and the tenant-index review ship with the migration.
3. **Columns before tables.** Promote check-in, check-out, nights, supplier reference, hotel confirmation number, agency, agent, channel, net, markup, FX, payment fields, refundable flag, cancellation deadline, assignee, version and `closedAt` onto `Booking`, backfilled from `searchSnapshot`. New tables: `BookingRoom`, `BookingGuest`, `BookingEvent`, `SupplierCall`; all with composite tenant keys and forced RLS. `SupplierMutation` stays the idempotent journal; `SupplierCall` stores redacted request/response evidence. No float money: integer minor units, plus a frozen decimal FX rate.
4. **Permissions.** New keys are added to the catalogue as `planned` and become `enforced` only with their endpoint: `booking.view.net`, `booking.view.supplier-payload`, `booking.confirm.on-request`, `booking.supplier-ref.edit`, `booking.amend`, `booking.cancel` (existing, refundable), `booking.cancel.nonrefundable`, `booking.waive-penalty.approve`, `booking.manual.create`, `booking.export`, `booking.sla.manage`, `booking.assign`, `booking.pii.view`. `booking.status.update` and `booking.confirm` stay forbidden. No new key is granted to any existing role automatically. The spec's six roles ship as documented permission sets (templates), not as migrated assignments.
5. **Tenant and agency scope.** Operator-tenant isolation stays forced RLS. Agency-scoped users additionally get an `agencyId` filter applied in the data layer from their session membership, never from a query parameter.
6. **Read model.** Phase 1 extends `GET /admin/operations/bookings` and `/:bookingId` and their contracts in `@bedbanks/contracts`; the Admin pages are extended, not duplicated. Filters live in the URL. Search by any reference is an indexed lookup.
7. **Supplier work and SLA.** From Phase 3, supplier calls go through a DB-backed job table behind a `JobQueue` interface with the spec's retries and a status check by our reference before `FAILED`. The mock adapter is test and dev only and cannot be selected for a real tenant. SLA rules are pure functions of booking state and an injected clock (Phase 4).

## Owner answers (2026-10-06)
1. **Database principal: a dedicated limited role** for the booking module (login `fbeds_booking_ops` in group `fbeds_booking`), provisioned by an owner-only, idempotent script beside the hold-expiry one. Not a superuser, `NOBYPASSRLS`, owns nothing. Phase 1 is read-only on `Booking`, `BookingRoom`, `BookingGuest`, `BookingEvent` and `SupplierMutation` only: no ledger, wallet or `BookingDocument` until Phase 5. The booking module has its own connection (`BOOKING_OPS_DATABASE_URL`); no other code uses it. If the role or URL is missing the Admin screens keep the sanitized 503 "not readable" state and never fall back to the API role. The API role keeps no booking grants. Write grants arrive per phase as narrow column grants, and status, event and assignment writes go through `transitionBooking`, not general updates. I do not provision anything; the owner runs the script.
2. **"Tenant" in the spec is `Agency`.** The repo's Tenant (operator) stays the forced-RLS boundary. "All tenants' bookings" means all agencies of one operator. "Tenant admin" is an agency-scoped user. `Booking` gains nullable `agencyId` and `agentUserId`; rows whose agency cannot be derived show as "Unassigned" and are visible only to operator-level readers (`booking.read`). UI label: "Agency".
3. **Reference format: the existing `FB-` plus 20 hex characters for every booking**, manual entry included. The spec's "FB + YYMMDD + 6-digit, as today" is superseded. Booking date has its own column.

## Final permission names (one to one with the spec's roles matrix)
Enforced in Phase 1 are marked **E**; the rest are catalogued `planned` and become `enforced` with their endpoint. None is granted to any existing role automatically; the six spec roles are documented permission sets.

| Spec matrix row | Permission | Phase |
|---|---|---|
| View all agencies' bookings (operator level) | `booking.read` (existing) | E |
| View own agency's bookings (agency admin) | `booking.view.agency` | E |
| See net rate and margin | `booking.view.net` | E |
| See guest personal data unmasked (logged) | `booking.pii.view` | E |
| See raw supplier payloads | `booking.view.supplier-payload` | 3 |
| Confirm / reject on request, offer alternative | `booking.on-request.resolve` | 2 |
| Mark confirmed manually (replaces forbidden `booking.confirm`) | `booking.confirm.manual` | 2 |
| Retry supplier call / sync | `booking.supplier.retry` | 3 |
| Edit supplier ref | `booking.supplier-ref.edit` | 2 |
| Amend (ops) / request only (agency) | `booking.amend` / `booking.amend.request` | 2 |
| Cancel refundable (existing) / request only (agency) | `booking.cancel` / `booking.cancel.request` | 2 |
| Cancel non-refundable, waive penalty | `booking.cancel.nonrefundable` | 2 |
| Approve a penalty waiver (finance) | `booking.penalty.waive.approve` | 5 |
| Rebook, close as failed | `booking.rebook` | 2 |
| Mark no-show, raise adjustment | `booking.no-show.mark` | 2 |
| Assign to an ops user | `booking.assign` | 4 |
| Manual booking entry | `booking.manual.create` | 2 |
| Export (operator) / own agency | `booking.export` / `booking.export.agency` | 6 |
| Change SLA rules | `booking.sla.manage` | 4 |

`booking.status.update` and `booking.confirm` stay in `FORBIDDEN_PERMISSION_KEYS`: a status is never changed by a "status update" permission, only by the transition-specific permission above through `transitionBooking`. The spec's "Assigned regions" for ops agents has no repo concept yet; until a region model exists an ops agent holds `booking.read` (all agencies). That is an open question, not an assumption.

## The two state machines
- `Booking.status` (ten statuses, the commercial and operational lifecycle) is owned by exactly one writer, `transitionBooking`, introduced in Phase 2.
- `BookingTransactionState` (RECHECKED, INVENTORY_HELD, FINANCE_AUTHORIZED, PREBOOKED, BOOKING_PENDING, CONFIRMED, FAILED, UNKNOWN) governs the intake transaction (hold, finance authorisation, supplier prebook and book) and stays as it is. When the intake transaction reaches a result it asks `transitionBooking` for the matching booking status (for example BOOKING_PENDING to CONFIRMED asks for PENDING_SUPPLIER to CONFIRMED); it never writes `Booking.status` itself.
- Until Phase 2 the existing services (`booking-persistence`, `booking-confirmation`, `booking-cancellation`, reconciliation) still write `Booking.status` directly with the renamed values. Phase 2 moves them behind `transitionBooking` and adds a source-scan test that fails on any other write.

## Consequences
Phases 2 to 6 follow the spec's order after Phase 1 is accepted. Finance effects go through the existing ledger and finance services as events. Documents never show net rate or supplier name. Hosted acceptance, live suppliers, booking enablement and payments stay out of scope.

## Phase 2 decisions: the lifecycle engine (2026-10-06)

**One writer.** `transitionBooking(tx, input)` (`apps/api/src/booking-ops/booking-transition.ts`) is the only code that writes `Booking.status` and `Booking.closedAt`. A source-scan test (`booking-status-writers.spec.ts`) fails the build on any other write. The Agent confirmation, cancellation and reconciliation services now call it (system actions `systemConfirm`, `systemFail`, `systemRequestCancellation` + `systemCompleteCancellation`), so every status change, from any source, leaves an immutable `BookingEvent`. `transitionBooking` takes the caller's transaction, so it works under whichever principal opened it.

**Named actions, not "set status".** The spec's transition table lives in `@bedbanks/contracts` (`booking-lifecycle.ts`: `BOOKING_TRANSITIONS`, `BOOKING_ACTION_RULES`). Each action has one legal `from`, one `to`, the formal permission(s) that authorise it, the fields it requires, and who may do it (operator, agency, system). The Admin shows exactly `availableActions` returned by the API, computed by the same function the API enforces. A test asserts the rules and the table cannot drift, over every ordered pair of the ten statuses.

| Action | Move | Permission (formal role) | Required |
|---|---|---|---|
| recordConfirmed | Pending supplier → Confirmed | `booking.confirm.manual` | supplier ref |
| recordOnRequest | Pending supplier → On request | `booking.confirm.manual` | |
| recordFailed | Pending supplier → Failed | `booking.confirm.manual` | reason |
| confirmOnRequest | On request → Confirmed | `booking.on-request.resolve` | supplier ref + hotel conf. no. |
| rejectOnRequest | On request → Rejected | `booking.on-request.resolve` | reason |
| requestAmendment | Confirmed → Amend requested | `booking.amend` (operator) / `booking.amend.request` (agency, own agency) | reason |
| approveAmendment | Amend requested → Confirmed, version +1 | `booking.amend` | |
| rejectAmendment | Amend requested → Confirmed, unchanged | `booking.amend` | reason |
| requestCancellation | Confirmed → Cancel requested | `booking.cancel` if known refundable, else `booking.cancel.nonrefundable`; agency: `booking.cancel.request` | reason; second confirmation unless known refundable (always for agency) |
| confirmCancellation | Cancel requested → Cancelled | as above (operator only) | supplier cancellation ref |
| markNoShow | Checked out → No-show | `booking.no-show.mark` | reason; within 7 days of check-in |
| close | Failed: set `closedAt` | `booking.rebook` | reason |
| system* / markCheckedOut | platform only | none (never offered to a person) | |

Unknown refundability is treated as non-refundable. Owner membership implies none of these keys; they come from formal roles only (a deliberate choice, including for the pre-existing `booking.cancel`, when used in Admin).

**Concurrency and idempotency.** Every write takes an `Idempotency-Key` header. The key and a SHA-256 request fingerprint are stored on the `BookingEvent` row (new nullable columns, unique per tenant + booking + key): a replay returns the first result with `replayed: true` and writes nothing; the same key with a different request is a 409. The caller also sends `expectedStatus` and the update is a compare-and-set on it, so two operators racing on one booking get exactly one winner and a 409 that names the current status. Writes run `ReadCommitted`.

**Audit.** Each write inserts a `BookingEvent` and an `AuditEvent` in the same transaction as the change: both exist or neither. The audit payload carries the action, from/to, permission, caller level, request id and whether a reason was given; never the reason text, guest names or references. Refusals for missing permission write `permission.denied`.

**Database grants (narrow, in `booking-ops-role.ts`).** On top of Phase 1's SELECT: INSERT on `Booking`, `BookingRoom`, `BookingGuest`, `BookingEvent`, `AuditEvent`; UPDATE on the named columns `status, supplier_ref, hotel_confirmation_no, agent_ref, version, closed_at, updated_at` of `Booking`. No DELETE, no TRUNCATE, no table-wide UPDATE, `AuditEvent` write-only, `BookingEvent` still append-only by trigger. The verifier checks all of it, including that no other `Booking` column is updatable. The API role gets no booking grant. **Re-run `ops:provision-booking-ops-role` (owner) after deploying Phase 2**, or the write routes answer 503 "not readable".

**Manual entry** (`POST /admin/operations/bookings`) needs `booking.manual.create` and `ADMIN_MANUAL_BOOKING_ENABLED=true` (default false; enable only in dev/staging). It creates a Pending-supplier booking with channel MANUAL and the standard `FB-` reference, one event, one audit event. It calls no supplier, holds no inventory and moves no money or credit (those arrive with Phases 3 and 5); the screen says so. The API database role (not the booking role) confirms the hotel and agency belong to the operator and that the agency is ACTIVE. Money is integer minor units in strings; only currencies enabled by policy are accepted.

**Deliberately not in Phase 2** (each needs a later phase, and the screen does not pretend otherwise): applying an approved amendment to the booking data (needs re-pricing and the supplier), penalty and refund calculation and any ledger or document effect (Phase 5), offering an alternative and rebooking from a failed booking (needs a link between bookings and supplier calls, Phase 3), the nightly Checked-out job and closing terminal bookings after the dispute window (the window length is still an open question; Phase 4/6), assignment and SLA (Phase 4). `markCheckedOut` exists in the table as a system-only action but nothing schedules it yet.

**Manual outcomes are a stopgap.** Until supplier integration, ops record the supplier's answer by hand (`recordConfirmed` etc.). In Phase 3 the job runner records the same outcomes through `transitionBooking` as the system; the manual actions then stay for the case where a supplier answers off-platform.

## Phase 3 decisions: supplier integration (2026-10-06)

**A DB-backed queue, a runner, an append-only call log.** `BookingSupplierJob` (BOOK, CANCEL, STATUS_CHECK) is the queue behind a `JobQueue`-shaped service; `BookingSupplierCall` is the spec's `supplier_call`; both are tenant-composite with forced RLS. Requests never call a supplier: they enqueue (`booking-supplier-jobs.service.ts`). The runner (`booking-supplier-runner.service.ts`) claims due jobs with `FOR UPDATE SKIP LOCKED` (two runners cannot take the same job), makes the supplier call **outside any database transaction**, then records the outcome through `transitionBooking` in one transaction with the job update and the audit event. It is off unless `BOOKING_JOB_RUNNER_ENABLED=true` and then needs `BOOKING_OPS_DATABASE_URL`; it uses only the booking role.

**No ghost booking, and Unknown is not Failed.** A supplier call that throws (timeout, transport) is not an answer. Before anything is concluded the runner asks the supplier what it holds under our reference (`statusByReference`). Found: the booking takes the supplier's own answer (Confirmed or On request) and nobody books again. Definitely not found: retry after the wait, and only when the attempts are spent is the booking Failed. Cannot ask: the job goes UNKNOWN, the booking stays Pending supplier with `supplierStatus = UNKNOWN`, "Send to supplier" is refused (it could duplicate), and only "Sync with supplier" or a manual answer moves it. A runner that died on the last attempt also yields UNKNOWN, never a blind extra call.

**Retries.** The spec's "3 attempts, 30 s / 2 min / 5 min" is read as a first try plus three retries: at most four calls, waits of 30 s, 2 min and 5 min (`BOOKING_SUPPLIER_RETRY_DELAYS_SECONDS`, `BOOKING_SUPPLIER_MAX_ATTEMPTS = 4` in the contracts). If you meant three calls in total, change the constant and the migration default; nothing else depends on it.

**Supplier outcomes use system actions.** `systemConfirm`, `systemOnRequest`, `systemConfirmOnRequest`, `systemRejectOnRequest`, `systemFail`, `systemCompleteCancellation`, written with actor type SUPPLIER and never offered to a person. A confirmation with no references stays Confirmed and shows "Missing supplier ref" (spec B.4). A refused cancellation leaves the booking Cancel requested with `supplierStatus = CANCEL_FAILED` for ops to settle with the existing manual action. A sync can move On request to Confirmed or Rejected, and Cancel requested to Cancelled, from the supplier's answer.

**Raw supplier payloads are not stored (a deviation from the spec, deliberate).** CLAUDE.md invariant 7 forbids logging raw supplier payloads and guest PII, so `BookingSupplierCall` holds a summary only (outcome, attempt, duration, HTTP status, error code, supplier reference) and has no payload column. `booking.view.supplier-payload` therefore stays `planned`. If support later needs payload retention it needs its own ADR: field-level redaction, encryption, retention and a separate grant.

**The supplier port.** `BookingSupplierPort` (`book`, `cancel`, `statusByReference`) carries canonical shapes only and no guest data; provider types stay in the adapter (invariant 9). There is **no production adapter yet**, so for a real tenant `resolve()` returns null and every screen and route says "supplier not configured" instead of faking an answer. The first real adapter will extend the request with whatever it needs and own reading guest names under its own audit.

**The mock supplier** (`mock-booking-supplier.ts`) is for development, staging and tests only. It is reachable only when `ALLOW_MOCK_SUPPLIER=true` **and** the tenant id is listed in `MOCK_SUPPLIER_TENANT_IDS`, and only for supplier names starting `mock-` (`mock-confirm`, `-confirm-noref`, `-on-request`, `-reject`, `-timeout`, `-ghost`, `-flaky`, `-down`, `-cancel-fail`). A manual booking with that supplier name rehearses each outcome from the Admin. One flag, or a supplier name alone, cannot switch it on for a real tenant.

**Switches.** `ADMIN_SUPPLIER_JOBS_ENABLED` (default false) gates every supplier route and the "send now" option on manual entry. `booking.supplier.retry` (now enforced) authorises send, cancel, retry now and sync; an agency user never has it and never sees the queue.

**Database.** Migration `202611050001_booking_supplier_jobs` adds the two tables, the append-only trigger on the call log and `fbeds_booking_due_tenants(timestamp)`, a SECURITY DEFINER function that returns tenant ids only, so the runner learns which tenants have due work without any cross-tenant read. The booking role gains SELECT and INSERT on both tables, UPDATE on `BookingSupplierJob(status, attempt, run_after, locked_until, last_error_code, completed_at, updated_at)` and `Booking(supplier_status)`, and EXECUTE on that one function. **Re-run `ops:provision-booking-ops-role` (owner) after deploying Phase 3.**

**Deliberately not in Phase 3.** Nightly supplier reconciliation reports and the supplier-initiated cancellation webhook (Phase 6, with the reconciliation job), Urgent flagging of a failed cancellation (Phase 4; it is recorded as `CANCEL_FAILED` and a timeline event today), supplier-side amendment calls, and SQS: the queue is the database, behind an interface that can be swapped.

## Phase 4 decisions: operations queue, SLA, urgency and exception management (2026-10-06)

**The queue is derived, not a second status model.** `@bedbanks/contracts/booking-ops-queue.ts` holds the single ruleset: `evaluateBookingOps(facts, now, policy)` returns whether a booking is a case, why, its priority, its SLA due time and state, whether the supplier's state is certain, and the one safe next step. The API evaluates every list, count and detail with it; the Admin only labels the result; no SQL, controller or component has its own copy. Lifecycle status is an input and is never rewritten to make something urgent. Nothing is written to turn a row red: SLA state and "overdue by 37 minutes" are computed at read time from a due timestamp and an injected clock.

**What is stored.** One table, `BookingOpsState` (one row per booking, tenant-composite, forced RLS): owner, when assigned/acknowledged, a manual priority floor, a manual follow-up flag, resolved-at, and a `version` for compare-and-set. Everything else is derived from booking status, the supplier answer, supplier jobs/calls and the lifecycle log. Free-text notes are `BookingEvent` rows (immutable, operator-only), not a new table.

**Reasons** (precedence order; all that apply are listed, the first is primary): supplier answer unknown, cancellation failed, cancel requested, supplier attempts exhausted, supplier not configured, pending supplier, on request, amendment requested, missing supplier reference, manual follow-up. "SLA due soon" and "SLA breached" are states with their own views, not reasons.

**SLA defaults** (minutes from entering the case for that reason; override with `BOOKING_OPS_SLA_POLICY`, JSON, validated strictly: an invalid value makes the queue answer `BOOKING_OPS_SLA_POLICY_INVALID`, it never falls back to defaults): unknown 15, cancellation failed 15, cancel requested 60, attempts exhausted 30, not configured 60, pending supplier 30, on request 1440, amendment requested 240, missing supplier reference 240, manual follow-up 480. Due soon = the last 25% of the target (never under 5 minutes). Each reason has its own clock: an unknown answer counts from the moment it became unknown, not from when the booking was made.

**Priority** (Normal, High, Urgent, Critical), deterministic: base by reason (unknown and cancellation failed: Urgent; cancel requested, exhausted, not configured: High; the rest: Normal), +1 if the SLA is breached, +1 if check-in is within 24 hours or past, +1 for three or more failed supplier calls, capped at Critical; a manual escalation is a floor that can raise but never lower. This closes the Phase 3 deferral: **a refused cancellation is an Urgent case** and stays Cancel requested.

**Order** (the same for everyone, not a client sort): priority, then SLA state (breached, due soon, within), then the oldest case, then booking id so pages never shuffle. The queue reads at most 2,000 candidate bookings (newest activity first) and says so when capped (`scanCapped`); counts and order cover that set.

**Assignment.** Needs `booking.ops.assign`. The assignee must be a member of this tenant holding `booking.ops.view` (formal) and operator-level read; otherwise `BOOKING_OPS_CROSS_TENANT_DENIED` or `BOOKING_OPS_INELIGIBLE_ASSIGNEE`. Assign, reassign, unassign and acknowledge compare the `version` the caller saw: two people claiming at once get one winner and one `BOOKING_OPS_CONFLICT`. An assignment older than the current case belongs to an earlier case: the new case starts unassigned. Every mutation takes an `Idempotency-Key`, locks the booking row, writes an immutable `BookingEvent` and an `AuditEvent` in the same transaction; audit payloads carry facts and ids, never reason text.

**Uncertain supplier state and the manual answer.** `POST /admin/operations/booking-queue/:id/supplier-answer` (permission `booking.ops.resolve`) records a named, evidenced fact when the supplier's answer is uncertain or cannot be obtained: confirmed (needs the supplier's booking reference), on request, rejected, **no booking exists**, cancellation confirmed (needs the cancellation reference), cancellation refused, still awaiting. It is never a status picker, there is no "mark failed", every answer needs a reason of at least 10 characters, and a valid status per answer (anything else is `BOOKING_OPS_INVALID_TRANSITION`). "Supplier has no booking" is a different fact from "supplier rejected": it needs who told you and a reference, requires an idle supplier queue (a queued job could still book), does not change the status, closes the unknown outcome and only then makes "Send to supplier" safe. The status-moving answers go through `transitionBooking` (system actions, actor USER); this service has no other way to change a status, and the source-scan test still holds.

**Races.** The supplier call runs outside any transaction and operators are never blocked by it. If a person records the answer while a call is in flight, the late supplier result is dropped (the runner treats a stale compare-and-set as `ALREADY_APPLIED`, finishes the job and does not retry) and the call stays in the log. If the supplier is asked after a timeout and says it holds the booking, the booking takes that answer; one booking request was made. A timeout alone never authorises another booking request.

**Switches.** `ADMIN_BOOKING_OPS_ENABLED` (Admin visibility of the queue and panel; default off) is independent of `ADMIN_SUPPLIER_JOBS_ENABLED`, `BOOKING_JOB_RUNNER_ENABLED`, `ALLOW_MOCK_SUPPLIER` and the booking-lifecycle flags. Turning the queue on starts nothing and turning it off stops no supplier job.

**Database.** Migration `202611060001_booking_ops_state` adds the table and the five permissions (data only; granted to no role). The booking role gains SELECT and INSERT on `BookingOpsState` and UPDATE on its operational columns only (never the keys), and nothing else. **Re-run `ops:provision-booking-ops-role` (owner) after deploying Phase 4.** The privileged-write contract and its generated matrix list the table as booking-module-only.

**Deliberately not in Phase 4:** nightly reconciliation reports, supplier-initiated cancellations, SQS, a production supplier adapter, supplier amendment calls, payment, raw payload retention, assignment by region, per-tenant SLA policies (one policy per deployment today), email or push alerts for breached SLAs.
