# Strict Runtime DB Role

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
| `Hotel` | yes | - | cols (11) | - | forced tenant | UPDATE (name, property_type, country_code, city, address, latitude, longitude, time_zone, star_rating, content_status, updated_at): HotelSetupService.save/changeStatus; touchSetup (amenities); HotelPublicationService.execute; PATCH /admin/hotels/:hotelId/setup, POST /admin/hotels/:hotelId/setup/status, PUT /admin/hotels/:hotelId/amenities, POST /admin/hotels/:hotelId/setup/publication/:approvalId/execute; the profile workflows also stamp or change the hotel row (details, status, updated_at stale-token) |
| `HotelAmenity` | yes | yes | yes | yes | forced tenant | INSERT: HotelAmenitiesService.replace; PUT /admin/hotels/:hotelId/amenities; add an amenity / UPDATE: HotelAmenitiesService.replace; PUT /admin/hotels/:hotelId/amenities; change an amenity (upsert) / DELETE: HotelAmenitiesService.replace; PUT /admin/hotels/:hotelId/amenities; remove an amenity |
| `HotelExternalIdentifier` | yes | yes | - | yes | forced tenant | INSERT: HotelSetupService.save; PATCH /admin/hotels/:hotelId/setup; add an external identifier / DELETE: HotelSetupService.save; PATCH /admin/hotels/:hotelId/setup; remove or replace an identifier (a changed value is delete plus insert, so no UPDATE) |
| `HotelImage` | yes | yes | yes | yes | forced tenant | INSERT: HotelImagesService.upload; POST /admin/hotels/:hotelId/images; upload an image / UPDATE: HotelImagesService.update/reorder; PATCH /admin/hotels/:hotelId/images/:imageId, PUT /admin/hotels/:hotelId/images/order; edit, reorder, choose the primary image / DELETE: HotelImagesService.remove; DELETE /admin/hotels/:hotelId/images/:imageId; delete an image |
| `HotelProfile` | yes | yes | yes | - | forced tenant | INSERT: HotelSetupService; touchSetup; HotelPublicationService; PATCH /admin/hotels/:hotelId/setup, POST /admin/hotels/:hotelId/setup/status, PUT /admin/hotels/:hotelId/amenities; first save of a hotel profile / UPDATE: HotelSetupService; touchSetup; HotelPublicationService; PATCH /admin/hotels/:hotelId/setup, POST /admin/hotels/:hotelId/setup/status, PUT /admin/hotels/:hotelId/amenities, POST /admin/hotels/:hotelId/setup/publication/:approvalId/execute; save the profile, bump its version, stamp the approver |
| `HotelSearchIndex` | yes | - | - | - | forced tenant | read only |
| `InventoryPool` | yes | - | - | - | forced tenant | pool writes are a privileged path: a pool change also needs RatePlan and DailyAvailability writes |
| `InventoryPoolDay` | yes | - | - | - | forced tenant | stock moves belong to the hold path and the hold-expiry role |
| `memberships` | yes | - | - | - | forced tenant | also readable by the transaction-local app.current_user_id before a tenant is chosen (ADR 0008) |
| `Permission` | yes | - | - | - | none (auth) | read only |
| `RatePlan` | yes | - | - | - | forced tenant | read only |
| `Role` | yes | - | - | - | forced tenant | read only |
| `RolePermission` | yes | - | - | - | forced tenant | read only |
| `RoomType` | yes | - | - | - | forced tenant | read only |
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
- `Hotel`: supply authoring beyond the profile columns (create a hotel, external_ref)
- `HotelSearchIndex`: search-index maintenance (reindex) is an operator job; the runtime only reads the index
- `InventoryHold`: holds are gated; written by the booking path
- `InventoryHoldNight`: holds are gated
- `InventoryPool`: pool authoring needs RatePlan and DailyAvailability writes
- `InventoryPoolDay`: pool authoring and stock moves (hold path, hold-expiry role)
- `LedgerEntry`: finance-gated
- `PlatformRole`: platform administration
- `PlatformRoleAssignment`: platform administration
- `PlatformRolePermission`: platform administration
- `RatePlan`: supply authoring and pool membership/release
- `RoomAmenity`: rooms workflow, which also writes RoomType
- `RoomType`: supply authoring (rooms)
- `Supplier`: supply authoring
- `SupplierHotelMapping`: mapping governance
- `SupplierMutation`: booking mutation journal: written only by prebook, confirmation and reconciliation, which are gated off and need booking tables the role never holds
- `SupplierRoomMapping`: mapping governance
- `Tenant`: tenant settings authoring
- `TenantSettings`: tenant settings authoring
- `User`: identity provisioning (create user) is an operator action; the runtime only records the last sign-in
<!-- END GENERATED: runtime-role-matrix -->
