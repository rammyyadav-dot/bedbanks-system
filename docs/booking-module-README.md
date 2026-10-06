# Admin Booking module — running it locally (Phases 1 and 2)

Source of truth: `docs/booking-module-spec.md`. Decisions: `docs/adr/0039-admin-booking-module.md`.

## What exists after Phase 1
- Ten-value `BookingStatus`, promoted booking columns, `BookingRoom` / `BookingGuest` / `BookingEvent` (append-only), backfilled per tenant by migration.
- Read-only list (`GET /api/v1/admin/operations/bookings`) and detail (`.../bookings/:id`, id or `FB-` reference), Admin pages `/bookings` and `/bookings/[id]`.
- Phase 2 adds the lifecycle engine: named actions (confirm/reject on request, amend, cancel, no-show, close, edit references) through `transitionBooking`, the one writer of `Booking.status`; every change leaves a `BookingEvent` and an `AuditEvent`. See ADR 0039 (Phase 2 decisions) for the action table, permissions and what is deliberately not built yet.
- Manual booking entry (`/bookings/new`) is behind `ADMIN_MANUAL_BOOKING_ENABLED` (default `false`; dev/staging only). It records a Pending-supplier booking; no supplier call, hold or money movement.
- Still no supplier call, payment, voucher or invoice from this module.
- `BOOKING_ENABLED` stays `false`; Agent booking routes stay `booking_unavailable`.

## Run it
1. Disposable DB only: `DATABASE_URL=postgresql://…/fbeds_ci` then `pnpm --filter @bedbanks/api exec prisma migrate deploy` (never `migrate dev` / `db push`).
2. Provision the limited booking role (owner-run, idempotent; never done by the app):
   `pnpm --filter @bedbanks/api ops:provision-booking-ops-role` — creates group `fbeds_booking` and login `fbeds_booking_ops`: SELECT on `Booking`, `BookingRoom`, `BookingGuest`, `BookingEvent`, `SupplierMutation`; INSERT on the four booking tables and `AuditEvent`; UPDATE on named `Booking` columns only. **Re-run it after upgrading to Phase 2**, or write routes answer 503.
3. Set `BOOKING_OPS_DATABASE_URL` to that login. It must differ from `DATABASE_URL`. If it is missing or the role is absent the screens show the existing "not readable" 503 — there is no fallback to the API role.
4. Seed ~40 demo bookings (all ten statuses, four agencies, five hotels, USD/GBP/EUR/AED, some Urgent-like, some missing a supplier ref, some Unassigned):
   `cd apps/api && NODE_ENV=test node --no-experimental-strip-types -r @swc-node/register ../../tools/admin-ops-verify/seed-bookings.ts` (refuses anything but `fbeds_ci` / `p0N_*`). Credentials are written to `tools/admin-ops-verify/.seed-bookings.json`: `ops` (booking.read), `opsall` (+ pii + net), `agency` (booking.view.agency, one agency).
5. Run API and Admin as usual and open `/bookings`.

## Permissions (formal roles only, never owner-implied)
`booking.read` (operator list/detail), `booking.view.agency` (own agency only), `booking.pii.view` (unmasked guests + guest search, audited), `booking.view.net` (net/markup/margin).
Phase 2 actions: `booking.confirm.manual`, `booking.on-request.resolve`, `booking.amend`, `booking.amend.request`, `booking.cancel` (existing), `booking.cancel.request`, `booking.cancel.nonrefundable`, `booking.no-show.mark`, `booking.rebook`, `booking.supplier-ref.edit`, `booking.manual.create`. An operator also needs `agency.read` and `supply.hotels.read` to use the manual-entry pickers. Seeded users: `ops` (read), `opsall` (read + pii + net), `lead` (every action), `agency` (own agency, read), `requester` (own agency, request cancel/amend).

## Tests
- Unit: `pnpm --filter @bedbanks/api test`, `pnpm --filter @bedbanks/admin test`.
- E2E (disposable DB): `booking-read` (isolation, masking, net, chips, filters), `booking-actions` (journey, permissions, CAS, idempotency, audit, manual entry), `booking-ops-role` (role boundary and narrow write grants).
- Browser: `tools/admin-ops-verify/verify-bookings.cjs` (list/detail) and `verify-booking-actions.cjs` (dialogs, manual entry); see that folder's README. Start the API with `ADMIN_MANUAL_BOOKING_ENABLED=true` for the latter.
- Later phases will add: simulating supplier outcomes with the mock adapter behind `ADMIN_MANUAL_BOOKING_ENABLED`.
