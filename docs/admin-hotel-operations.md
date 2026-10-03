# Admin Hotel Operations (Dubai MVP)

Hotel Operations turns the Hotels directory and hotel detail into the authoritative place to set up, publish, map, price and check a hotel.
Every figure, state and verdict comes from the API; the browser renders and submits. Decisions are in [ADR 0021](adr/0021-hotel-setup-and-operations.md).

## Tabs on a hotel

| Tab | What it does | Source |
|---|---|---|
| Overview | Completeness against explicit publication requirements, profile approval, rooms and mappings, commercial gates and issues, recent changes | `GET /admin/hotels/:id/setup`, `GET /admin/operations/hotels/:id` |
| Hotel Setup | Identity, external identifiers (GIATA style), location, classification, content, operations, private contacts, governance; gated publication | `GET`/`PATCH /admin/hotels/:id/setup`, `POST .../setup/status` |
| Rooms | Create, edit, archive and restore canonical rooms; bedding and extra beds; room amenities; read-only contract child-age rules | `/admin/hotels/:id/rooms*` |
| Amenities | Hotel amenities from the controlled catalogue with free, paid or unknown fee type | `GET`/`PUT /admin/hotels/:id/amenities` |
| Images | States the missing storage dependency. No upload is offered | none |
| Policies | Hotel information policies, apart from read-only contract cancellation terms | Setup API, `GET /supply/contracts/:id` |
| Supplier Mapping | Many suppliers per hotel, PENDING REVIEW / VERIFIED / REJECTED, decisions with a reason, room mappings, mapping history | `/supply/mappings/*`, hotel audit |
| Contracts & Rate Plans | Contracts, validity, currency, recorded markets, rate plans, board, occupancy | `GET /admin/operations/hotels/:id/contracts` |
| Rates & Inventory | Per-night rate, basis, allotment, sold, held, remaining, stop-sell, minimum stay, closed to arrival and departure, source stamps | `GET .../calendar` |
| Quick Update | Previewed, atomic change to price, availability and restrictions over bounded scopes | `POST /admin/hotels/:id/quick-update/preview` and `/apply` |
| Distribution & Readiness | Catalogue publication, eligibility, transaction switch, seven-day coverage, blockers, stay evaluator | `GET .../distribution`, `GET .../sellability` |
| Bookings, Audit | Existing views | existing |

## Rules that hold everywhere

- Tenant comes from the authenticated session. A hotel, room, plan or mapping of another tenant is a 404 or a refused reference.
- Authorization is explicit per call and uses existing `supply.*` keys; no key was added.
- Changes carry an idempotency key and, where a record can be edited by two people, a concurrency token. A stale token is a 409 with a code.
- Every change writes an audit event with actor, server request id, reason where required and field names. Contacts, descriptions, notes and identifier values are never written to audit.
- Money is integer minor units plus ISO currency. Quick Update converts with `@bedbanks/money`.
- Publishing needs two people (ADR 0022): one manager requests, a different manager approves, then it is applied once; an edit in between voids the request.
- Publishing a hotel is catalogue state. It does not enable booking, payment or any supplier connection.

## Not built, and why

| Capability | Why |
|---|---|
| Image upload, ordering, cover, rights | No approved storage mechanism exists in the repository |
| Lock Dates and Apply & Lock | Lock scope, permissions, expiry and override behaviour are undefined |
| Allotment pools | The schema has no shared pool; inventory is per rate plan |
| Board basis mapping | The schema has no supplier board code mapping |
| Closed to departure, sales markets, nationalities as restrictions | Stored, but Agent search does not apply them, so they are shown as recorded and not editable in Quick Update |
| Closing `POST`/`PATCH /supply/hotels` to `contentStatus: COMPLETE` | Existing end-to-end flows depend on it; decision for the owner |

## Migrations (forward-only, unapplied to any persistent database)

- `202610120001_hotel_profile`: `HotelProfile`, `HotelExternalIdentifier`.
- `202610130001_hotel_amenities`: `HotelAmenity`, `RoomAmenity`, `AmenityFeeType`.

Both carry conditional `GRANT`s for `fbeds_api` that need the ADR 0013 decision before any persistent environment. Without the grants the API reports the affected sections as unavailable, never as empty.

## Verification

```
pnpm check:architecture && pnpm check:schema && pnpm type-check && pnpm lint
pnpm --filter @bedbanks/api test                      # needs the disposable fbeds_ci database
tools/admin-ops-verify/README.md                       # seed-hotels.ts then verify-hotels.cjs (browser, 160 checks)
```
