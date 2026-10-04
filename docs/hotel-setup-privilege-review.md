# Hotel Setup privilege review (ADR 0032 amendment)

Scope: the privileges migration `202610190001` added for the Hotel Setup journey, the tenant-integrity migration `202610200001` that closed a gap this review found, and the evidence for each. Everything was run on a disposable local PostgreSQL 16 cluster as the provisioned non-superuser, non-BYPASSRLS login role `fbeds_api_login` (setup used a separate owner connection the application never received). The authoritative definition is `apps/api/src/database/runtime-role-contract.ts`; the generated matrix is in [strict-runtime-db-role.md](strict-runtime-db-role.md).

## Finding closed by this review
As the runtime role in tenant A, an `INSERT` into `RoomAmenity` or `HotelAmenity` whose `hotel_id` / `room_type_id` named tenant **B**'s hotel or room was accepted: row-level security checks only the row's own `tenant_id`, and a foreign key is validated with the owner's rights, without comparing tenants. No data of tenant B was readable, but tenant A could create rows pointing into B (an existence oracle through foreign-key errors, and rows that B's cascading deletes would remove). The same pattern existed on `HotelProfile`, `HotelExternalIdentifier`, `HotelImage` and several tables written by P0.5 workflows (`CommercialMarkupRule`, `DistributionRestriction`, `AgencyMember`, `AgencyCreditLimit`, `ServiceCase`, `ServiceCaseNote`); only `InventoryPool` had a guard. Migration `202610200001` installs one generic guard, `fbeds_enforce_tenant_references()`, as a `BEFORE INSERT OR UPDATE OF` trigger on those tables (the parent must exist in the same tenant; it runs as the invoker, so under RLS an invisible parent is refused too) and narrows amenity `UPDATE` to `fee_type, updated_by_id, updated_at`, so a row's hotel, room and tenant are immutable for the role. `ServiceCase.booking_id` is not guarded: the role has no grant on `Booking`.

## The added privileges

| Privilege | Service and endpoint that needs it | Caller permission | Scope and RLS | Protected relationships and columns | Positive evidence | Negative evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `Hotel` INSERT | `SupplyService.createHotel`; `POST /supply/hotels` (Admin Add hotel) | `supply.hotels.manage` (checked in the service before the write; a refused mutation writes a `permission.denied` audit event with the request id) | Tenant. `Hotel_tenant_isolation`: `USING` and `WITH CHECK` `tenant_id = fbeds_current_tenant_id()`, forced | A row for another tenant fails `WITH CHECK`; `contentStatus: COMPLETE` is refused by the service (publication needs a second approver, ADR 0022/0023) | `W-09b`, browser journey | `HN-01` create hotel (401, 403, audit with request id), `HN-02` (insert for tenant B from tenant A context refused) |
| `Hotel` UPDATE, 11 columns: `name, property_type, country_code, city, address, latitude, longitude, time_zone, star_rating, content_status, updated_at` | `HotelSetupService.save/changeStatus`, `touchSetup` (amenities), `HotelPublicationService.execute`; `PATCH /admin/hotels/:id/setup`, `POST .../setup/status`, `PUT .../amenities`, `POST .../publication/:approvalId/execute` | `supply.hotels.manage`; publication execute by the requester after a different user approved | Same policy | `id`, `tenant_id`, `external_ref`, `created_at` are not updatable; DELETE is not granted | `W-06`, `W-07`, `W-09`, `W-09b` | `HN-03` (`external_ref`, `tenant_id`, `id`, `created_at`, DELETE refused), `SC-09`/`HN-07` (`external_ref` through the API is a typed 403 plus audit), `SC-10` |
| `RoomType` INSERT | `HotelRoomsService.create`; `POST /admin/hotels/:id/rooms` | `supply.rooms.manage` | Tenant through the room's hotel: `RoomType_tenant_isolation` `EXISTS (Hotel with this id and tenant_id = fbeds_current_tenant_id())` for `USING` and `WITH CHECK`, forced | A room cannot be created under another tenant's hotel (`WITH CHECK`) | `W-09b`, browser journey | `HN-01` create room, `HN-02` (insert under tenant B's hotel refused) |
| `RoomType` UPDATE, 8 columns: `name, code, max_adults, max_children, max_occupancy, bedding_metadata, is_active, updated_at` | `HotelRoomsService.update/archive/restore`; `PATCH .../rooms/:roomId`, `POST .../archive`, `POST .../restore` | `supply.rooms.manage` | Same | `id`, `hotel_id`, `created_at` are not updatable (a room cannot move hotel or tenant); DELETE is not granted (rooms are archived, never deleted) | `W-09b` (edit, archive, restore) | `HN-03` (`hotel_id`, `id`, `created_at`, DELETE refused; another tenant's room matches zero rows), `HN-01` edit/archive |
| `RoomAmenity` INSERT, DELETE, UPDATE of `fee_type, updated_by_id, updated_at` | `HotelRoomsService.replaceAmenities` (inside room create and edit) | `supply.rooms.manage` | Tenant. `RoomAmenity_tenant_isolation`, forced; composite foreign key `(hotel_id, room_type_id)` to `RoomType`; same-tenant guard (new) | `room_type_id`, `hotel_id`, `tenant_id` are immutable for the role; a row cannot point at another tenant's hotel or room (guard) | `W-09b`, `W-11` coverage | `HN-02` (insert referencing tenant B's hotel/room refused), `HN-03` (reassignment refused, other tenant's rows untouched), `HN-06` (a revoked grant rolls the whole room create back) |
| `HotelAmenity` UPDATE narrowed to `fee_type, updated_by_id, updated_at` (INSERT and DELETE unchanged) | `HotelAmenitiesService.replace`; `PUT /admin/hotels/:id/amenities` | `supply.hotels.manage` | Tenant, forced, guard | `hotel_id`, `tenant_id` immutable | `W-07` | `HN-02`, `HN-03` |

## Other properties verified

| Property | Evidence |
| --- | --- |
| Hotel DELETE stays prohibited; `external_ref` updates stay privileged; Hotel UPDATE stays on the 11 columns | `HN-03`, `SC-10`; `SR-02/04/05` compare the catalog with the contract in both directions (extra and missing privileges) |
| No broad table `UPDATE` replaced a column-level grant | The verifier distinguishes table-level from column-level privileges (`SR-05`); `Hotel`, `RoomType`, both amenity tables and `users`/`sessions` are column-level only |
| Provisioning and the migrations produce the same final privileges | `SR-02` (migrations alone equal the contract on replay and upgrade), `SR-03`, `SR-04` (provisioned state equals the contract; re-running changes nothing), and the contract spec regenerates the migration SQL from the contract |
| Forced RLS on every writable tenant table; guard triggers installed; the login role has no elevated attribute | `SR-08` on the replay and the upgrade database |
| The role cannot grant itself access, switch role, create roles or DDL, disable or bypass RLS | `HN-05` (`SET ROLE`, `ALTER ROLE ... BYPASSRLS/SUPERUSER`, `CREATE ROLE`, `DISABLE ROW LEVEL SECURITY`, `DROP POLICY`, `CREATE TABLE`, `row_security = off` all refused; a self `GRANT` has no effect) |
| Missing tenant context fails closed; a pooled connection never leaks context | `HN-04` (zero rows and a refused insert without context; one pooled backend alternated across tenants and no context, including after an aborted transaction) |
| Failed mutations leave no partial data | `HN-06` (room create rolled back when the amenity insert is refused; setup save rolled back when the profile update is refused; validation failure writes nothing) |
| Denial audits keep the request id | `HN-01` (`permission.denied` carries the response's request id for guard-based routes and for the supply service), `HN-07` (`runtime_role.operation_prohibited`) |
| Infrastructure grant mismatch is never a user-policy 403 | `HN-06` and `SC-13`: grant drift is a sanitized 503 `DATABASE_ROLE_NOT_PERMITTED`; only an operation the contract never grants is the typed 403 `RUNTIME_ROLE_OPERATION_PROHIBITED` |

## Maker-checker publication on the strict role

| Rule | Test |
| --- | --- |
| The requester cannot approve their own request; a second authorized user can; a user without the permission, another tenant and another hotel's approval are refused | `MC-01`, `W-09` |
| An edit after submission blocks approval (`HOTEL_CHANGED_AFTER_REQUEST`); a new request is required | `MC-02` |
| Concurrent approvals decide once (a repeat by the same approver is an idempotent replay) with one audit event; concurrent executions publish once with one audit event; the approval row, the hotel status and the audit trail agree | `MC-03` |
| `COMPLETE` means profile completeness only: no rate plan, hold, booking or supplier mutation exists and the booking gate is unchanged | `MC-04` |

No new approval model was introduced: the existing `ApprovalService` is used unchanged.

## Not covered here
Production-clone compatibility, persistent role provisioning and hosted monitoring remain owner-controlled release gates. Prerequisites are in `docs/clone-certification-runner.md` and `docs/postgres-release-controls.md`.
