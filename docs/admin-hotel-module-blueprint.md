# Admin Hotel module: workflow, functioning and business rules

Audience: CTO, product, engineering, operations. Purpose: one reference for how the Admin hotel module is meant to work for fBeds Global Bedbanks, what is real today, and what is still a gap. It describes the module as built in ADR 0021 plus the open work, and says plainly where something is not built. Nothing here enables booking, payment or live supplier connections.

Status key: **Built (main)** is merged. **Built (PR #232)** is implemented and tested on an open draft PR, not yet in `main`. **Proposed** is a draft decision awaiting the owner. **Not built** has a stated dependency.

A note on the screenshot that prompted this: a hotel page with an "Image gallery placeholder" and tabs Overview, Rooms, Amenities, Images, Policies, Supplier Mapping, Rates, Inventory, Audit is the old mock. Current code has 13 tabs (below) and the Images tab states that upload is unavailable instead of showing a fake gallery. The hosted environment was not reachable from the build environment, so what a given hosted URL shows depends on what has been deployed.

## 1. What the module is for

A hotel record is the **canonical** hotel: one identity that supplier hotels are mapped to, that contracts and rates hang from, and that Agents search. The module exists so that people can (1) create and describe a hotel, (2) decide when it is fit to appear in the catalogue, (3) connect it to suppliers, (4) keep its rates and inventory true, and (5) see exactly why it is or is not sellable. It must be impossible to present a hotel as sellable without real data behind it.

## 2. Principles (the business rules everything else follows)

1. **Tenant identity comes from the session only.** No tenant id from a body, query or browser. Every hotel read and write is tenant-scoped, and a hotel of another tenant is a 404.
2. **Authentication is not authorization.** Every endpoint declares a permission (section 4).
3. **Money is integer minor units plus ISO-4217 currency.** No floats in rates, Quick Update, credit or booking code.
4. **Publication is not sellability.** A published hotel is eligible for the catalogue. It is sellable only when mapping, contract, rates and inventory also exist and pass the canonical rules. Publishing enables no booking, payment or supplier path.
5. **No invented data.** No placeholder rates, inventory, suppliers, contacts, images or discounts. Missing data is shown as missing, never as zero.
6. **Failures are visible.** An unreadable section reports "unavailable", never empty. A supplier failure is never turned into demo or stale inventory.
7. **Every privileged change is idempotent, concurrency-checked and audited** with actor, server request id and field names (never values such as contacts or descriptions).
8. **Sensitive transitions need two people** (maker-checker): publication, markup activation, agency suspension, credit limits.
9. **Nothing is deleted that other records depend on.** Rooms are archived, not deleted; mappings are reopened, not erased.

## 3. Lifecycle and states

### 3.1 Hotel profile status (`Hotel.contentStatus`)

`DRAFT` (just created) → `INCOMPLETE` (being worked) → `COMPLETE` (published) ⇄ `SUSPENDED` (withdrawn).

- Create and edit never require completeness: a draft may be partial. Only the fields sent are validated.
- **Publish (to COMPLETE)** is gated by 12 requirements: name, property type, country, city, street address, coordinates, IANA time zone, verified star category (1 to 5), short description, check-in and check-out times, a reservations contact, and at least one active room. Unmet requirements are listed by name and block the request.
- **Publication is maker-checker** (Built, PR #232, ADR 0022): a manager requests with a reason; a *different* manager approves or rejects; the approved request is applied once. The request is bound to the exact setup version reviewed. Any later edit voids it. The requirements are re-checked at request and at apply. The approver is recorded as the checker of record. A tenant therefore needs at least two people with `supply.hotels.manage` to publish.
- **Un-publish / suspend / back to draft** is single-actor and immediate, because it only removes exposure. It clears the recorded approver.
- A published hotel **cannot lose a publication requirement** through an edit (for example clearing the address): the edit is refused until the status is changed first.
- The legacy `POST/PATCH /supply/hotels` endpoints can no longer set COMPLETE (Built, PR #232, ADR 0023). Until #232 is merged they still can, which bypasses the second approver.

### 3.2 Supplier mapping status

`PENDING` → `MAPPED` or `REJECTED`; `MAPPED`/`REJECTED` → `PENDING` (reopen). Never auto-approved. Every decision needs a reason and is audited. A room mapping can be approved only when its hotel mapping is verified. Unique per (supplier, supplier hotel) and (supplier, canonical hotel). Conflicts return a coded 409 naming the colliding record.

### 3.3 Sellability (computed, never stored)

A stay is sellable per night only when all hold: hotel published and not suspended, valid 1 to 5 star rating, hotel and room mapping MAPPED, supplier ACTIVE, contract ACTIVE and in validity, rate plan ACTIVE, a rate for the occupancy and currency, availability with allotment remaining, no stop-sell. Enforced per night: stop-sell, allotment, minimum stay, closed to arrival, plan maximum stay, release days, contract validity. Recorded but **not yet applied by Agent search**: closed to departure, sales markets, nationalities (shown as "recorded, not applied", never as enforced).

## 4. Roles and permissions

| Capability | Permission | Notes |
|---|---|---|
| View hotels, setup, 360 | `supply.hotels.read` | Private contacts need `supply.hotels.manage` |
| Create/edit hotel, request or decide publication, change status, pick owner | `supply.hotels.manage` | Approver must differ from requester |
| View / manage rooms and amenities | `supply.rooms.read` / `supply.rooms.manage` | |
| View / decide mappings | `supply.mappings.read` / `supply.mappings.manage` | Reason required |
| View / manage contracts | `supply.contracts.read` / `.manage` | |
| View rates, plans, sellability | `supply.rates.read` | |
| Edit rates | `supply.rates.manage` | Quick Update needs the matching permission per field |
| Edit availability, stop-sell | `supply.availability.manage` | |
| Audit tab | `audit.read` | |

Approval-only keys (`hotel.activate`, `markup.activate`, `credit_limit.approve`, `agency.suspend`) are not granted separately; they ride on the permission they refine. Buttons in the UI mirror the server; the server decides.

## 5. Tab-by-tab functioning

| Tab | What it does and the rules | Status |
|---|---|---|
| Overview | Identity, location, classification, completeness (the 12 requirements, met or not), profile approval state, room counts, last saved by and when. | Built (main) |
| Hotel Setup | Identity (legal, chain, brand, property type, external ids such as GIATA), location (country, city, area, address, coordinates, time zone), classification (stars, source, verified flag), content (short/full description, languages), operations (check-in/out, notes), private contacts by role, hotel policies, source system, **owner** (member of the tenant, internal contact only). Saves send only changed fields, carry an idempotency key and a concurrency token; a stale token fails visibly with a reload prompt. Changing the star category clears its verification. External identifiers are unique per tenant and scheme and are not the canonical id. | Built (main) |
| Publication (Setup tab) | Request, approve, reject, withdraw, publish now (section 3.1). | Built (PR #232) |
| Rooms | Create, edit, archive, restore; never deleted. Occupancy validated by the canonical rule (max occupancy ≥ adults, bedding parsed and unknown keys preserved, contract child-age rules shown read-only). Code unique per hotel. The last active room of a published hotel cannot be archived. | Built (main) |
| Amenities | Controlled catalogue only, explicit fee type (free, paid, unknown); never free text. Hotel and room level. Shares the Setup concurrency token. | Built (main) |
| Images | Today: states that upload is unavailable. Proposed: Vercel Blob behind an API upload path, size/type/dimension limits, alt text required, primary image, audit, shown only for published hotels (ADR 0025). | **Not built; Proposed** |
| Policies | Children, extra beds, pets, accessibility, local charges, apart from rate-specific cancellation terms (those belong to rate plans). | Built (main) |
| Supplier Mapping | Many suppliers per hotel; create as PENDING; decide with a reason; reopen; history with who, when, status change, reason and request id. | Built (main) |
| Contracts & Rate Plans | Read-only 360 of contracts, plans, board bases, validity and recorded markets, labelled "recorded, not applied" where Agent search ignores them. Editing contracts is on the Contracts module. | Built (main) |
| Rates & Inventory | Calendar by plan and night: sell rate, allotment, sold, held, stop-sell, closed to arrival and departure, minimum stay, source and freshness. Missing values show as missing. | Built (main) |
| Quick Update | Previewed, atomic bulk change of selected fields on selected dates and plans: preview shows exact dates, old and new values and unsupported operations and writes nothing; apply is all-or-nothing, uses a fingerprint to refuse a stale preview, takes a per-hotel advisory lock, requires an idempotency key and reason, and audits actor and request id. Limits: 5 plans and 500 plan-nights per update. Money validated server-side as integer minor units. The hotel's own calendar day decides what is "past". | Built (main) |
| Lock Dates / Apply & Lock | Meaning undefined by the business. Proposal: freeze supplier-synced changes for chosen dates; recommended to wait for the first live rate-writing connector (ADR 0026). | **Not built; Proposed** |
| Distribution & Readiness | Separates catalogue publication, eligibility, the platform booking switch and seven-day coverage with blockers by date, room, plan and supplier; proven to agree with real Agent search. | Built (main) |
| Bookings | Bookings against this hotel (read-only). | Built (main) |
| Audit | Immutable events for this hotel with actor, server request id and field names. | Built (main) |

## 6. End-to-end workflows

### 6.1 Onboard a hotel to "sellable"
1. **Create** (Add hotel): name, type, city, country. Result: DRAFT, listed as BLOCKED, "Sellable to Agents: NO".
2. **Describe**: complete Hotel Setup, add rooms, amenities, policies. Overview shows which requirements remain.
3. **Verify stars**: a manager records the source and marks the star category verified.
4. **Publish**: maker requests with a reason, a second manager approves, then apply. Hotel becomes eligible for the catalogue only.
5. **Map**: add the supplier mapping (PENDING), then a mapping manager approves hotel then rooms with a reason.
6. **Contract and rates**: contract ACTIVE, rate plans, rates and availability loaded (Contracts module and Rates & Inventory).
7. **Check Distribution & Readiness**: the hotel is SELLABLE only when every blocker is cleared; the tab names any remaining blocker by date, room, plan and supplier.
8. **Transactions** stay governed by the platform booking switch, which this module never changes.

### 6.2 Day-to-day rate and inventory upkeep
Open Quick Update, choose plans, dates and fields, preview, review the exact before and after, apply with a reason. A stale preview is refused; a second simultaneous apply serialises. The calendar shows source and freshness so operators can see what a supplier feed last wrote.

### 6.3 Withdraw a hotel
Suspend immediately (single actor, reason required). The hotel leaves Agent search; existing holds and bookings are not touched. Re-publishing needs the full maker-checker flow again.

### 6.4 Supplier change
Reopen the mapping (reason), correct, approve again. Rate plans and mappings of an archived room are preserved.

### 6.5 Exposure control (related, Clients module)
Agencies can be suspended (maker-checker, ADR 0020) and given a credit limit that refuses new holds over the limit (maker-checker, ADR 0024, PR #232). These affect who can buy, not the hotel record.

## 7. Data model (summary)

`Hotel` (canonical identity, status, stars, address, time zone) · `HotelProfile` (descriptive and operational content, private contacts, policies, approval and star-verification metadata, version for optimistic concurrency) · `HotelExternalIdentifier` · `HotelAmenity` / `RoomAmenity` · `RoomType` (archive flag) · `SupplierHotelMapping` / `SupplierRoomMapping` · `Contract` · `RatePlan` · `DailyRate` · `DailyAvailability` · `ApprovalRequest` (maker-checker) · `AuditEvent`. All tenant-scoped with forced row-level security. Proposed: `HotelImage` (ADR 0025), `RateLock` (ADR 0026).

## 8. API surface (all under `/admin/hotels/:hotelId/...` unless noted; contracts in `@bedbanks/contracts`)

Setup read/save/status, owner candidates · rooms list/create/edit/archive/restore · amenities · mappings create/decide (`/supply/mappings`) · quick-update preview/apply · distribution (`/admin/operations/hotels/:id/distribution`) · publication request/approve/reject/cancel/execute (PR #232). Reads for the directory, 360, calendar, contracts and audit live under `/admin/operations/hotels`.

## 9. Audit, integrity and security rules

- Every mutation writes an audit event: actor, tenant, server request id, outcome, changed field names, before and after version. Contact and description text, credentials and guest data never enter the payload.
- Idempotency: the same key returns the stored result and changes nothing.
- Concurrency: an expected token on every save; mismatch is a 409 telling the operator to reload.
- Private contacts are returned only to `supply.hotels.manage`, and never reach Agent, Website or supplier APIs.
- The API database role is least-privilege; a table it cannot read is reported as "unavailable", never as empty.

## 10. Quality gates (what "real" means here)

A capability counts as real only when it persists real data, enforces permission and tenant isolation, is idempotent where it mutates, is audited, fails visibly, and has tests. Current evidence: API e2e (328 on the #232 head), Admin unit tests, and a browser harness that drives the production build in Chromium (`tools/admin-ops-verify`: 163 hotel checks, 83 operations checks, 9 credit checks). Dubai acceptance: 100-hotel scale tests exist for search and commercial assessment.

## 11. Gaps and decisions for the owner

| Item | Why it is open | Needed |
|---|---|---|
| Merge PR #232 | Publication approval and the closed legacy path are not in `main` yet; carries a migration | Review, and the ADR 0013 database-grant decision |
| Hotel images | No approved storage | Storage choice, limits (ADR 0025) |
| Lock Dates / Apply & Lock | Undefined meaning; no live connector writes rates | Define the lock, or defer (ADR 0026) |
| Allotment pools, board mapping | No schema | Business rules and a design |
| Closed-to-departure, markets, nationalities as enforced restrictions | Agent search does not apply them | Decision to implement in the evaluator, with tests |
| Publication requirement: at least one image? | Depends on images | Owner decision |
| Hotel-level approval of contract terms | Contract maker-checker is planned (`contract.approve`), not built | Business rule |
| Minimum two managers per tenant to publish | Consequence of maker-checker | Staffing or a break-glass policy (not proposed; weakens the control) |
| Migrations | Never applied to a persistent database by this work | Human decision (ADR 0013) |

## 12. Suggested rollout

1. Merge #232 after review and CI; decide the database grants. 2. Staff at least two hotel managers per tenant. 3. Import or create the Dubai hotels as drafts, complete content, request publication in batches (one approver reviews against the verification register). 4. Map and contract per supplier, then use Distribution & Readiness as the go/no-go view. 5. Decide images and locks. 6. Only then consider enabling booking, through its own gated change.

Related: `docs/admin-hotel-operations.md`, ADR 0021 (setup and operations), 0022 (publication approval), 0023 (legacy path), 0024 (credit limit), 0025 and 0026 (proposals).
