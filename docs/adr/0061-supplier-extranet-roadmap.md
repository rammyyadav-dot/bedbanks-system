# ADR 0061: Supplier extranet roadmap and read-only contracts slice

## Status
Accepted for slice 1 (read-only contracts). Slices 2 onward are proposed and each needs its own accepted amendment before code.

## Context
ADR 0011 delivered organization-scoped hotels, rooms and a private note. `docs/supplier-extranet-cto-audit-2026-10-12.md` found the product gap (no reservations, availability, rates, finance) and four structural blockers: bookings have no supplier-organization link, contracts have no hotel, suppliers have no reviewable way to submit commercial changes, and response shapes were not shared contracts.

## Decision
1. **Slice 1 (accepted).** `GET /supplier/extranet/contracts` returns contract and rate-plan summaries (status, term, room, board, refundability, occupancy, currency, validity). It requires `supplier.extranet.contracts.read`, resolves the organization with `SupplierOrganizationGuard`, filters by tenant and supplier in the query inside `withSupplier`, hides contracts whose hotel mapping is `REJECTED`, and returns no amounts. It writes nothing, so it needs no idempotency key or audit event. The permission is not granted to any role by the migration.
2. **Response types live in `@bedbanks/contracts`** (`supplier-extranet.ts`). Existing hotel/room/context parsers migrate in a follow-up.
3. **Supplier writes to commercial data (proposed).** Suppliers never write `RatePlan`, `DailyRate`, availability or pools directly. They submit a versioned change set that is validated, reviewed, and applied through the existing admin supply services, keeping ADR 0057 four-eye control and the DRAFT-only guards. Amounts use integer minor units and ISO-4217 currency, transported as strings or bigint, never JS floats.
4. **Reservations (proposed).** Add a nullable, tenant-consistent `supplierId` to `Booking`, populated by an explicit connector-key-to-supplier mapping. No name matching. Supplier answers reuse the `booking-ops` supplier-answer path, are idempotent, and write an audit event.
5. **Membership lifecycle (proposed).** Invitation, suspension and revocation are audited API operations before any supplier user is onboarded outside operator tooling.

## Consequences
- No new table, column, grant, or runtime-role write. The API runtime role reads existing tables.
- Rollback: a later forward migration deletes the permission row after removing role assignments.
- Contracts without a mapping show "not linked to a hotel". That is accurate and not an error.
- Pagination is deferred; the route is capped at 200 contracts and 200 plans each, which a large DMC will hit. Slice 4 must add cursor pagination first.

## Amendment 1 (proposed): link bookings to a supplier organization (slice 2)

Status: **Accepted for slice 2** (CTO decisions recorded below, implemented in this change). D6 (supplier answers) remains slice 3 and is not implemented.

### What the code does today (verified in source)
- `Booking.supplier` is a plain string with no key. It is written as `'PENDING_SUPPLIER'` at creation (`booking-persistence.service.ts`) and `'contracted-inventory'` at confirmation (`booking-confirmation.service.ts`). It is neither a connector key nor a supplier id and must not be parsed as one.
- The booking-to-hold link exists only inside JSON: `Booking.searchSnapshot.inventoryHoldId`. `SupplierMutation` carries `bookingId` and `holdId` as real keys, but only for connector calls.
- `InventoryHold.ratePlanId` is a real column. `RatePlan → Contract.supplierId` is a real foreign key. So for **contracted inventory** a booking's owning organization is derivable without any name matching: booking → hold → rate plan → contract → supplier.
- Bookings from external connectors have no organization, and must stay that way.

### Decisions
- **D1 Column.** Add nullable `Booking.supplierId`, with a composite foreign key `(tenant_id, supplier_id) → Supplier(tenant_id, id)` and `ON DELETE RESTRICT` (never cascade away a booking). Null means "no supplier organization" (connector or legacy), shown to no extranet user.
- **D2 Source of truth.** Written once, in the same transaction that stores `inventoryHoldId`, from `hold.ratePlan.contract.supplierId`. Never from `Booking.supplier`, a display name, or request input. A database trigger rejects any later change to a non-null value.
- **D3 Backfill.** A forward migration fills existing contracted bookings from `searchSnapshot.inventoryHoldId` by joining hold → rate plan → contract, and only where the hold's tenant matches. Rows that cannot be derived stay null; the migration reports the count and does not guess. Backfill runs as a reviewed script/migration step with a dry-run count in the release notes.
- **D4 Index and isolation.** Index `(tenant_id, supplier_id, check_in)` and `(tenant_id, supplier_id, status)`. Extranet reads run under `withSupplier` and always filter tenant and supplier in the query; the policy on `Booking` is not widened. The runtime role gains no new write on `Booking`; the column is written by the existing booking role path.
- **D5 What a supplier may see.** Reference, status, hotel, room, board, dates, nights, rooms, the supplier's own **net** amount in integer minor units with currency, lead-guest name and party size, supplier reference. Never: agency identity, sell price, markup, FX rate, wallet or ledger data, other guests' contact details, `searchSnapshot`. Guest PII is not logged and not placed in audit payloads. Route: `GET /supplier/extranet/bookings` and `/bookings/:bookingId`, permission `supplier.extranet.bookings.read`, cursor-paginated, with response types in `@bedbanks/contracts` first.
- **D6 Answers (slice 3, separate amendment).** Accept / reject / on-request reuse the `booking-ops` supplier-answer path, require an idempotency key, create an immutable audit event, and are refused for bookings whose `supplierId` is not the caller's organization.

### Risks and open questions
- Netting: `Booking.netMinor` is booking level and nullable; per-room `BookingRoom.netMinor` may differ. Decide which one a supplier is shown, and show "not recorded" when null, never zero.
- A rate plan can move to another contract/supplier after booking. D2 freezes the organization at booking time, which is the intended behavior; document it for support.
- Multi-supplier carts do not exist today. If they appear, this column must become a per-room link.
- `Booking.supplier` stays as is. Cleaning it up is out of scope.

### Rollback
Forward migration: drop the trigger, indexes, foreign key and `supplier_id` column. No booking row is deleted. Extranet bookings routes must be removed first.

### Required tests before merge
Cross-organization booking returns 404; null-supplier booking invisible; update of a set `supplierId` is rejected; backfill leaves underivable rows null; response contains no sell price, markup or agency fields (shape assertion).

### CTO decisions (resolve the open questions above)
1. **Net is room level.** The supplier sees each room line's net. A booking-level figure is computed from the lines only when every line has a net **and** the sum equals the stored booking net where one exists; otherwise `netStatus` is `PARTIAL`, `NOT_RECORDED` or `MISMATCH` and no total is shown. The stored `Booking.net_minor` can only veto an aggregate; it is never shown on its own. A missing figure is "Not recorded", never zero.
2. **Ownership is frozen at booking creation** and never follows a later contract move (tested).
3. **One contracted supplier per booking** for the MVP: a booking has one hold, one rate plan, one contract. The column is on `Booking`; a future multi-supplier cart would add a per-room link and keep this column as the primary owner. Nothing here prevents that.
4. **Never inferred** from `Booking.supplier`, names or untrusted snapshot values. The write path reads the hold row and its rate plan/contract inside the tenant. The historical backfill uses the snapshot hold id only as a lookup key and requires the real hold to agree with the booking on hotel, dates, currency and amount.
5. **Connector, manual and ambiguous bookings stay null.**

### Decisions taken during implementation (not in the original proposal)
- **Database access.** The API runtime role previously had no `Booking` grant ("booking is disabled; finance-gated"). Slice 2 gives it **column-only SELECT** on `Booking`, `BookingRoom` and `BookingGuest` (migration `202611170002_strict_runtime_role_supplier_booking_reads`), so PostgreSQL itself refuses `total_minor`, `markup_minor`, `fx_rate`, `agency_id`, `search_snapshot`, `sell_minor`, guest contact/age columns and `SELECT *`. The alternative, reading through the booking-ops role, would have exposed the sell price to the supplier code path. The role gains **no write** on any booking table; `Booking.supplier_id` is written only by the booking creation path and the owner-run backfill. Three older guards that asserted "no booking grant at all" were tightened to "no write, no table-level read, named columns only".
- **Immutability** is a database trigger (`Booking_supplier_id_immutable`), so it holds for every role, not only this application.
- **Tenant consistency** is the composite foreign key `(tenant_id, supplier_id) -> Supplier(tenant_id, id)` with `ON DELETE RESTRICT`.
- **Backfill is a CLI, not a migration**: dry run by default, owner credential, per-tenant transaction that rolls back unless the result reconciles. Hiding an unreviewed multi-row data change inside a deploy-time migration was rejected.
- **Supplier isolation inside a tenant is an application filter** (`tenant_id` and `supplier_id` in every query, inside `withSupplier`) plus the column grants. Booking RLS remains tenant-only; a supplier-aware Booking policy is not added because the booking role shares the table. This is the same model ADR 0011 documents for hotels and rooms.
- **Net is not captured today.** The booking creation path writes `BookingRoom.sell_minor` only. Until a later slice stores the supplier net at booking time, contracted bookings show **Not recorded**. The slice does not invent a net from rates.

### Implementation matrix
| Requirement | Where | Evidence |
|---|---|---|
| Nullable, tenant-consistent `Booking.supplierId`, indexes, RESTRICT | `202611170001_booking_supplier_ownership` | migration applied + `prisma migrate diff` shows no drift; e2e "PostgreSQL safeguards" |
| Immutable once set | trigger `Booking_supplier_id_immutable` | e2e: change and clear both refused |
| Set in the hold/booking transaction | `BookingPersistenceService.persistPending` | unit (4 cases) + e2e against real PostgreSQL (incl. contract moved afterwards, cross-tenant rate plan fails closed) |
| Other creation paths | `BookingActionsService.createManual` (MANUAL, no hold) stays null by design; confirmation does not create bookings | grep of every `booking.create`; e2e "connector" fixture invisible |
| Backfill + report | `booking-supplier-backfill.ts`, `ops:backfill-booking-supplier` | e2e: dry run writes nothing, apply attributes 1 of 9 candidates, second run applies 0 |
| `GET /supplier/extranet/bookings` (+ detail) | `SupplierBookingsService`, controller | e2e: scope, pagination, filters, 404/403, no writes |
| Bounded pagination, stable order | keyset on (created_at desc, id desc), limit 1-50 | e2e: no gaps/repeats across pages incl. equal timestamps; limit 0/51 refused |
| Permission | `supplier.extranet.bookings.read` (granted to no role by the migration) | e2e: 403 without it |
| DTO minimality | `@bedbanks/contracts` `ExtranetBooking*`; column grants | e2e leak assertion over list, detail and error bodies; `runtime-role-contract.spec` forbidden-column test; 26 live privilege probes |
| Portal list, filters, detail, "Not recorded" | `apps/supplier/app/(portal)/bookings` | unit tests (format, filters), type-check, lint, `next build` |
