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
