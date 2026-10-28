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
- **Database access.** The API runtime role previously had no `Booking` grant ("booking is disabled; finance-gated"). Slice 2 gives it **column-only SELECT** on `Booking`, `BookingRoom` and `BookingGuest` (defined in `runtime-role-contract.ts` and applied by `ops:provision-api-runtime-role`, because the repository rule SR-07 forbids migrations from granting runtime privileges; migration `202611170002_supplier_extranet_bookings_permission` adds only the permission row), so PostgreSQL itself refuses `total_minor`, `markup_minor`, `fx_rate`, `agency_id`, `search_snapshot`, `sell_minor`, guest contact/age columns and `SELECT *`. The alternative, reading through the booking-ops role, would have exposed the sell price to the supplier code path. The role gains **no write** on any booking table; `Booking.supplier_id` is written only by the booking creation path and the owner-run backfill. Three older guards that asserted "no booking grant at all" were tightened to "no write, no table-level read, named columns only".
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

## Amendment 2 (proposed): supplier booking answers (slice 3)

Status: **Accepted 2026-10-19 (option A, no four-eye threshold in this slice).** Drafted 2026-10-19 from the code on `main` at `5cd7600`.

### What the code does today (verified in source)
- `POST /admin/operations/booking-queue/:bookingId/supplier-answer` (`BookingOpsService.answer`) is an **operator** recording what a supplier told them. It requires `booking.ops.resolve`, an idempotency key, a compare-and-set `expectedStatus`, a reason of at least `BOOKING_OPS_REASON_MIN` characters, and writes an ops record. It "calls no supplier".
- Its confirm, reject and cancel answers call `transitionBooking(... level: 'SYSTEM', emitFinance: true)`. Confirmation and rejection emit finance events. `SUPPLIER_CANCELLED` also triggers agency settlement (ADR 0069).
- The extranet database role has **no write** on any booking table (Amendment 1). `Booking.supplierId` is immutable and frozen at creation.

### Decision to take
A supplier user answering their own booking is a different actor from an operator, and the answer moves money-relevant state. Three options:

| Option | Description | Verdict |
|---|---|---|
| A. Direct, limited | Supplier may answer `SUPPLIER_CONFIRMED`, `SUPPLIER_ON_REQUEST`, `SUPPLIER_REJECTED` only, for bookings in `PENDING` or `ON_REQUEST`. Applied through the existing transition with actor type supplier user. | **Recommended** |
| B. Proposal queue | Supplier submits an answer; an operator acknowledges it before it applies. | Safe but defeats the purpose (operators stay in the loop for every booking) |
| C. Full parity | Supplier may also record cancellations, "no booking exists" and refused cancellations. | **Rejected.** These carry agency credit and unknown-outcome recovery, and need evidence only fBeds can weigh |

### Proposed rules (option A)
1. **Route:** `POST /supplier/extranet/bookings/:bookingId/answer`, permission `supplier.extranet.bookings.answer`, granted to no role by the migration.
2. **Ownership:** the booking's frozen `supplierId` must equal the caller's active organization. Otherwise 404, never 403, so existence is not revealed.
3. **Input:** `answer` (one of the three), `expectedStatus` (compare-and-set), `Idempotency-Key` header (required), `supplierRef` (required for confirm), `hotelConfirmationNo` (optional), `reason` (required for reject).
4. **Idempotency and concurrency:** same key and same body replays the stored result; same key and different body is 409. A changed status is 409 with the current status.
5. **Audit:** an immutable audit event per answer (`supplier.booking.answered`) and the transition's `BookingEvent`. `AuditActorType` has only `USER` and `SYSTEM`, so both use actor type `USER` with the supplier user's id; the event payload carries `via: 'supplier_extranet'`, the supplier organization id, the answer and the from/to status, which separates it from an operator's answer. No guest data and no free text in the audit payload.
6. **Finance:** confirm and reject keep the existing finance emission. No new finance behaviour is introduced.
7. **Database access:** the extranet role stays read-only. The write goes through the booking role path in a service the extranet controller calls, so the extranet role gains no booking write. This needs an entry in `runtime-role-contract.ts` for the new caller and endpoint.
8. **SLA:** out of scope here. The portal shows booking age; timers come with notifications (slice 7).

### Risks and open questions
- Does a supplier answer need four-eye review for high-value bookings? Proposed: not in this slice; add a configurable threshold later.
- A supplier can answer wrongly. Recovery is the existing operator path, which can still override.
- Rate limiting per organization on this route is required before launch.

### Required tests before merge
Cross-organization booking returns 404; replay with the same key returns the same result; same key with a different body returns 409; stale `expectedStatus` returns 409; each of the three answers produces the right status and finance event; cancellation and no-booking answers are refused; missing permission returns 403; audit event exists and has no guest data; extranet role still has no booking write (privilege probe).

### Rollback
Remove the route and the permission row by forward migration. Answers already recorded remain valid booking history.

### Implementation (slice 3)
| Requirement | Where | Evidence |
|---|---|---|
| Route and permission | `POST /supplier/extranet/bookings/:bookingId/answer`, `supplier.extranet.bookings.answer`; migration `202611270004_supplier_extranet_bookings_answer_permission` (permission row only, granted to no role) | e2e SA-07 (403 with read-only access) |
| Shared types | `ExtranetBookingAnswerRequest/Result`, `EXTRANET_BOOKING_ANSWERS`, `routes.supplier.bookingAnswer` in `@bedbanks/contracts` | type-check |
| Allowed answers only | `supplier-booking-answer.ts` maps confirm / on request / reject to lifecycle actions; DTO whitelist refuses the rest | unit spec (3), e2e SA-04, SA-05 |
| Ownership | row lock filtered by tenant and frozen `supplier_id`; other organization, tenant or null supplier is 404 | e2e SA-06 |
| Idempotency, compare-and-set | `transitionBooking` (key + fingerprint, `expectedStatus`) | e2e SA-08, SA-09 (incl. two concurrent answers: one 200, one 409) |
| Finance | unchanged: `emitFinance: true` through the existing transition | e2e SA-10 |
| No new database privilege | write on the booking-module role; the API runtime role still cannot write a booking | e2e SA-11 |
| Audit without guest data | `createMany` (the booking role may insert audit events but not read them) | e2e SA-01, SA-12 |
| Portal | booking detail page shows the form only with the permission and a status that allows an answer; key issued with the page | type-check, lint, `next build` |

Operating note: the permission is granted to no role. An operator assigns it to supplier roles through the normal role-assignment path. The route needs `BOOKING_OPS_DATABASE_URL`; without it the route answers 503 and changes nothing.
Verification gaps: the e2e suite was run on a local PostgreSQL 16 with a temporary jest configuration that stubs `@nestjs/swagger` (the project expects Node 24; this host had Node 22). The portal form was type-checked and built but not exercised in a browser. Four failures in `security-certification` and `booking-ops-role` also occur on the untouched baseline in that environment and were not investigated.

## Amendment 3 (proposed): supplier change sets for availability and stop-sale (slice 4a), rates deferred (4b)

Status: **Accepted 2026-10-19 (all recommendations D1 to D6 adopted).** Drafted 2026-10-19 from `main` plus slice 3 (`93f6f64`). Implements decision 3 of this ADR ("suppliers never write commercial data directly").

### What the code does today (verified in source)
- **Calendar import already exists for staff.** `SupplyService.previewCalendarImport` parses a CSV with `buildCalendarImport` (`supply/calendar-import.ts`), reports row-level errors, and builds rate cells (`amountMinor` as a string, `amountBasis` NET or SELL, `currency`) and availability cells (`allotment`, `stopSell`, `minStay`, `releaseDays`), each carrying `expectedUpdatedAt` for stale-cell detection. Limits: 90,000 bytes, 2,000 lines, 366 cells per review.
- **Preview and apply share one validator.** `editCalendar(..., preview, requireVersions)` is the single write path. It needs `supply.rates.manage` or `supply.availability.manage`.
- **The import is not supplier-aware.** It resolves any hotel and any rate plan in the tenant. A supplier must never be able to name another organization's plan.
- **Rate semantics.** `DailyRate.amountBasis` NET is non-sellable (`NET_RATE_MARKUP_UNAVAILABLE`) until markup governance exists (`docs/authoritative-rate-amount-semantics.md`). Supplier rates are NET by nature.
- **Pooled plans.** A rate plan may share an `inventoryPoolId`, so editing its availability can change other plans' stock.
- **Existing supplier draft** is a single note (`SupplierRoomDraft`). There is no versioned submission.

### Decisions to take
| # | Question | Recommendation |
|---|---|---|
| D1 | Scope of the first slice | **4a: availability and stop-sale only** (allotment, stop-sell, min stay, release days). No money. 4b (NET rate lines) follows after 4a is in use. |
| D2 | How suppliers submit | A **change set**: a versioned, immutable-after-submit batch of cells, validated by the existing import validator, reviewed by fBeds staff, applied through `editCalendar`. |
| D3 | Who reviews | A new staff permission `supply.supplier-changes.review`, distinct from `supply.availability.manage`, so every availability editor is not automatically a reviewer. Supplier submitter and staff reviewer are different people by construction. |
| D4 | Risk-reducing changes (closing sales, cutting allotment) | **Reviewed like any other in 4a.** An instant "fast lane" for closing changes reduces oversell risk but is a direct supplier write; it needs its own owner decision and amendment after review-latency data exists. |
| D5 | Pooled plans | **Refuse cells for plans with an `inventoryPoolId` in 4a** with a clear row error. Pooled stock needs a rule for who may move shared inventory. |
| D6 | Prerequisite | Cursor pagination on `GET /supplier/extranet/hotels` and `/contracts` first (audit M3). The contracts route caps at 200 contracts and 200 plans, and the author screen needs a plan picker. |

### Proposed model (4a)
1. **Tables** (tenant-scoped, forced RLS, composite `(tenant_id, supplier_id)` foreign keys, `ON DELETE RESTRICT`):
   - `SupplierChangeSet`: id, tenant, supplier, hotel, `status` (`DRAFT`, `SUBMITTED`, `APPROVED`, `REJECTED`, `APPLIED`, `FAILED`, `WITHDRAWN`), `version`, `cellCount`, `contentSha256`, author, submitted/decided/applied timestamps and users, a short decision reason.
   - `SupplierChangeSetCell`: change set, rate plan, stay date, the availability fields, `expectedUpdatedAt`. Rows are frozen once the set leaves `DRAFT` (trigger).
   - `SupplierChangeSetEvent`: append-only history (trigger), like `BookingEvent`.
   - Indexes: `(tenant_id, supplier_id, status, created_at)` and `(tenant_id, status, submitted_at)` for the staff queue.
2. **Supplier routes** (`/supplier/extranet/change-sets`): create draft from CSV or rows, replace draft cells, preview, submit, withdraw, list, detail. Permissions `supplier.extranet.changes.read` and `supplier.extranet.changes.author`. Create, submit and withdraw require an `Idempotency-Key`. Each runs under `withSupplier` and filters tenant and supplier in the query.
3. **Supplier scoping of the validator.** The shared validator gains an optional allow-list: a hotel must be mapped to the caller's organization (`PENDING` or `MAPPED`), and each plan's contract must have `supplierId` equal to the caller's organization. Anything else is a row error `PLAN_NOT_YOURS`, reported as not found, never as forbidden. This extends the existing code path; it does not fork it.
4. **Staff routes** (`/admin/operations/supplier-changes`): queue, detail with the validator's preview, approve, reject (reason required), apply. Approve and apply may be one step. Apply calls `editCalendar` with `requireVersions: true` inside one transaction; any stale cell fails the whole set (`FAILED`, reason recorded) and the supplier resubmits. Applied writes are attributed to the reviewing user with the change set id in the audit payload.
5. **Audit and idempotency.** Every transition writes a `SupplierChangeSetEvent` and an `AuditEvent`. Payloads hold ids, counts, statuses and the content hash, never free-text notes.
6. **Database privileges.** Per SR-07 migrations grant nothing to runtime roles; the owner-run provisioning grants the API runtime role `SELECT` and `INSERT` on the three tables and column-level `UPDATE` of `status` and `version` only, with a trigger allowing only `DRAFT` to `DRAFT`/`SUBMITTED`/`WITHDRAWN` and `SUBMITTED` to `WITHDRAWN` from that role. The staff apply uses the existing supply credential that `editCalendar` already uses. The extranet role gains no write on `DailyAvailability`, `DailyRate` or `RatePlan`.
7. **Portal and admin UI.** Portal: a change-set list and an author screen (CSV upload with a row-level error report, then a calendar grid later in slice 5). Admin: a review queue page.

### Slice 4b (rates), recorded now, built later
- Supplier rate cells are forced to `amountBasis: NET`, integer minor-unit strings, and the plan's currency. A different currency is a row error.
- A rate change above a configured percentage needs the reviewer's explicit confirmation (the existing `confirmLargeChanges`).
- Applying NET rates makes nothing sellable by itself; `NET_RATE_MARKUP_UNAVAILABLE` still applies until markup governance is accepted.
- 4b needs its own acceptance once 4a is in use.

### Risks and open questions
- **Review load.** Daily availability updates from many hotels could swamp staff. Mitigations are the cell cap, a queue sorted by age, and a later fast lane (D4). Measure before deciding.
- **Staleness.** A set that waits in review may fail on apply because staff or a connector changed a cell. This is correct but frustrating; the failure message names the stale cells.
- **Supplier-supplied dates in the past** or beyond the contract term are row errors from the existing validator; confirm it enforces the contract term for supplier input.
- **Channel-manager feeds (slice 9)** will produce the same change sets from XML; the model is feed-agnostic on purpose.

### Required tests before merge
Another organization's hotel or plan returns a row error and writes nothing; a pooled plan is refused; frozen cells cannot change after submit (database trigger); idempotent create and submit (replay, key reuse with another body); withdraw only from `DRAFT` or `SUBMITTED`; approve then apply changes exactly the previewed cells; a stale cell fails the whole set and leaves the calendar untouched; a supplier cannot approve or apply, and a staff member without `supply.supplier-changes.review` cannot; the extranet role cannot write `DailyAvailability`, `DailyRate` or `RatePlan` (privilege probe); no guest, price or other-organization data in any supplier response.

### Rollback
Remove the supplier and staff routes and the permission rows by forward migration; the three tables may remain unused. Availability already applied stays valid and carries the change set id in its audit trail.

### Suggested delivery order
1. Cursor pagination on hotels and contracts (D6).
2. Schema, provisioning grants, supplier author/submit routes with shared types.
3. Supplier-scoped validator allow-list, staff queue and apply.
4. Portal author screen and admin queue page.

### Implementation (delivery step 1: pagination, D6)
| Requirement | Where | Evidence |
|---|---|---|
| Keyset-paged hotels | `GET /supplier/extranet/hotels?limit&cursor`, order (hotel name, hotel id), `ExtranetHotelList` in `@bedbanks/contracts` | e2e SP-01, SP-02 |
| Keyset-paged contracts | `GET /supplier/extranet/contracts?limit&cursor`, order (valid from desc, code, id), `nextCursor` and per-contract `ratePlansTruncated` | e2e SP-03 |
| Bounded and validated | `PageQueryDto`: limit 1 to 50 (default 25), cursor up to 700 characters, unknown parameters refused | e2e SP-04, unit `supplier-page-cursor.spec.ts` |
| Scope never from the cursor | the cursor holds ordering keys only; tenant and organization come from the session | e2e SP-05, SP-06 |
| Portal | hotels and contracts pages follow the cursor ("Next page", "First page") and say when a contract's plan list is capped | type-check, lint, `next build` |

Behaviour change for API consumers: both lists now return at most `limit` rows plus `nextCursor`, where hotels were previously unbounded and contracts capped at 200. The 200-plan cap per contract remains; it is now reported (`ratePlansTruncated`) instead of silent. A plan-level pager can be added if a real contract exceeds it.

### Implementation (delivery step 2: change-set schema and supplier routes, slice 4a)
| Requirement | Where | Evidence |
|---|---|---|
| Tables | `supplier_change_sets`, `supplier_change_set_cells`, `supplier_change_set_events`; migration `202611270005_supplier_change_sets` (tables, checks, RLS, triggers, two permission rows) | migration applies; no schema drift for the new tables; e2e CS-09, CS-13, CS-15 |
| Supplier isolation in the database | forced RLS with two permissive policies: supplier-scoped (the request set its organization) and tenant-wide only when no supplier is set (the later staff queue) | e2e CS-13 |
| Frozen after submit | trigger on cells (any write needs a DRAFT parent) and on the set (content, identity, status edges) | e2e CS-09 |
| Append-only history | trigger on events | e2e CS-15 |
| Grants | `runtime-role-contract.ts` only (SR-07): insert and a column-limited update on sets, insert and delete on cells (draft only), insert on events. No write on `DailyAvailability`, `DailyRate` or `RatePlan`; review columns not granted | e2e CS-14, `runtime-role-contract.spec.ts`, regenerated `docs/strict-runtime-db-role.md` |
| Routes | `GET/POST /supplier/extranet/change-sets`, `POST .../preview`, `GET/PUT .../:id`, `POST .../:id/submit`, `POST .../:id/withdraw`; permissions `supplier.extranet.changes.read` / `.author` (granted to no role); shared types and routes in `@bedbanks/contracts` | e2e CS-01 to CS-12 |
| Validation | the staff `buildCalendarImport` parser, unchanged, fed only the plans of the caller's own contracts at a hotel mapped to it; rates and pooled plans refused (`supplier-change-validation.ts`) | unit spec (10), e2e CS-03 to CS-05 |
| Idempotency and versions | `Idempotency-Key` required on create, replace, submit, withdraw; one key names one request per organization (unique per tenant, supplier, key); `expectedVersion` on replace, submit, withdraw | e2e CS-07, CS-08, CS-10 |
| Audit | an `AuditEvent` and a history event per transition; payloads hold ids, counts, version and hash only | e2e CS-02, CS-15 |

Decisions taken during implementation (not in the draft):
- **Input is CSV only.** It is the one format the validator understands. Row-level JSON arrives with the calendar screen (slice 5).
- **Only a valid file is stored.** An invalid create or replace answers 422 `CHANGE_SET_INVALID` with every issue in `error.details` (the error envelope carries `code`, `message` and `details`) and stores or changes nothing. A `POST .../preview` returns the same report without storing.
- **Submit does not re-validate.** The cells carry the live version they were prepared against; the authoritative check, including stale cells, runs when staff apply the set.
- **Idempotency is per organization, not per change set**, so concurrent creates with one key cannot make two sets.

Operating notes: run `ops:provision-api-runtime-role` after deploy to apply the new grants (until then the routes fail closed with a database "permission denied"), and assign the two permissions to supplier roles.
Verification gaps: the end-to-end suites ran on local PostgreSQL 16 with the temporary jest configuration described under slice 3. No portal screen exists yet (step 4). The 26 API unit suites that cannot load on this host's Node 22 are the same set with and without this change.

## Amendment 4: supplier answers are refused until a settlement path exists (audit F1, F2)

Status: **Accepted 2026-10-28** as a safety stop. It narrows Amendment 2 and does not replace it; the answer route, permission, idempotency and audit design stay as built.

### What the audit found (verified in source, `docs/audits/2026-10-28-supplier-workflow-audit.md`)
- Every booking a supplier can see is contracted inventory (`Booking.supplierId` is set only in the hold transaction, Amendment 1 D2). Until it is settled it holds the agency's wallet reservation (`LedgerEntry` `HOLD`) and an inventory hold in `PROCESSING`.
- Settlement happens in exactly two places: `BookingConfirmationService.confirm` (hold to `CONFIRMED`, held to sold, wallet `HOLD` to `DEBIT`, status) and `BookingReconciliationService` (wallet and hold released, status `FAILED`).
- The supplier answer wrote only `Booking.status` and a `BookingFinanceEvent` through the booking-module role. That role is forbidden from `LedgerEntry`, `Wallet` and `InventoryHold` by design, and the API runtime role cannot write a booking, so no single role can do both halves.
- Effects: **confirm** left the agency undebited and the stock held (the later agent confirm then returned "already confirmed" without settling, and the hold-expiry sweep could return the stock for sale); **reject** left the funds reserved and the stock held, and the reconciliation sweep skips a booking that is no longer pending.

### Decision
1. `POST /supplier/extranet/bookings/:bookingId/answer` refuses a **first** answer with `409 ANSWER_REQUIRES_SETTLEMENT` after validation, ownership (404 for another organization) and the availability check (400 `ANSWER_NOT_AVAILABLE`), and before any write. Nothing in the booking, event, finance or audit tables changes.
2. A **replay** of an answer that was already recorded still returns its stored result (same key and body) or `IDEMPOTENCY_CONFLICT`, so history stays readable.
3. The portal shows bookings read only. The answer form and its server action are removed; the dashboard and booking pages no longer say a supplier answers or that nothing is booked without their answer. Operators keep answering on a supplier's behalf through the booking-ops queue.
4. The `supplier.extranet.bookings.answer` permission and the route stay in place, so enabling answers later needs no contract change.

### Not decided here (needs its own amendment before answers are re-enabled)
- **Where settlement runs.** Options: (a) a settlement service on a principal that may write the booking, the ledger and holds in one transaction, which needs a reviewed privilege design under SR-07; (b) the supplier answer records an intent that the existing agent confirm or reconciliation path consumes; (c) keep answers operator-only for contracted inventory and give suppliers a request-to-operator action.
- Reject from `ON_REQUEST` and the reconciliation sweep: it ignores `REJECTED` and `ON_REQUEST`, so any path that enters those states for a booking that still holds funds must release them itself.
- Required tests when re-enabled: wallet entries, hold status and inventory counters after each of confirm, on request and reject, including a retry after a partial failure.

### Rollback
Remove the refusal line in `SupplierBookingAnswerService.answer` and restore the form from git history. Do not do this before the settlement path exists.
