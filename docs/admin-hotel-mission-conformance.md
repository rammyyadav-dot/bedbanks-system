# Hotel Operations mission: conformance record

Maps each requirement of the Hotel Operations mission (sections 3 to 12) to what exists on `main`, with evidence, and states every gap and its dependency. Written against base `2619412`. "Built" means implemented, permission-controlled, audited where it mutates, and covered by the tests named. Nothing here enables booking, payment or a live supplier.

Legend: **Built**, **Partial** (what is missing is stated), **Not built** (dependency stated).

## 3. Hotel directory
| Requirement | Status | Evidence |
|---|---|---|
| Search by name and canonical or external identifier | Built | `HS-11`; name, legacy code, canonical id, external identifiers such as GIATA |
| Server-side pagination, stable order, accurate total | Built | Directory API and `hotel-commercial` e2e |
| URL-persisted filters (destination, category, profile approval, mapping, readiness) | Built | Directory page; browser harness |
| Loading, empty, forbidden, unavailable, retry | Built | `OpsState`; harness checks 401, 403, 503, 500, network, empty |
| Hotel name **and actual image when available** | **Built in this change** | `primaryImage` on directory rows (never bytes), `AuthImage` thumbnail with initial fallback; `HI-09`; browser 18/18 |
| Canonical id, country, city, area, verified stars or Unrated, verified supplier count, room counts, profile status, sellability and timestamp, last update, permission-aware actions | Built | Directory columns; `profile` summary (ADR 0021) |
| Multiple suppliers per hotel; GIATA is not identity; Active is not sellable; unassessed is not ready | Built | Mapping rules (ADR 0004, 0021); readiness from the canonical evaluator |

## 4. Hotel profile and tabs
| Tab | Status | Notes |
|---|---|---|
| Overview | Built | Real completeness, mappings, coverage, blockers; mocks removed |
| Hotel Setup | Built | Identity, location, IANA time zone, category with verification, descriptions, operations, private contacts, owner, provenance; drafts may be incomplete; publication gated by 12 requirements and a second approver (ADR 0022). Private contacts are never in Agent responses (`HS-10`) |
| Rooms | Built | Occupancy by the canonical rule, bedding, child rules shown, archive not delete |
| Amenities | Built | Controlled catalogue, free/paid/unknown |
| Images | Built | Upload, alt text, order, primary, delete, duplicate and type checks (ADR 0027). **Partial:** source and rights records, malware scan and EXIF stripping are not built |
| Policies | Built | Apart from rate-specific cancellation terms |
| Supplier Mapping | Built | Many suppliers, decisions with reasons, never auto-approved, conflicts named |
| Contracts and Rate Plans | Built (read) | Reuses existing relationships; no `Contract.hotelId`. Booking window versus travel window display is **Partial** |
| Rates and Restrictions | Built (read and Quick Update) | Calendar with min stay, closed to arrival and departure, stop-sell, source and freshness. Supplements and nationality restrictions are **Not built** (no schema or not applied by Agent search) |
| Inventory and Allotment | Partial | Daily availability, stop-sell, held and sold. **Shared pools and release rules: Not built** (no schema) |
| Distribution and Readiness | Built | Publication separate from transaction enablement; seven-day coverage with blockers by date, room, plan, supplier; agrees with Agent search (`DR-01`, `DR-02`) |
| Audit | Built | Paginated, actor, action, time, request id, field names; redaction of contacts and text |

## 5. Hotel and room rules
Immutable canonical id, no auto-merge, per-room occupancy with mandatory child ages, bedding and view distinctions preserved, referenced records archived: **Built**. Extra-bed and child-with/without-bed charges: **Not built** (no schema). Board mapping agreement and never combining suppliers' rooms with another supplier's offer: **Built** in the evaluator.

## 6. Commercial and pricing
One canonical engine (ADR 0014, 0018): every occupied night, check-out exclusive, integer minor units, round half up per night, missing rate fails sellability, NET needs an active markup rule, calculation in the API only: **Built**. **Not built** (no policy or schema): blackout applicability model, nationality or market eligibility, promotions and stacking, per-person and per-room charge basis, currency conversion (AED only by ADR 0029), tax lines (net rates are all-inclusive, ADR 0029), commercial source and calculation version on a price.

## 7. Inventory and restrictions
Zero is unavailable, missing is unknown, requested units must exist every night, stop-sell overrides, minimum and maximum stay, closed to arrival, release days, hotel-local deadlines, search and recheck never allocate: **Built**. **Not built:** closed to departure enforcement (needs the date convention), shared pools, explicit freshness policy, free-sale and on-request semantics.

## 8. Quick Update
Scope, dates and weekdays, enabled fields, preview of exact rows and old and new values, atomic apply, stale-preview refusal, server-side revalidation, idempotency, bounded batches (5 plans, 500 plan-nights), audit with actor and request id: **Built** (`QU-01..09`). Lock Dates: deliberately **Not built** (ADR 0026, meaning undefined).

## 9. Sellability and recheck
Evaluator, structured blockers by date and entity, distinct outcomes, recheck with offer identity returning rechecked, price changed, unavailable, expired, never switching supplier, room or board: **Built**. Transaction gates stay disabled.

## 10. Security and mutation integrity
Authentication, RBAC, tenant scope, request ids, audit, idempotency, success only after persistence, no direct Prisma in the frontend: **Built** and tested (`HS-05`, `QU-08`, cross-tenant 404s, ADR 0003).

## 12. Tests and acceptance (evidence on this branch)
- API unit 595/595; full API e2e 341/341; Admin tests 39/39; type-check and lint; `pnpm check:architecture`.
- Browser, disposable local stack, production Admin build: hotels harness 163/163 (create draft, complete profile, request publication and approve, rooms, mapping, rates and Quick Update, reload, audit, sellability); images harness 18/18; operations harness separate.
- Scale: 1, 10 and 100 hotel coverage exists in the Dubai commercial and agent-search scale suites.
- Not run: hosted reference environment (not reachable), persistent databases, any live supplier.

## Remaining blockers and the decision each needs
| Item | Needs |
|---|---|
| Shared allotment pools, release rules, free-sale | Business rules and a schema design |
| Closed to departure, markets, nationalities enforcement | Date convention and market policy |
| Extra-bed and child charges, supplements | Charge model and schema |
| Promotions, stacking | Pricing policy |
| Tax-inclusive declaration on contracts | Migration; classification of existing rows (ADR 0029) |
| Lock Dates | Meaning and a rate-writing connector (ADR 0026) |
| Image rights and malware scan | Policy and a scanning service |
| Persistent database migrations | The ADR 0013 human decision |

## About the screenshot
The supplied "UAE Hotels TMS" page is another product (UAEWB) and is UI evidence only. fBeds does not share code, data, naming or branding with it, and none of its tabs (Deals and Promos, Event Master, Meal Plans, Blackout Dates, Allocation Mgmt) were copied; the equivalent fBeds capabilities are listed above with their real status.
