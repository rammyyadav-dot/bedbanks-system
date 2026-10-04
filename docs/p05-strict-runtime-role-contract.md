# P0.5 strict runtime-role contract and commercial read safety

> **Superseded in part.** The Admin write decision (D1) and the HotelImage read (D2) were resolved by [ADR 0032](adr/0032-explicit-runtime-write-set.md). The authoritative matrix is now generated in [strict-runtime-db-role.md](strict-runtime-db-role.md). This page is kept as the record of the first P0.5 pass.

Decision record: [ADR 0031](adr/0031-strict-runtime-role-and-commercial-control-failure.md). This page is the privilege matrix, the evidence, and what is still open. Everything here was run on disposable local PostgreSQL 16 clusters with generated credentials; no persistent database, role, deployment, DNS or alias was touched.

## 1. Principals

| Principal | Used by | Attributes | Capabilities |
| --- | --- | --- | --- |
| `fbeds_api` (group) / `fbeds_api_login` | Every HTTP request (`PrismaService`, `DATABASE_URL`): Agent, Admin and Supplier routes share one process and one principal | NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION, owns nothing | The contract below |
| `fbeds_hold_expiry` / `fbeds_hold_expiry_login` | Hold-expiry sweeper only | Same attribute set | `InventoryHold*` release path and `UPDATE ("held","updated_at")` on `InventoryPoolDay`; cannot read hotel search tables (ADR 0005) |
| Owner | Migrations and provisioning only | Never a runtime principal | n/a |

Tenant context for every tenant table: `set_config('app.current_tenant_id', ..., true)` inside the request transaction (`withTenant`), read by `fbeds_current_tenant_id()`; NULL without context returns zero rows; transaction-local, so a reused pooled connection carries nothing (tested: SC-11).

## 2. Authoritative privilege matrix for the disputed objects

S/I/U/D = SELECT/INSERT/UPDATE/DELETE. "Migration" is what the existing committed migrations grant when `fbeds_api` already exists; "Provisioning (before)" is `provisionApiRuntimeRole` before this change; "Final" is the contract after this change (both provisioning and the new forward migration produce it).

| Object | Calling service and operation | Scope | Needed by `fbeds_api`? | Migration | Provisioning (before) | **Final** | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `Agency` | `AgencySuspensionGuard` (status of the caller's agency); restriction lookup joins it. Writes: `ClientsService` (create/update), `AgencySuspensionService` (status via approved request) | Tenant (RLS) | **Read, mandatory.** Writes are Admin authoring | S,I,U | none | **S** | SC-04..07, SR-02/04 |
| `AgencyMember` | Guard (membership), restriction lookup. Writes: `ClientsService` add/remove member | Tenant | **Read, mandatory.** Writes are Admin authoring | S,I,D | none | **S** | SC-06 |
| `DistributionRestriction` | `loadDistributionRestrictions` in Agent search and recheck. Writes: `DistributionService` create/retire | Tenant | **Read, mandatory.** Writes are Admin authoring | S,I,U | none | **S** | SC-05 |
| `CommercialMarkupRule` | `loadActiveMarkupRules` (NET rates only) in search and recheck. Writes: `CommercialMarkupService` create/retire/execute | Tenant | **Read, mandatory when a NET rate is present.** Writes are Admin authoring | S,I,U | none | **S** | SC-02..04 |
| `AgencyCreditLimit` | Hold credit check (`agency-credit.ts`), Admin credit-limit execute | Tenant | No: the hold path needs `InventoryHold` writes this role never had; Admin writes are authoring | S,I,U,D | none | none | ADR 0024 fail-closed unchanged |
| `ApprovalRequest` | `ApprovalService` maker-checker for markups, suspension, credit, publication | Tenant | No (Admin authoring) | S,I,U | none | none | SC-09 |
| `HotelProfile`, `HotelExternalIdentifier`, `HotelAmenity`, `RoomAmenity` | Admin hotel setup, rooms, amenities, publication (`hotel-setup/*`) | Tenant | No (Admin authoring); read views already report "unavailable" | S,I,U(,D) | none | none | existing HS/HR specs, SC-09 |
| `HotelImage` | Search `primaryImage` (optional), Agent image route; Admin images | Tenant | **Optional read, OWNER DECISION** (see 4). Writes are Admin authoring | S,I,U,D | none | none (pending decision) | SC-02 (search still serves without images) |
| `ServiceCase`, `ServiceCaseNote` | Admin service department | Tenant | No (Admin authoring) | S,I,U / S,I | none | none | SC-09 |
| `SupplierMutation` | Booking confirmation, prebook and reconciliation (`agent/*`), Admin governance reads | Tenant | No: booking is disabled and those writes need booking/hold tables the role never had; the department-summaries spec requires it unreadable | S,I,U | none | none | SR-02, SC-10 |
| `InventoryPool`, `InventoryPoolDay` | Reads: search, recheck, Admin summary. Writes: Admin inventory-admin and Quick Update, hold counters (`inventory-counters.ts`), hold-expiry role | Tenant | **Read only** | S,I,U | S | **S** | inventory-runtime-roles RR-01b, SC-10 |
| `CancellationPolicy`, `HotelSearchIndex`, supply read tables | Search, recheck | Tenant | Read | n/a / S | S | S | unchanged |
| `users`, `sessions`, `AuditEvent`, `supplier_room_drafts` | Auth, audit, supplier extranet drafts | Tenant/platform | Read and the allowlisted writes | S,I,U on drafts | allowlist | allowlist (unchanged) | SR-04 |
| Wallet, Ledger, Booking, Connector credentials | n/a | Tenant | Never | none | none | none | verifier, unchanged |

Function EXECUTE: `fbeds_current_tenant_id()` is the only function the policies call; it is executable by PUBLIC and unchanged.

### Write allowlist enforced by the verifier

`users` UPDATE (`last_login_at`, `updated_at`); `sessions` INSERT, UPDATE (`last_seen_at`, `revoked_at`); `AuditEvent` INSERT; `supplier_room_drafts` INSERT, UPDATE. Nothing else, no DELETE or TRUNCATE. SR-04 asserts the catalog equals this list after provisioning; SR-05 shows the verifier naming a migration-style over-grant.

## 3. Candidate Admin write set (NOT applied; for the owner decision)

If the owner chooses option A (a separate Admin API role), this is the minimum write set the implemented Admin capabilities need, per the call sites traced above. Each table stays under forced RLS and each route keeps its permission guard.

| Table | Privileges | Admin operation |
| --- | --- | --- |
| `Agency` | S,I,U | clients create/update, suspension execute |
| `AgencyMember` | S,I,D | add/remove member |
| `AgencyCreditLimit` | S,I,U,D | credit-limit execute |
| `ApprovalRequest` | S,I,U | maker-checker |
| `CommercialMarkupRule` | S,I,U | markup create/retire/execute |
| `DistributionRestriction` | S,I,U | restriction create/retire |
| `HotelProfile` | S,I,U | hotel setup, publication |
| `HotelExternalIdentifier`, `HotelAmenity`, `RoomAmenity`, `HotelImage` | S,I,U,D | setup, rooms, amenities, images |
| `ServiceCase` / `ServiceCaseNote` | S,I,U / S,I | service department |
| `InventoryPool`, `InventoryPoolDay` | S,I,U | pools, Quick Update |
| `Hotel`, `RoomType`, `BoardBasis`, `Supplier`, `Contract`, `RatePlan`, `DailyRate`, `DailyAvailability`, `CancellationPolicy`, mappings | per `SupplyService` | supply authoring; never granted by any migration, so also outside today's contract |

`SupplierMutation`, wallet, ledger, booking and hold tables are not part of Admin authoring and are not in this set.

## 4. Open decisions

| # | Decision | State | Alternatives |
| --- | --- | --- | --- |
| D1 | Which principal writes the Admin authoring tables | **BLOCKED (owner)** | A separate `fbeds_admin_api` role (recommended), operator-only authoring, or widening `fbeds_api` (rejected). Until decided, Admin authoring on a strict deployment returns 503 `DATABASE_ROLE_NOT_PERMITTED` and writes nothing |
| D2 | Agent hotel-image read (`HotelImage` SELECT) on the strict role | **BLOCKED (owner)** | Grant SELECT (read-only, RLS) or keep images off the strict Agent path. Today search omits images and the image route answers 503 |
| D3 | Applying the revoking migration to a persistent database | Owner-controlled | If any persistent deployment already uses `fbeds_api` as the Admin writer, apply D1 first |
| D4 | Production-clone compatibility | **BLOCKED** | No approved clone, secrets or runner; the runner baseline (releaseSha `5c19dee` plus five migrations) is stale against 40 migrations |

## 5. Evidence

Test suites, all on the provisioned non-superuser, non-BYPASSRLS login role (setup used a separate owner):

- `strict-runtime-role-replay.e2e-spec.ts` (SR-01..07): the preceding schema carries the over-grants (defect); after the forward migration replay and upgrade hold identical contract-only state before provisioning; provisioning yields identical grants on both and re-running changes nothing; the login role verifies clean; the verifier names a migration-style over-grant and a missing mandatory read; no later migration may grant to the role.
- `strict-runtime-role-commercial.e2e-spec.ts` (SC-01..11): the app connection is the strict role; valid search, recheck and NET markup; legitimate empty configuration (no rule, no agency, no restriction); failure injection per control by revoking its SELECT (markup, restrictions, agency, membership): search and recheck fail closed, no unrestricted offer or fabricated price, hold, booking, supplier-mutation and stock counts unchanged, grant restored restores the flow; suspended agency still 403; Admin matrix over seven mutations (unauthenticated 401, no permission 403, read-only 403, other tenant 404, no write and no success audit; authorized caller on the strict role 503 `DATABASE_ROLE_NOT_PERMITTED`, sanitized, no write, no audit); grant-layer refusal independent of the API; own-tenant read, cross-tenant empty, no-context empty, no context leak on connection reuse.
- Baseline reproduction: with the previous exception filter the same seven authorized-caller requests return `500 INTERNAL_SERVER_ERROR`.
- Unit: loaders (denied, failed, malformed, empty), guard, filter mapping, `db-errors`, grant allowlist consistency.
- Also run: `inventory-runtime-roles`, `inventory-runtime-http`, `runtime-rls-role`, `api-runtime-role`, `department-summaries` and the rest of the API e2e suite (see the delivery report for counts).

## 6. Mechanics not covered here
Production-clone migration, persistent role provisioning, hosted backups and monitoring remain owner-controlled release gates. `PRODUCTION_RELEASE_READINESS` is not established by this work.
