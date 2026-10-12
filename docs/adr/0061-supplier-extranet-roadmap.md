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

Status: **Proposed.** No code or migration accompanies it. Decisions D1–D6 need owner sign-off first.

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
