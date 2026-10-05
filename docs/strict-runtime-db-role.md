# Strict Runtime DB Role

Decision record: [ADR 0032](adr/0032-explicit-runtime-write-set.md) (builds on [ADR 0008](adr/0008-api-runtime-role.md), [ADR 0013](adr/0013-admin-operations-api.md) and [ADR 0031](adr/0031-strict-runtime-role-and-commercial-control-failure.md)). Everything here was run on disposable local PostgreSQL 16 clusters with generated credentials. No persistent database, role, deployment, DNS or alias was touched.

## 1. The role

| | |
| --- | --- |
| Group role | `fbeds_api` (NOLOGIN) |
| Login role | `fbeds_api_login` (member of the group; password only in the deployment's secret store, 32 to 128 URL-safe characters) |
| Attributes | NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION; owns nothing; member of no other role |
| Config source | `DATABASE_URL` of the API process. Migrations and provisioning use a separate owner connection that the API process never receives |
| Used by | Every HTTP request of the API process (Agent, Admin, Supplier): `PrismaService`, one principal. The hold-expiry sweeper uses the separate `fbeds_hold_expiry_login` (ADR 0005) |
| Provisioned by | `pnpm --filter @bedbanks/api ops:provision-api-runtime-role` (owner only; `REVOKE ALL` then exactly the contract) |
| Verified by | `verifyApiRuntimeRole` while connected as the login role: attributes, ownership, forbidden tables, and a catalog comparison of every read and every write (table and column level) with the contract |

## 2. Three enforcement layers

> Application RBAC, PostgreSQL privileges, and row-level security are three separate enforcement layers. Passing one does not imply passing the others.

1. **Application RBAC.** Guards and per-service permission checks decide whether this user may ask for the operation at all (401, 403 `FORBIDDEN`, 404 for another tenant's resource). They run before any statement reaches the database. They know nothing about grants.
2. **PostgreSQL privileges.** `fbeds_api` may run only the statements in the matrix below. A privilege is a ceiling for the whole API process, not a permission for a user: holding `INSERT` on `Agency` does not let an unauthorized user create an agency, and an authorized user still cannot make the role do what it was never granted.
3. **Row-level security.** Every table in the matrix except `users` and `sessions` (authentication) has forced RLS on `tenant_id` through `fbeds_current_tenant_id()`, read from the transaction-local `app.current_tenant_id` set by `withTenant`. A SQL grant never widens it: a runtime-role write for another tenant fails the RLS check, an update of another tenant's row matches zero rows, and with no tenant context nothing is readable or writable. Tested on the real role (W-10, SC-11).

## 3. Privilege matrix (generated)

Generated from `apps/api/src/database/runtime-role-contract.ts`, the only place a grant is defined. Regenerate with `pnpm --filter @bedbanks/api ops:render-runtime-role-doc`; a spec fails if this block drifts.

<!-- BEGIN GENERATED: runtime-role-matrix -->
| Table | SELECT | INSERT | UPDATE | DELETE | RLS | Writer (service, endpoints) and reason |
| --- | :-: | :-: | :-: | :-: | --- | --- |
| `Agency` | yes | yes | yes | - | forced tenant | INSERT: ClientsService.create; POST /admin/clients/agencies; create an agency / UPDATE: ClientsService.update; AgencySuspensionService.execute; PATCH /admin/clients/agencies/:agencyId, POST /admin/clients/agencies/suspension-approvals/:approvalId/execute; edit an agency; apply an approved suspension change |
| `AgencyCreditLimit` | yes | yes | yes | yes | forced tenant | INSERT: AgencyCreditService.execute; POST /admin/clients/agencies/credit-approvals/:approvalId/execute; set the first credit limit after approval / UPDATE: AgencyCreditService.execute; POST /admin/clients/agencies/credit-approvals/:approvalId/execute; change the limit after approval / DELETE: AgencyCreditService.execute; POST /admin/clients/agencies/credit-approvals/:approvalId/execute; remove the limit after approval |
| `AgencyMember` | yes | yes | - | yes | forced tenant | INSERT: ClientsService.addMember; POST /admin/clients/agencies/:agencyId/members; attach a user to an agency / DELETE: ClientsService.removeMember; DELETE /admin/clients/agencies/:agencyId/members/:userId; detach a user from an agency |
| `ApprovalRequest` | yes | yes | yes | - | forced tenant | INSERT: ApprovalService.request; POST /admin/commercial/markups/:ruleId/request-activation, POST /admin/clients/agencies/:agencyId/request-suspension-change, POST /admin/clients/agencies/:agencyId/request-credit-limit, POST /admin/hotels/:hotelId/setup/publication/request; maker-checker request (ADR 0016) / UPDATE: ApprovalService.decide/cancel/execute; POST .../approvals/:approvalId/{approve,reject,cancel,execute}; record the decision and the execution |
| `AuditEvent` | yes | yes | - | - | forced tenant | INSERT: AuditService and the RBAC guards; every mutation and every denial; immutable audit trail (INSERT only: no UPDATE or DELETE) |
| `BoardBasis` | yes | - | - | - | forced tenant | read only |
| `CancellationPolicy` | yes | - | - | - | forced tenant | search and recheck include each contract's cancellation terms |
| `CommercialMarkupRule` | yes | yes | yes | - | forced tenant | INSERT: CommercialMarkupService.create; POST /admin/commercial/markups; draft a markup rule / UPDATE: CommercialMarkupService.retire/execute; POST /admin/commercial/markups/:ruleId/retire, POST /admin/commercial/markups/approvals/:approvalId/execute; activate or retire a rule (rules are otherwise immutable) |
| `Contract` | yes | - | - | - | forced tenant | read only |
| `DailyAvailability` | yes | - | - | - | forced tenant | read only |
| `DailyRate` | yes | - | - | - | forced tenant | read only |
| `DistributionRestriction` | yes | yes | yes | - | forced tenant | INSERT: DistributionService.create; POST /admin/distribution/restrictions; restrict a hotel or supplier for an agency / UPDATE: DistributionService.retire; POST /admin/distribution/restrictions/:restrictionId/retire; retire a restriction |
| `Hotel` | yes | yes | cols (11) | - | forced tenant | INSERT: SupplyService.createHotel; POST /supply/hotels (Admin "Add hotel"); create a draft hotel, the first step of the setup journey (publication stays a separate maker-checker step) / UPDATE (name, property_type, country_code, city, address, latitude, longitude, time_zone, star_rating, content_status, updated_at): HotelSetupService.save/changeStatus; touchSetup (amenities); HotelPublicationService.execute; PATCH /admin/hotels/:hotelId/setup, POST /admin/hotels/:hotelId/setup/status, PUT /admin/hotels/:hotelId/amenities, POST /admin/hotels/:hotelId/setup/publication/:approvalId/execute; the profile workflows also stamp or change the hotel row (details, status, updated_at stale-token) |
| `HotelAmenity` | yes | yes | cols (3) | yes | forced tenant | INSERT: HotelAmenitiesService.replace; PUT /admin/hotels/:hotelId/amenities; add an amenity / UPDATE (fee_type, updated_by_id, updated_at): HotelAmenitiesService.replace; PUT /admin/hotels/:hotelId/amenities; change an amenity fee type (upsert); the hotel it belongs to cannot be reassigned / DELETE: HotelAmenitiesService.replace; PUT /admin/hotels/:hotelId/amenities; remove an amenity |
| `HotelExternalIdentifier` | yes | yes | - | yes | forced tenant | INSERT: HotelSetupService.save; PATCH /admin/hotels/:hotelId/setup; add an external identifier / DELETE: HotelSetupService.save; PATCH /admin/hotels/:hotelId/setup; remove or replace an identifier (a changed value is delete plus insert, so no UPDATE) |
| `HotelImage` | yes | yes | yes | yes | forced tenant | INSERT: HotelImagesService.upload; POST /admin/hotels/:hotelId/images; upload an image / UPDATE: HotelImagesService.update/reorder; PATCH /admin/hotels/:hotelId/images/:imageId, PUT /admin/hotels/:hotelId/images/order; edit, reorder, choose the primary image / DELETE: HotelImagesService.remove; DELETE /admin/hotels/:hotelId/images/:imageId; delete an image |
| `HotelProfile` | yes | yes | yes | - | forced tenant | INSERT: HotelSetupService; touchSetup; HotelPublicationService; PATCH /admin/hotels/:hotelId/setup, POST /admin/hotels/:hotelId/setup/status, PUT /admin/hotels/:hotelId/amenities; first save of a hotel profile / UPDATE: HotelSetupService; touchSetup; HotelPublicationService; PATCH /admin/hotels/:hotelId/setup, POST /admin/hotels/:hotelId/setup/status, PUT /admin/hotels/:hotelId/amenities, POST /admin/hotels/:hotelId/setup/publication/:approvalId/execute; save the profile, bump its version, stamp the approver |
| `HotelSearchIndex` | yes | - | - | - | forced tenant | read only |
| `InventoryHold` | cols (4) | - | - | - | forced tenant | SELECT (id, tenant_id, rate_plan_id, status): per-plan pool consumption report only (ADR 0036): rate plan and status of a hold; no guest, money, offer or user column |
| `InventoryHoldNight` | cols (5) | - | - | - | forced tenant | SELECT (tenant_id, hold_id, pool_day_id, counter_kind, quantity): per-plan pool consumption report only (ADR 0036): the recorded pool-night reference and quantity; no stay date or availability reference |
| `InventoryPool` | yes | - | - | - | forced tenant | pool writes are a privileged path: a pool change also needs RatePlan and DailyAvailability writes |
| `InventoryPoolDay` | yes | - | cols (2) | - | forced tenant | UPDATE (capacity, updated_at): PoolCapacityService.apply; POST /admin/hotels/:hotelId/inventory/pools/:poolId/capacity/apply; set existing-night capacity with sold + held floor; preserve provenance and freshness. Quick Update provenance writes remain privileged |
| `memberships` | yes | - | - | - | forced tenant | also readable by the transaction-local app.current_user_id before a tenant is chosen (ADR 0008) |
| `Permission` | yes | - | - | - | none (auth) | read only |
| `RatePlan` | yes | - | - | - | forced tenant | read only |
| `Role` | yes | - | - | - | forced tenant | read only |
| `RolePermission` | yes | - | - | - | forced tenant | read only |
| `RoomAmenity` | yes | yes | cols (3) | yes | forced tenant | INSERT: HotelRoomsService.replaceAmenities; POST /admin/hotels/:hotelId/rooms, PATCH /admin/hotels/:hotelId/rooms/:roomId; record a room amenity / UPDATE (fee_type, updated_by_id, updated_at): HotelRoomsService.replaceAmenities; PATCH /admin/hotels/:hotelId/rooms/:roomId; change an amenity fee type (upsert); the room it belongs to cannot be reassigned / DELETE: HotelRoomsService.replaceAmenities; PATCH /admin/hotels/:hotelId/rooms/:roomId; remove an amenity from a room |
| `RoomType` | yes | yes | cols (8) | - | forced tenant | INSERT: HotelRoomsService.create; POST /admin/hotels/:hotelId/rooms; add a canonical room to a hotel (publication needs one active room) / UPDATE (name, code, max_adults, max_children, max_occupancy, bedding_metadata, is_active, updated_at): HotelRoomsService.update/archive/restore; PATCH /admin/hotels/:hotelId/rooms/:roomId, POST /admin/hotels/:hotelId/rooms/:roomId/archive, POST /admin/hotels/:hotelId/rooms/:roomId/restore; edit, archive or restore a room (rooms are never deleted) |
| `ServiceCase` | yes | yes | yes | - | forced tenant | INSERT: ServiceCasesService.create; POST /admin/service/cases; open a case / UPDATE: ServiceCasesService.transition/assign; POST /admin/service/cases/:caseId/transition, POST /admin/service/cases/:caseId/assign; move or assign a case |
| `ServiceCaseNote` | yes | yes | - | - | forced tenant | INSERT: ServiceCasesService.addNote/transition/assign; POST /admin/service/cases/:caseId/notes; append a note (notes are immutable) |
| `sessions` | yes | yes | cols (2) | - | none (auth) | INSERT: AuthService.login; POST /auth/login; create the opaque session (ADR 0001) / UPDATE (last_seen_at, revoked_at): AuthService (session guard, logout); every authenticated route, POST /auth/logout; slide and revoke the session |
| `Supplier` | yes | - | - | - | forced tenant | read only |
| `supplier_memberships` | yes | - | - | - | forced tenant | read only |
| `supplier_room_drafts` | yes | yes | yes | - | forced tenant | INSERT: SupplierExtranetService.upsertRoomDraft; PATCH /supplier/extranet/hotels/:hotelId/rooms/:roomId/draft; supplier room-note drafts (ADR 0011) / UPDATE: SupplierExtranetService.upsertRoomDraft; PATCH /supplier/extranet/hotels/:hotelId/rooms/:roomId/draft; edit an own draft |
| `SupplierHotelMapping` | yes | - | - | - | forced tenant | read only |
| `SupplierRoomMapping` | yes | - | - | - | forced tenant | read only |
| `tenants` | yes | - | - | - | none (auth) | read only |
| `UserRole` | yes | - | - | - | forced tenant | read only |
| `users` | yes | - | cols (2) | - | none (auth) | UPDATE (last_login_at, updated_at): AuthService.login; POST /auth/login; record the last successful sign-in |

Privileged paths (written by the API process somewhere, never by the runtime role):

- `BoardBasis`: supply authoring
- `Booking`: booking is disabled; finance-gated
- `BookingDocument`: booking is disabled
- `BookingLeadTimeRule`: supply authoring
- `Cancellation`: booking is disabled
- `CancellationPolicy`: supply authoring
- `ChildPolicy`: supply authoring
- `Contract`: supply authoring
- `DailyAvailability`: supply authoring and Quick Update
- `DailyRate`: supply authoring and Quick Update
- `FundingReceipt`: finance-gated: the funding workflow posts to Wallet and LedgerEntry, which the runtime role never writes (ADR 0028)
- `Hotel`: DELETE, external_ref and any column outside the profile set (supply authoring); INSERT and the profile columns are granted
- `HotelSearchIndex`: search-index maintenance (reindex) is an operator job; the runtime only reads the index
- `InventoryHold`: holds are gated; written by the booking path
- `InventoryHoldNight`: holds are gated
- `InventoryPool`: pool authoring needs RatePlan and DailyAvailability writes
- `InventoryPoolDay`: INSERT, DELETE, sold, held and every column outside the capacity set (pool authoring and stock moves: hold path, hold-expiry role); the capacity columns are granted
- `LedgerEntry`: finance-gated
- `PlatformRole`: platform administration
- `PlatformRoleAssignment`: platform administration
- `PlatformRolePermission`: platform administration
- `RatePlan`: supply authoring and pool membership/release
- `Supplier`: supply authoring
- `SupplierHotelMapping`: mapping governance
- `SupplierMutation`: booking mutation journal: written only by prebook, confirmation and reconciliation, which are gated off and need booking tables the role never holds
- `SupplierRoomMapping`: mapping governance
- `Tenant`: tenant settings authoring
- `TenantSettings`: tenant settings authoring
- `User`: identity provisioning (create user) is an operator action; the runtime only records the last sign-in
- `Wallet`: finance-gated: an agency account opens when its first funding receipt is posted (ADR 0028)
<!-- END GENERATED: runtime-role-matrix -->

## 4. Historical grant decisions

Earlier migrations granted `fbeds_api` writes whenever the role already existed. Each disputed resource is now classified, and the classification is enforced by the contract, the verifier, the forward migrations and the specs.

| Resource | Decision | Why |
| --- | --- | --- |
| `Agency`, `AgencyMember` | **REQUIRED**: INSERT, UPDATE / INSERT, DELETE (plus SELECT, also read by the suspension guard) | Admin Clients workflows (create, edit, members, approved suspension) are reachable and self-contained |
| `AgencyCreditLimit` | **REQUIRED**: INSERT, UPDATE, DELETE | The approved credit-limit change is applied by `AgencyCreditService.execute`. The committed-holds figure in the view needs `InventoryHold`, a privileged read, so the view reports it as unavailable, never zero |
| `ApprovalRequest` | **REQUIRED**: INSERT, UPDATE | Every maker-checker flow (markup activation, suspension, credit limit, hotel publication) |
| `CommercialMarkupRule`, `DistributionRestriction` | **REQUIRED**: INSERT, UPDATE (plus SELECT, mandatory commercial reads) | Admin authoring of the controls that Agent search and recheck read |
| `ServiceCase`, `ServiceCaseNote` | **REQUIRED**: INSERT, UPDATE / INSERT | Admin Service department |
| `HotelProfile`, `HotelExternalIdentifier`, `HotelAmenity` | **REQUIRED** (exact operations in the matrix) | Hotel Setup and amenities. External identifiers need no UPDATE: a changed value is delete plus insert |
| `Hotel` | **REQUIRED**: INSERT, and UPDATE on 11 columns only | Add hotel creates the draft; the profile, status, amenities and publication workflows also write the hotel row (details, `content_status`, the `updated_at` stale-token). DELETE and every other column (including `external_ref` updates) stay privileged |
| `RoomType` | **REQUIRED**: INSERT, UPDATE on 8 columns | The Rooms workflow (create, edit, archive, restore). Rooms are never deleted; publication needs one active room |
| `RoomAmenity` | **REQUIRED**: INSERT, UPDATE, DELETE | Room amenities are replaced together with the room edit |
| `HotelImage` | **REQUIRED**: INSERT, UPDATE, DELETE (plus SELECT: Agent search primary image and the Agent image route) | Admin Images workflow |
| `SupplierMutation` | **PRIVILEGED PATH** (no privilege at all) | Written only by prebook, confirmation and reconciliation: booking is gated off and those paths need booking tables the role never holds |
| `InventoryPool` | **PRIVILEGED PATH for writes** (SELECT only) | Pool authoring also needs `RatePlan` and `DailyAvailability` writes |
| `InventoryPoolDay` | **REQUIRED**: column-level UPDATE of capacity and provenance only (plus SELECT) | Pool capacity editor and Quick Update on pooled plans (ADR 0036, Amendment 1). INSERT, DELETE, `sold`, `held` and identity columns stay with the hold path and the hold-expiry role |
| `InventoryHold`, `InventoryHoldNight` | **REQUIRED**: column-level SELECT only (5 and 4 columns) | Per-plan consumption report. No guest, money, offer, idempotency, request or user column; no write |
| Supply core (`Supplier`, `Contract`, `RatePlan`, `DailyRate`, `DailyAvailability`, `BoardBasis`, policies, mappings), tenant settings, platform admin, identity creation | **PRIVILEGED PATH** | Never granted by any migration; ADR 0008 and 0013 place them outside the API role |

Execution path of a privileged operation: a trusted operator performs it with an owner-side or separately provisioned role, outside the API process. There is no second API role today; adding one is an architecture decision (ADR). Until then the API answers a caller who reaches a privileged path with the typed 403 below.

## 5. Prohibited operations

Anything not in the matrix, in particular: any write by the runtime role to a privileged-path table; `DELETE` or `UPDATE` on `AuditEvent`; any `TRUNCATE`; any DDL; any read of wallets, ledger, bookings, holds or connector credentials; creating, altering or granting roles; bypassing RLS. The verifier fails on any of them.

## 6. What a caller sees

| Situation | Response |
| --- | --- |
| No session | 401 |
| Authenticated, permission missing | 403 `FORBIDDEN`, `permission.denied` audit event |
| Another tenant's resource | 404 (existing non-disclosure) |
| Authorized, but the operation is a privileged path (the live grants equal the contract and still do not allow it) | 403 `RUNTIME_ROLE_OPERATION_PROHIBITED`, audit event `runtime_role.operation_prohibited`, nothing written (the transaction rolled back), no SQL, table or column in the body |
| Authorized, but the live grants differ from the contract (drift) | 503 `DATABASE_ROLE_NOT_PERMITTED`, sanitized, structured diagnostic naming the table and the difference (log only) |
| A mandatory commercial control cannot be read | Search `provider_unavailable`, recheck 503, suspension guard 503 `COMMERCIAL_CONTROL_UNAVAILABLE` (ADR 0031) |
| Any other database error | 500 `INTERNAL_SERVER_ERROR`, unchanged |

The classification is made by `DatabaseDenialInterceptor` comparing the live catalog for the denied table with the contract, never by guessing from the error text.

## 7. How to reproduce the certification

On a disposable local PostgreSQL 16 (owner connection in `DATABASE_URL`, never a persistent or production database; Redis for the API):

```bash
cd apps/api
pnpm exec prisma migrate deploy                       # disposable database only
pnpm exec jest --runInBand src/database               # contract, drift guards, generated-doc check (no database)
pnpm exec jest --config ./test/jest-e2e.json --runInBand \
  strict-runtime-role-replay strict-runtime-role-commercial strict-runtime-role-workflows
OWNER_DATABASE_URL=postgresql://...@localhost:PORT/p05_main REDIS_URL=redis://127.0.0.1:6379 \
  pnpm run ops:strict-role-boot-smoke                 # boots the real API on the strict role and drives it over HTTP
```

- `strict-runtime-role-replay`: migration replay, upgrade from the preceding schema and provisioning converge on the same grants; re-running provisioning changes nothing; the verifier names an over-grant and a missing read.
- `strict-runtime-role-commercial`: failure injection per mandatory control, empty-configuration defaults, the 401/403/404/403-prohibited/503-drift matrix, grant-layer refusal, tenant isolation.
- `strict-runtime-role-workflows`: every granted Admin write through the real endpoints, and coverage proven from the database statistics.
- `pool-capacity-editor` (PCE-22 to PCE-27): the real API on the provisioned login: Apply and attribution work and reconcile; application permissions decide 403; protected columns, INSERT/DELETE and every ungranted hold column are refused by the database (including `SELECT *`); cross-tenant and missing tenant context fail closed; no tenant leak on a reused connection; the verifier names a broad SELECT, an extra or missing column read, a broad UPDATE, INSERT, BYPASSRLS and an extra membership; a missing privilege is a sanitized 503 with nothing written; concurrent holds and edits never breach `sold + held <= capacity`.
- `strict-role-boot-smoke`: normal boot path, tenant context, agency state, restrictions, markup, a permitted and a prohibited Admin mutation, isolation.

## 8. Not covered here

Production-clone compatibility, persistent role provisioning, hosted backups and monitoring remain owner-controlled release gates. The Pool Capacity Editor is covered by ADR 0036, Amendment 1 (`pool-capacity-editor` PCE-22 to PCE-27 run the real API on the strict login). Applying migration `202610260001_strict_runtime_role_pool_capacity` to a persistent database (follow [runbooks/strict-role-rollout.md](runbooks/strict-role-rollout.md)) and re-provisioning the persistent role remain owner-controlled steps.


## 9. Column-level reads

A contract row may declare `readColumns` instead of `read: true`. Provisioning emits `GRANT SELECT (cols) ON table`; the verifier compares the actual column privileges and flags an extra readable column, a missing one, and a table-level SELECT that overrides the restriction. Code must name its columns (no `SELECT *`, no ORM default column list) on such a table: PostgreSQL refuses the statement otherwise. A policy expression is evaluated with the caller's privileges, so `tenant_id` must be one of the readable columns. The matrix above shows `cols (n)` for these tables.


## Freshness-preserving capacity grant (ADR 0037)

The newer contract and migration 202610270001_strict_runtime_role_pool_freshness supersede the six-column capacity/provenance grant from PR #262. Only capacity and updated_at are writable. Quick Update statements that stamp provenance remain privileged; missing nights remain invalid. Column ACLs are explicitly revoked during convergence because table-level REVOKE does not remove them. The earlier migration is preserved unchanged.
