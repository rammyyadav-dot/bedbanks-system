# Supplier extranet bookings — Slice 2 (ADR 0061 Amendment 1)

Read-only. No supplier accept/reject, no payments, no connector calls, no deployment. Read with `docs/adr/0061-supplier-extranet-roadmap.md`.

## 1. What shipped

| Piece | Location |
|---|---|
| `Booking.supplier_id`, composite tenant FK (RESTRICT), 3 indexes, immutability trigger | `apps/api/prisma/migrations/202611170001_booking_supplier_ownership` |
| Column-only SELECT on `Booking`, `BookingRoom`, `BookingGuest` for the API runtime role | `runtime-role-contract.ts`, applied by `ops:provision-api-runtime-role` (SR-07: migrations never grant runtime privileges) |
| Permission `supplier.extranet.bookings.read` | `…/202611170002_supplier_extranet_bookings_permission` |
| Ownership frozen at creation | `BookingPersistenceService.persistPending` |
| Historical backfill + reconciliation report | `src/database/booking-supplier-backfill.ts`, `pnpm --filter @bedbanks/api ops:backfill-booking-supplier` |
| API | `GET /supplier/extranet/bookings`, `GET /supplier/extranet/bookings/:bookingId` |
| Contracts | `packages/contracts/src/supplier-extranet.ts` |
| Portal | `apps/supplier/app/(portal)/bookings` (list, filters, detail) |

## 2. Join chain, verified against source
`Booking.searchSnapshot.inventoryHoldId` (written server-side by `immutableSnapshot`) → `InventoryHold.ratePlanId` (real column) → `RatePlan.contractId` → `Contract.supplierId` (real FK). At creation the hold row itself is read in the same transaction (`persistPending`), so the snapshot is not consulted. `Booking.supplier` holds `PENDING_SUPPLIER` / `contracted-inventory` and is never read for ownership.

Creation paths found (`grep booking.create`): `BookingPersistenceService.persistPending` (Agent portal, has a hold: sets ownership) and `BookingActionsService.createManual` (channel `MANUAL`, no hold: stays null by design). Confirmation (`BookingConfirmationService`) updates an existing booking and does not create one; it does not touch `supplier_id`.

Conflicts with existing changes: none in the merge sense. Three earlier guard tests asserted "the API role has no booking grant at all"; they were tightened, not removed (see ADR amendment). The generated privilege matrix in `docs/strict-runtime-db-role.md` was regenerated.

## 3. Rollout order (all owner-run, none performed by this change)
1. `prisma migrate deploy` (owner). Additive; no existing row changes. Then `ops:provision-api-runtime-role` (owner, idempotent) to apply the column grants; `ops:strict-role-rollout status|verify` reports any drift. Until it runs, the bookings routes fail closed with a database permission error.
2. Grant `supplier.extranet.bookings.read` to the intended supplier roles through the normal role path. Nothing is granted automatically.
3. Dry run: `MIGRATION_DATABASE_URL=… pnpm --filter @bedbanks/api ops:backfill-booking-supplier` (add `--allow-remote --confirm-database=<name>` for a remote target). Review the JSON: the counts per reason, the `samples` ids of skipped bookings, and `reconciliation`.
4. Only after review: repeat with `--apply` (optionally `--tenant=<id>`). Each tenant is one transaction, updates only rows where `supplier_id IS NULL`, re-classifies, and rolls that tenant back if `applied` ≠ attributable or the after-counts do not add up. Exit code 2 if the report does not reconcile.
5. Deploy the API, then the supplier portal.

Rollback: stop the routes (do not grant the permission), then a later forward migration drops the trigger, indexes, FK and column (steps in the migration header) and revokes the column grants. No booking is deleted. Historical ownership is never rewritten: the trigger forbids it.

## 4. Backfill rules (a booking is attributed only if every line holds)
supplier_id is null · channel is `PORTAL` · snapshot names exactly one hold and no other booking in the tenant names the same hold · the hold exists in the same tenant and agrees on hotel, check-in, check-out, currency and amount · any `SupplierMutation` for the booking names the same hold · hold → rate plan → contract → supplier all resolve in the tenant. Everything else is counted under a `skip_*` reason and left null. Report categories: `already_attributed`, `attributable`, `skip_non_portal_channel`, `skip_no_hold_reference`, `skip_hold_referenced_by_multiple_bookings`, `skip_hold_not_found_in_tenant`, `skip_hold_disagrees_with_booking`, `skip_supplier_mutation_hold_conflict`, `skip_rate_plan_not_found`, `skip_contract_not_found`, `skip_supplier_not_found`. The report contains counts and booking ids only (no reference, guest or amount).

## 5. Security review

| Threat | Control | Verified by |
|---|---|---|
| Tenant taken from client | Tenant from the session via `TenantContextGuard`; header is checked against memberships | e2e: wrong-tenant header → 403 for a supplier user |
| Supplier chosen by client | `SupplierOrganizationGuard`: header only selects among the caller's own ACTIVE memberships; query/body/cursor never carry scope; unknown query params refused (`forbidNonWhitelisted`) | e2e: `x-fbeds-supplier-id` of another org → 403; `supplierId`/`tenantId` params → 400; forged cursor naming another supplier/tenant returns nothing foreign |
| Cross-supplier read in one tenant | Every query filters `tenantId` **and** `supplierId`, inside `withSupplier`; detail by id is `findFirst({id, tenantId, supplierId})` | e2e: supplier 2 cannot list or open supplier 1's booking, and vice versa |
| Cross-tenant read | Forced tenant RLS on all three tables + the filter above | e2e: tenant B user sees only tenant B; tenant A booking id → 404 |
| Unattributed (connector/manual/ambiguous) bookings exposed | `supplier_id = <caller>` never matches null | e2e: connector booking absent from lists, 404 by id |
| Authentication ≠ authorization | `supplier.extranet.bookings.read` checked on every call; membership alone is not enough | e2e: member with hotels-read only → 403 |
| Sell price / markup / FX / agency / wallet / snapshot leak, including nested DTOs and errors | (1) DTO whitelist built field by field, no spread of the row; (2) **PostgreSQL column grants** make those columns unreadable to the API role; (3) the select lists name only granted columns | e2e asserts none of the planted secret values or key names appear in list, detail, 403 and 404 bodies; DB probes: `total_minor`, `markup_minor`, `fx_rate`, `agency_id`, `search_snapshot`, `BookingRoom.sell_minor`, `BookingGuest.age`, `SELECT *` are all `permission denied`; `runtime-role-contract.spec` fails if a forbidden column is ever added |
| Guest PII | Only the lead guest's first and last name; no contact, age, room link. Not logged; not in audit payloads | grant list; code review |
| Ownership rewritten / reassigned | Trigger forbids change or clear once set; no runtime write privilege on booking tables | e2e + DB probes (`UPDATE Booking.supplier_id`, `INSERT Booking`, `DELETE BookingRoom` denied) |
| Misattribution across tenants | Composite FK `(tenant_id, supplier_id)` | e2e: setting a tenant B supplier on a tenant A booking is refused |
| Supplier deletion orphaning/erasing bookings | `ON DELETE RESTRICT` | e2e: deleting a supplier that owns bookings is refused |
| Ambiguous history attributed by guess | Conservative backfill, per-tenant reconciliation, rollback on mismatch | e2e: 8 ambiguous legacy bookings stay null |
| Write through the read endpoints | Controller exposes GET only | e2e: PATCH/POST on the booking path → 404 and no row changes |
| Existence oracle | One message, `Booking not found`, for foreign, unattributed and unknown ids | e2e |
| Injection through filters | class-validator patterns on reference/dates/status; Prisma parameterisation; backfill takes only tenant id as a bind parameter | e2e + DTO unit tests |
| Unbounded reads | limit ≤ 50 (default 25); take limit+1; rooms/guests queried only for the page ids | e2e + DTO tests |

Not covered, by design: supplier-aware RLS on `Booking` (shared with the booking role; application filter plus column grants instead), read auditing of guest names (no invariant requires it; reconsider if suppliers get guest contact data), rate limiting beyond the global limits, MFA.

## 6. Known limitations
1. **Net is not captured at booking time.** The creation path stores `BookingRoom.sell_minor` only. Every contracted booking therefore shows net as **Not recorded** until a slice stores the supplier net per room at creation. This is the main gap for the "room-level net" requirement: the plumbing, reconciliation rules and UI are done and tested with fixture data, but there is no production data to show yet.
2. Booking creation itself is gated off in this deployment ("booking is disabled"); ownership therefore applies to new bookings only once booking is enabled, and the backfill covers what exists.
3. The booking status shown is the platform status; supplier-side statuses and SLA clocks are slice 3.
4. Hotel name is shown even if the hotel's mapping for the supplier was later rejected (the booking is the supplier's own).
5. One supplier per booking; a multi-supplier cart would need a per-room owner.
6. The older single `Booking.supplier` string is untouched.

## 7. Slice 3 prerequisites (supplier answers: accept / reject / on request)
- Store supplier net per room at creation (limitation 1) so answers and invoices reconcile.
- ADR amendment for the answer state machine, reusing the `booking-ops` supplier-answer path and `transitionBooking`; per-answer idempotency key, audit event, optimistic version.
- A booking-role write path for the extranet (the API role must stay write-less on booking tables) or a dedicated narrow role, with column-level UPDATE grants and its own strict-role e2e.
- Notification and SLA design; supplier-side status vocabulary.
- Decision on guest contact data visibility and read auditing.
