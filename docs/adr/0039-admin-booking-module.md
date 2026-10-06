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
