# Admin Booking module — running it locally (Phases 1 to 6C)

Source of truth: `docs/booking-module-spec.md`. Decisions: `docs/adr/0039-admin-booking-module.md`.

## What exists after Phase 1
- Ten-value `BookingStatus`, promoted booking columns, `BookingRoom` / `BookingGuest` / `BookingEvent` (append-only), backfilled per tenant by migration.
- Read-only list (`GET /api/v1/admin/operations/bookings`) and detail (`.../bookings/:id`, id or `FB-` reference), Admin pages `/bookings` and `/bookings/[id]`.
- Phase 2 adds the lifecycle engine: named actions (confirm/reject on request, amend, cancel, no-show, close, edit references) through `transitionBooking`, the one writer of `Booking.status`; every change leaves a `BookingEvent` and an `AuditEvent`. See ADR 0039 (Phase 2 decisions) for the action table, permissions and what is deliberately not built yet.
- Manual booking entry (`/bookings/new`) is behind `ADMIN_MANUAL_BOOKING_ENABLED` (default `false`; dev/staging only). It records a Pending-supplier booking; no supplier call, hold or money movement.
- Phase 3 adds the supplier queue: send, cancel, retry now and sync, a runner with the spec's retries, a status check by our reference before a booking can be Failed, and a summary-only call log. There is **no production supplier adapter yet**; only the mock exists, for named tenants. See ADR 0039 (Phase 3 decisions).
- Phase 4 adds the operations queue (`/bookings/queue`): which bookings need a person, why, how urgent, by when, and who owns them, from one ruleset in `@bedbanks/contracts`. **UNKNOWN is not FAILED, and a supplier timeout alone never authorises another booking request.** See ADR 0039 (Phase 4 decisions).
- Phase 5 adds money and documents: an append-only outbox of money facts (confirmed, on-request hold and release, cancelled with penalty and refund, penalty decided or waived), cancellation terms frozen with the booking, the penalty fixed when cancellation is requested (waivable by a second person, never raised), and immutable vouchers, invoices, credit notes and cancellation notes. **The module does not post to the ledger or move a balance, and it sends no notification or webhook.** See ADR 0039 Phase 5 and the section below.
- Phase 6 (so far, 6A and 6B): one canonical booking query (`BookingQueryV1`, one service) and personal saved views. See "Booking query and saved views" below.
- Still no payment from this module.
- `BOOKING_ENABLED` stays `false`; Agent booking routes stay `booking_unavailable`.

## Run it
1. Disposable DB only: `DATABASE_URL=postgresql://…/fbeds_ci` then `pnpm --filter @bedbanks/api exec prisma migrate deploy` (never `migrate dev` / `db push`).
2. Provision the limited booking role (owner-run, idempotent; never done by the app):
   `pnpm --filter @bedbanks/api ops:provision-booking-ops-role` — creates group `fbeds_booking` and login `fbeds_booking_ops`: SELECT on `Booking`, `BookingRoom`, `BookingGuest`, `BookingEvent`, `SupplierMutation`; INSERT on the four booking tables and `AuditEvent`; UPDATE on named `Booking` columns only. **Re-run it after upgrading to Phase 2**, or write routes answer 503.
3. Set `BOOKING_OPS_DATABASE_URL` to that login. It must differ from `DATABASE_URL`. If it is missing or the role is absent the screens show the existing "not readable" 503 — there is no fallback to the API role.
4. Seed ~40 demo bookings (all ten statuses, four agencies, five hotels, USD/GBP/EUR/AED, some Urgent-like, some missing a supplier ref, some Unassigned):
   `cd apps/api && NODE_ENV=test node --no-experimental-strip-types -r @swc-node/register ../../tools/admin-ops-verify/seed-bookings.ts` (refuses anything but `fbeds_ci` / `p0N_*`). Credentials are written to `tools/admin-ops-verify/.seed-bookings.json`: `ops` (booking.read), `opsall` (+ pii + net), `agency` (booking.view.agency, one agency).
5. Run API and Admin as usual and open `/bookings`.
6. To rehearse the supplier queue locally (never in production): `ADMIN_SUPPLIER_JOBS_ENABLED=true BOOKING_JOB_RUNNER_ENABLED=true BOOKING_JOB_RUNNER_INTERVAL_MS=1000 ALLOW_MOCK_SUPPLIER=true MOCK_SUPPLIER_TENANT_IDS=<your tenant id>` plus the manual-entry flag. Enter a manual booking (tick "Send to the supplier now") with a supplier name such as `mock-confirm`, `mock-ghost` (booked but timed out: no ghost, no duplicate), `mock-flaky` (first call times out), `mock-timeout` (retries 30 s / 2 min / 5 min, then Failed), `mock-down` (outcome unknown, never Failed), `mock-reject`, `mock-on-request`, `mock-cancel-fail`. A supplier name without a connection is refused, never faked.

## Permissions (formal roles only, never owner-implied)
`booking.read` (operator list/detail), `booking.view.agency` (own agency only), `booking.pii.view` (unmasked guests + guest search, audited), `booking.view.net` (net/markup/margin).
Phase 2 actions: `booking.confirm.manual`, `booking.on-request.resolve`, `booking.amend`, `booking.amend.request`, `booking.cancel` (existing), `booking.cancel.request`, `booking.cancel.nonrefundable`, `booking.no-show.mark`, `booking.rebook`, `booking.supplier-ref.edit`, `booking.manual.create`; Phase 3: `booking.supplier.retry` (send, cancel, retry now, sync). An operator also needs `agency.read` and `supply.hotels.read` to use the manual-entry pickers. Seeded users: `ops` (read), `opsall` (read + pii + net), `lead` (every action), `agency` (own agency, read), `requester` (own agency, request cancel/amend).

## Tests
- Unit: `pnpm --filter @bedbanks/api test`, `pnpm --filter @bedbanks/admin test`.
- E2E (disposable DB): `booking-read` (isolation, masking, net, chips, filters), `booking-actions` (journey, permissions, CAS, idempotency, audit, manual entry), `booking-ops-role` (role boundary and narrow write grants), `booking-supplier` (queue, retries, ghost booking, unknown outcome, concurrency, crashed runner, mock gating).
- Browser: `tools/admin-ops-verify/verify-bookings.cjs` (list/detail) and `verify-booking-actions.cjs` (dialogs, manual entry) and `verify-booking-supplier.cjs` (queue with the runner on); see that folder's README. Start the API with `ADMIN_MANUAL_BOOKING_ENABLED=true` for the latter.
- Later phases will add: simulating supplier outcomes with the mock adapter behind `ADMIN_MANUAL_BOOKING_ENABLED`.

## Operations queue (Phase 4)

**Switches** (all default off, all independent): `ADMIN_BOOKING_OPS_ENABLED` shows the queue and the Operations panel; `ADMIN_SUPPLIER_JOBS_ENABLED` and `BOOKING_JOB_RUNNER_ENABLED` control supplier work; `ALLOW_MOCK_SUPPLIER` + `MOCK_SUPPLIER_TENANT_IDS` control the mock; `BOOKING_OPS_SLA_POLICY` (JSON) overrides SLA targets.

**Permissions** (formal roles only; owner membership implies none; granted to no role by the migration): `booking.ops.view` (queue, panel; also needs operator-level `booking.read`), `booking.ops.assign` (assign, unassign, acknowledge), `booking.ops.escalate` (raise priority, flag follow-up), `booking.ops.resolve` (record the supplier's answer, resolve a follow-up), `booking.ops.note`. `booking.supplier.retry` still governs send, cancel, retry now and sync.

**Reading the queue.** Tabs: Active, My queue, Unassigned, SLA breached, Due soon, Unknown supplier state, Cancellation issues, On request, Resolved / recent (activity in the last 7 days on a booking that is no longer a case). Filters live in the URL. The order is fixed by the server: priority, SLA state, oldest, id.

| Reason | Priority by default | SLA target (min) | Safe next step |
|---|---|---|---|
| Supplier answer unknown | Urgent | 15 | Sync with supplier (never send again) |
| Cancellation not confirmed by supplier | Urgent | 15 | Settle it with the supplier and record the outcome |
| Cancel requested | High | 60 | Send the cancellation, or record the supplier's answer |
| Supplier attempts exhausted | High | 30 | Record the supplier's answer |
| Supplier not configured | High | 60 | Record the supplier's answer |
| Pending supplier | Normal | 30 | Send to supplier, or retry now |
| On request | Normal | 1440 | Sync, or record the supplier's answer |
| Amendment requested | Normal | 240 | Review |
| Missing supplier reference | Normal | 240 | Add the reference |
| Manual follow-up | Normal | 480 | Follow up, then resolve |

Breached SLA, check-in within 24 hours, or three or more failed supplier calls each raise the priority one level (to a maximum of Critical).

**Runbook.**
1. *Supplier answer unknown:* the supplier may hold the booking. Do not send it again. Press **Sync with supplier** (safe to repeat). If the supplier cannot be reached by the system, ask them and record the answer: **confirmed** (with their reference), **rejected**, or **no booking exists** (with who told you and their reference: this is the only thing that makes sending again safe).
2. *Cancellation not confirmed:* the booking is still Cancel requested. Press **Sync**, or ask the supplier and record **cancelled** (with their cancellation reference) or **refused** (keeps it urgent). Nothing is marked cancelled on the supplier's silence.
3. *Two people on one case:* the second to act is told it changed; reload, and use **Take over** deliberately.
4. *Invalid SLA policy:* the queue answers 503 `BOOKING_OPS_SLA_POLICY_INVALID`; fix `BOOKING_OPS_SLA_POLICY`. The booking detail page keeps working without the Operations tab.

**Runtime-role grants.** The booking role (`fbeds_booking_ops`) gains SELECT and INSERT on `BookingOpsState` and UPDATE on its operational columns only. Re-run `ops:provision-booking-ops-role` after deploying. The strict API role has no access to it.

**Tests and harnesses.** Unit: `booking-ops-queue.spec.ts` (the ruleset, deterministic clock). E2E: `booking-ops-queue.e2e-spec.ts` (access, membership, ordering, SLA, assignment races, escalation, manual answers, supplier races), `booking-ops-role.e2e-spec.ts` (RLS and grants). Browser: `tools/admin-ops-verify/verify-booking-ops.cjs` (flows A to D).

## Money and documents (Phase 5)

**Permissions** (formal roles only, granted to no role by the migration): `booking.finance.view` (the Finance & documents tab; net cost also needs `booking.view.net`), `booking.documents.issue` (issue and view documents), `booking.penalty.waive.approve` (reduce a penalty; never the person who requested the cancellation). Deciding an undecided penalty needs `booking.cancel.nonrefundable`. Operator level only.

**Reading the tab.** *Money*: sell total, payment mode, refundability and the cancellation terms frozen with the booking. *Cancellation penalty*: before a cancellation, what cancelling now would cost; after, the penalty fixed at the request (Quoted), Decided or Waived, with the refund. *Documents*: each one issued once, with the reason when it is not available yet. *Money events*: the facts recorded, each "awaiting Finance booking".

| Situation | What the system does | What a person does |
|---|---|---|
| Confirmed with stored terms | Cancelling inside a rule window fixes the penalty from the rule when requested | Record the supplier's cancellation; issue invoice, credit note (sell - penalty), cancellation note |
| Non-refundable | Penalty = whole amount; no credit note is possible | Issue the cancellation note |
| No stored terms, or refundability unknown | Cancellation proceeds; penalty is "needs decision"; the credit note is withheld | Decide the penalty (`booking.cancel.nonrefundable`), then issue |
| Penalty too high | Quoted penalty stands | A second person with `booking.penalty.waive.approve` waives it down (before cancellation documents exist) |
| Voucher | Needs the hotel confirmation number; carries no net rate or supplier name | Issue, print |

**Not built:** notifications and webhooks (needs an email provider, per-tenant channels and signed delivery: an owner decision), ledger posting, no-show and amendment money, tax, agency-user document access. After deploying, the owner re-runs `ops:provision-booking-ops-role` (new grants). Browser check: `tools/admin-ops-verify/verify-booking-finance.cjs`.

## Booking query and saved views (Phase 6A/6B)

**One query.** Every list, view, and later bulk or export uses the same grammar (`BookingQueryV1`). Unknown fields are rejected (400, with every problem listed), values are validated, equal queries normalize identically, results are ordered deterministically (ties broken by id) and scoped to your tenant and, for agency users, your agency. Filters that expose a fact need the permission that shows it (guest: `booking.pii.view`; money event: `booking.finance.view`; operations owner: `booking.ops.view`). New filters: destination, source, currency with an amount range (minor units), operations owner, money event, last updated.

**Saved views.** Permissions (formal roles only, granted to no role by the migration): `booking.savedview.read`, `.create`, `.update.own`, `.delete.own`. A view is yours alone (no sharing, no administrator access), up to 50, with a unique name per person. Toolbar above the list: pick a view (it opens as the normal filtered list), **Save current view**, **Update view** (when you changed it), **Rename**, **Save as new view**, **Set as default / Remove default**, **Delete**, **Reset to system default**. A view whose filters the system no longer understands, or that uses something you may no longer use, is listed as "cannot be applied" and is never applied; you can rename or delete it. Your default view opens only when you arrive with no filters. After deploying, the owner re-runs `ops:provision-booking-ops-role` (one new table, and the role's only DELETE grant). Browser check: `tools/admin-ops-verify/verify-booking-views.cjs`.

## Bulk actions (Phase 6C)

Two actions on explicit booking ids, at most 100 per request: assign/change the operations owner and acknowledge. `POST /admin/operations/bookings/bulk-actions` (body `bookingIds`, `action`, `payload`, `idempotencyKey`), `GET /admin/operations/booking-bulk-actions/:id` (your own operations only). Permissions (formal roles only, granted to no role by the migration): `booking.bulk.assign`, `booking.bulk.acknowledge`, `booking.bulk.read`; each booking is still checked against `booking.ops.assign`. Bulk calls the single-booking services one booking at a time: a partial result is `PARTIAL` with a stable reason per booking, and retrying the same request (same key) returns the first result without applying anything twice. In the Bookings list, people with the capability see row checkboxes, a selected count, select-page, clear, a toolbar, a confirmation dialog and a result summary. No money, document or status change is possible, and there is no background job, export or notification. Deploying it: run the migration, re-run `ops:provision-booking-ops-role`, then grant the permissions to the right roles.

## Export, print, board and counter (Phase 6D)

**Export (Excel / CSV).** In the Bookings list, people with the permission see **Excel / CSV**. It downloads the current filtered list: the same rows, scope, masking and net visibility as the screen, at most **1,000 rows** (above that it tells you to narrow the filters; it never truncates). Permissions (formal roles only, granted to no role by the migration): `booking.export` (operator, all agencies) and `booking.export.agency` (own agency only). Every export is written to the audit log before the file is released (`booking.exported`; plus `booking.pii.exported` when guest names are unmasked); the log keeps which filters applied, not their values. Cells that would run as formulas in a spreadsheet are neutralised. The reconciliation-flag filter cannot be exported. After deploying, run the migration and grant the permissions to the right roles; no change to `ops:provision-booking-ops-role` is needed (the module reads the same tables as the list).

**Print.** **Print** opens the browser print dialog on the page as shown (A4 landscape; menus and controls hidden; a heading with the time and the applied filters). It prints the current page of the list or the board.

**Kanban.** The **Kanban** toggle (remembered per browser) shows one column per working status: On request, Pending supplier, Confirmed, Amend requested, Cancel requested, Failed. Your filters apply; a status filter narrows the columns. Each column shows its total and the first 25 (a link opens the full list for that status). Cards open the booking, where the action dialogs are. It is a read-only board: there is no drag-to-change-status.

**Counter.** The "N need action" button in the header opens the Needs action list. If the count cannot be read it is not shown.

**Tests.** Unit: `booking-export.spec.ts`; Admin `booking-export-ui.test.ts`, `booking-kanban-ui.test.ts`. E2E (disposable DB): `booking-export.e2e-spec.ts`. The screens themselves still need the browser harnesses in `tools/admin-ops-verify`.

## Scheduled Checked-out job (Phase 6E)

**What it does.** From the day after check-out, Confirmed bookings move to **Checked out** automatically (a Timeline entry by "System"). It never touches Cancelled, On request, Cancel requested, Amend requested, closed (locked) bookings, or a Confirmed booking with no check-out date, and it moves no money and sends nothing. If a person changes a booking at the same moment, theirs wins and the job skips it.

**Switches.** `BOOKING_LIFECYCLE_JOB_ENABLED=true` (default off) and `BOOKING_OPS_DATABASE_URL` (required; the job refuses to start without it). `BOOKING_LIFECYCLE_JOB_INTERVAL_MS` (default 3,600,000; minimum 60,000). Run it on one API instance or several: the move is compare-and-set, so two instances cannot move a booking twice.

**Deploying.** Run the migration, then re-run `ops:provision-booking-ops-role` (new EXECUTE grant on `fbeds_booking_checkout_due_tenants`), then set the two variables. Without the grant the job logs an access failure and moves nothing; it never falls back to another credential.

**Not built:** closing terminal bookings after the dispute window (the length is an open owner decision).

**Tests.** Unit: `booking-lifecycle-jobs.spec.ts`. E2E (disposable DB): `booking-lifecycle-jobs.e2e-spec.ts` (which bookings move, idempotency, the day boundary, two runners at once, the role boundary).

## Amendments (ADR 0072)

**What a person does.** On a Confirmed booking, **Request amendment** opens a form: new check-in and check-out, and adults, children and child ages per room. Only fields you change are sent. Change nothing and write the note, and it is a *free-text* request (guest names, special requests): the note goes to the supplier directly and approving it changes nothing by itself. A structured request moves the booking to **Amend requested**; the **Amendments** tab shows what was asked and the booking as it was.
The approver asks the supplier, then **Approve amendment** asks for the price the supplier confirmed (new sell total; optional net; optional free-cancellation deadline) and shows the difference in words before confirming. Approving applies the dates, nights, occupancy, price and deadline together, returns the booking to Confirmed with a new version, and records the difference as an amount **awaiting Finance booking** (Finance & documents tab). **Reject** leaves the booking exactly as it was and it can be amended again.

**What it does not do.** It charges and refunds nothing and posts nothing to the ledger. It does not reissue the voucher or invoice (the panel lists which were left as issued). It does not rename guests. The net and margin become unknown if the approver does not record them (or cannot see them), and the free-cancellation deadline becomes unknown if the dates moved and none was recorded.

**The ledger rule.** If the agency ledger holds anything for the booking (it was held or charged through the Agent flow), a **price-changing** approval is refused with "needs a ledger adjustment that is not built yet", and nothing changes. Reject it and agree the change with Finance, or approve it only if the price stays the same. This protects the cancellation settlement (ADR 0069), which refunds from the booking total. Manual and other non-ledger bookings are fully supported.

**Permissions** (unchanged, formal roles only): `booking.amend` (request, approve, reject), `booking.amend.request` (an agency user, own bookings, request only).

**Deploying.** Run migrations `202611250001` to `202611250003`, then **re-run `ops:provision-booking-ops-role`**: the booking role gains narrow UPDATE grants on the stay and price columns and the amendment table, and EXECUTE on `fbeds_booking_has_ledger_entries`. Without the re-run, a structured request answers 503 (not readable) rather than doing anything broader. No new environment variable.

**Tests.** Unit: `booking-amendment.spec.ts` (validation, integer money, deadline and net rules, idempotency fingerprint, the source-scan that confines the writes); Admin `booking-amendment-ui.test.ts`. E2E (disposable DB): `booking-amendment.e2e-spec.ts` (15 tests: request, approve increase and decrease, zero difference, reject, approval rules, free-text path, the ledger guard, invalid proposals, idempotency, concurrent approvals, permissions and agency scope, visibility of net, documents not reissued, the role boundary).

## Urgent badge on list rows (Phase 6F)

Rows (and Kanban cards) show a red **Urgent** or **Critical** badge for a booking that is an Urgent or Critical case in the Operations queue, using the same rules, SLA policy and clock, so the list and the queue cannot disagree. Hover for the reason and the SLA state. It is computed on every read and clears itself; nobody sets it by hand. High and Normal cases carry no badge. Only people who can see the queue (`booking.ops.view` with `ADMIN_BOOKING_OPS_ENABLED=true`) see it. If the queue cannot be evaluated (for example an invalid `BOOKING_OPS_SLA_POLICY`), the list still works and says "Urgent badges are not shown", which is not the same as "nothing is urgent". There is no "Only urgent" filter on the list; use the Operations queue. No migration, no new permission, no new grant.

**Tests.** Unit: `booking-urgency.spec.ts`; Admin `booking-ui.test.ts`. E2E (disposable DB): `booking-urgency.e2e-spec.ts` (verdict per row, caller without the permission, invalid policy, queue switched off).

