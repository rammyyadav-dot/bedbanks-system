# Supplier extranet (Hotel / DMC) — CTO audit and build plan

Date: 2026-10-12. Scope: `apps/supplier`, `apps/api/src/supplier-extranet`, the supply data model, and the admin surfaces a supplier depends on.
Method: read of the code, schema, migrations and ADRs on branch `claude/happy-bardeen-m77n83`. Nothing was run against a database; findings about runtime behaviour are from source, not observation.

The older `apps/supplier/CTO_AUDIT_REPORT.md` (2026-09-19) is **stale**: it describes a mock-data portal. That portal no longer exists. Treat this document as current.

## 1. Verdict

The extranet is a **small, correctly secured foundation, not a product**. What exists is trustworthy; almost everything a hotel or DMC needs day to day does not exist.

| Capability | State today |
|---|---|
| Sign-in, opaque session, same-origin proxy (ADR 0010) | Real |
| Organization membership and isolation (ADR 0011) | Real, RLS plus application filters |
| Mapped hotels list/detail (read) | Real |
| Rooms list (read) | Real |
| Private room note (500 chars, audited) | Real |
| Contracts and rate-plan summaries (read, no amounts) | **Added in this change** (ADR 0061 slice 1) |
| Everything else in the sidebar (rates, availability, allotments, promotions, restrictions, bookings, vouchers, invoices, reports, team, settings, profile, support) | Honest "unavailable" screens |

Security posture is the strength: no tenant or supplier id is trusted from the client, deny-by-default membership resolution, forced RLS on the new tables, audit on the one write. Product coverage is the weakness.

## 2. What a global bedbank extranet must do (benchmark)

Hotelbeds/TBO/WebBeds/Expedia-Partner-style extranets share one loop: **load contract and static content → load rates and availability → receive bookings → confirm → invoice and get paid**. Concretely:

1. Property and room content (photos, facilities, policies) with a review workflow.
2. Rate plans per room: seasonal/day rates, occupancy pricing, board, taxes, child rules, cancellation, release, min/max stay.
3. Availability: allotments, stop-sale, close-out, bulk calendar edit, CSV/Excel upload, channel-manager (OTA XML) connectivity.
4. Promotions and supplements (early bird, long stay, free night).
5. Reservations: new / modified / cancelled queue, accept / reject / on-request answer, voucher and rooming list, SLA timers.
6. Finance: statements, invoices, payment status, commission/net, dispute.
7. Team and roles, notifications, audit trail, API credentials.
8. Reporting: production, cancellations, pace.

## 3. Findings

Severity: **C** critical to the target product, **H** high, **M** medium. IDs are stable for the roadmap.

### Architecture and data model
- **H1 – Booking is not linked to a supplier organization.** `Booking.supplier` is a free string (a connector key), and bookings carry no `supplierId` FK. A supplier-facing reservations queue cannot be scoped safely until a tenant-consistent link exists. This is the main blocker for bookings, vouchers, invoices and reports. Do not "match by name".
- **H2 – `Contract` has no hotel; `RoomType` has no supplier** (ADR 0011). A contract reaches a hotel only through the optional `supplierHotelMappingId`. Contracts without a mapping show as "not linked". Hotel-level rate editing needs this relationship decided in an ADR, not in a UI.
- **H3 – Suppliers cannot write any commercial data.** All rate, contract, availability and pool writes exist only on admin `supply.*` routes (`/supply/...`), gated by admin permissions and the four-eye activation flow (ADR 0057). There is no supplier-submitted, reviewable change set, so the "extranet" cannot yet reduce the admin team's data-entry load — the commercial reason it exists.
- **M1 – Draft model is a single note.** `SupplierRoomDraft` only holds `supplierNotes`. A proper submission model (versioned change set, validation report, submit → review → apply) is needed before any rate or availability screen.

### API and contracts
- **H4 – Response shapes were not in `@bedbanks/contracts`** (invariant 4). Only route strings were. The portal hand-parsed untyped JSON with defaulting (`typeof x === 'string' ? x : ''`), which turns an API regression into blank cells instead of an error. Fixed for the new route; the existing hotels/rooms/context parsers should migrate to shared types (follow-up).
- **M2 – Permission check per request re-queries role tables** (`permissionKeys`) on every call, including twice on `context`. Acceptable at current volume; cache per request before adding more routes.
- **M3 – No pagination** on hotels/rooms. The new contracts route caps at 200 contracts and 200 plans per contract. Real DMC portfolios (thousands of hotels) need cursor pagination before launch.
- **M4 – No supplier-side idempotency/concurrency pattern defined yet** for future writes (invariant 6). The existing draft PATCH is a last-write-wins upsert, acceptable only for a private note.

### Portal (UX and honesty)
- **H5 – Eleven nav destinations lead to "unavailable".** This is honest (invariant 10) and should stay, but the sidebar sells a product that is not there. Group unavailable modules under a "Coming" section or hide them per environment flag.
- **M5 – No onboarding.** There is no way for a new hotel/DMC to apply, upload documents, or see review status; organizations and memberships are created by operators in SQL/admin. `/supplier-profile` is a placeholder.
- **M6 – No notification, no SLA clocks, no support channel.**
- **M7 – No browser tests in CI for the portal**; only four unit tests (`lib/runtime.test.ts`). The extranet API has an e2e spec (`supplier-extranet.e2e-spec.ts`) that requires a database.
- **M8 – Money:** `apps/supplier` imports `@bedbanks/money` and `formatMoney` takes a JS `number` of minor units. Prices are `BigInt` in the schema; a `number` loses precision above 2^53 minor units. Not reachable for realistic rates, but a `bigint`/string wire type should be fixed before amounts are shown.

### Security (all pass unless noted)
- Tenant from authenticated context only: **pass**. Organization from membership, header only selects: **pass**. Deny-by-default on suspended/revoked: **pass**. No PII or notes in audit payload: **pass**.
- **M9 – Membership lifecycle has no UI/API** (invite, suspend, revoke, role). Operators must write rows directly, with no audit event. Privileged mutation without audit violates invariant 8 once done by hand; build the admin path first.
- **M10 – No MFA / API-key option for supplier users.** Required before suppliers manage rates or banking details.

## 4. Roadmap (each slice = ADR section + migration + contracts + API + portal + e2e)

| # | Slice | Depends on | Why this order |
|---|---|---|---|
| 1 | Read-only contracts and rate-plan summaries — **done in this change** | – | Zero write risk; proves contract-typed read models |
| 2 | Link `Booking` to supplier organization (nullable FK, backfill by connector key mapping, tenant-consistent composite FK) + read-only reservations queue | ADR (H1) | Unblocks everything operational |
| 3 | Reservation answer: accept / reject / on-request with supplier ref, idempotent, audited, feeding the existing `booking-ops` supplier-answer path | 2 | First revenue-relevant write |
| 4 | Supplier change-set model (versioned submission: stop-sale, availability, rate lines) → validation → admin review queue → apply through existing `supply.*` services | ADR (H3), pagination | Moves data entry to suppliers without bypassing four-eye control |
| 5 | Calendar UI for availability/stop-sale on top of slice 4, CSV upload with a row-level error report | 4 | Daily-use screen |
| 6 | Vouchers/rooming list (read) and invoices/statements (read, integer minor units + currency) | 2, finance model | Reconciliation trust |
| 7 | Membership management, invitations, MFA, API credentials (encrypted refs) | audit event design | Self-service, security |
| 8 | Onboarding and content submission (photos, facilities) with review | ADR 0025/0027 reuse | Supply growth |
| 9 | Channel-manager / XML connectivity self-service on the ADR 0060 connector kit | 4 | Scale |

Out of scope until decided: payments/payouts to suppliers, commission negotiation, dynamic repricing.

## 5. What this change delivers

- `GET /supplier/extranet/contracts` with permission `supplier.extranet.contracts.read`, scoped by tenant and the caller's active organization; contracts attached to a rejected mapping are hidden; capped at 200 × 200; no amounts.
- Shared types in `@bedbanks/contracts` (`supplier-extranet.ts`) and the route string.
- Migration `202611160001_supplier_extranet_contracts_read` (permission row only, rollback notes included; no table or grant change).
- Portal `/contracts` as a read-only table; failure renders an explicit unavailable state, never substitute data.
- ADR 0061 recording the roadmap and decisions that must be taken before slices 2–4.

### Verification actually performed
`pnpm check:architecture`, `type-check` (api, supplier, contracts build), `lint` (0 errors), supplier unit tests (4 pass).
### Not performed
No database was available, so the migration was not applied, **no e2e test was written or run for the new route**, and the page was not rendered in a browser. Before merge: apply the migration to a scratch database, add cases to `supplier-extranet.e2e-spec.ts` (cross-organization contract invisible, rejected-mapping contract hidden, missing permission → 403), and grant the new permission to supplier roles through the normal role-assignment path (no role is granted it automatically).
