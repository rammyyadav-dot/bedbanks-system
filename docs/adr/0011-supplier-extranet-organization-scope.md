# ADR 0011: Supplier extranet organization scope

## Status
Accepted for the supplier extranet foundation. Inventory publication, booking, confirmation, payment, and live supplier connectors stay unavailable.

## Context
The supplier portal rendered an unauthenticated preview. `SupplyController` is an admin surface: it checks tenant membership and `supply.*` permissions, then queries every supplier in the tenant. Those permissions do not mean the user belongs to a supplier organization. Canonical hotels are tenant properties. A supplier sees a hotel only through `SupplierHotelMapping`. `RoomType` has no supplier id. `Contract` has no hotel id.

A draft must not edit live sellable inventory. Hotel and room master rows are shared, and a mapped room can already sit behind a rate.

## Decision
Extranet access is a `SupplierMembership` row connecting one user, one tenant, and one supplier organization, with status `ACTIVE`, `SUSPENDED`, or `REVOKED`. The user must also have an active tenant membership. Admin `supply.*` permissions do not create or imply this membership.

Every extranet request authenticates the opaque session, resolves the tenant with `TenantContextGuard`, then resolves the organization from active memberships in that tenant. `x-fbeds-supplier-id` only selects among those memberships. One membership may omit it. Several memberships without it are denied. A missing, suspended, revoked, or unknown organization is denied. Body and query identifiers are not authorization.

Hotels and rooms are read through mappings in `PENDING` or `MAPPED` for that supplier. Rejected mappings are hidden. A room is readable only when its hotel mapping passed that check in the same transaction. Unknown or out-of-scope ids return not found.

The only draft is `SupplierRoomDraft.supplierNotes`, a private note of 1–500 characters unique per tenant, supplier, and room. The write whitelists that field, refuses reassignment, and does not change hotel, room, rate, availability, or mapping rows. Publication and activation are not represented. The audit event `supplier.room_draft.updated` records the outcome, the request id, and the field name. It does not store the note.

Permissions are `supplier.extranet.hotels.read`, `supplier.extranet.rooms.read`, and `supplier.extranet.drafts.manage`.

Row-level security on memberships is tenant-scoped, because the organization is discovered from those rows. Draft policies require both the tenant and `app.current_supplier_id`. `PrismaService.withSupplier` sets both for one transaction. Admin supply continues to use `withTenant` only. Application queries still filter tenant, user, and supplier, including when the database owner bypasses row-level security.

The portal follows ADR 0010. Server code calls `API_INTERNAL_URL` and copies the API session cookie onto the supplier host. `fbeds_supplier_context` is an HttpOnly selector set only after the API accepts that organization. It is not a session and not authorization. Modules other than sign-in, the workspace, mapped hotels, mapped rooms, and this draft note render an explicit unavailable state.

## Consequences
- A supplier user with two organizations must choose one. The server checks that choice on every later request.
- Cross-organization isolation inside one tenant is an application invariant, not only a second tenant.
- Rollback is a later forward migration that drops `supplier_room_drafts`, `supplier_memberships`, the membership status enum, and the three extranet permissions. It must not drop suppliers, hotels, rooms, users, or tenants, and it must not edit this migration.
- The API runtime role may select memberships and insert or update draft notes. It still cannot update `Hotel` or read finance tables.
