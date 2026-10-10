# fBeds enterprise Hotel Overview certification

Base: 94c19d0. Implementation is on feat/admin-hotel-profile-overview. The final response records the exact certified commit; evidence refers to that implementation, not a production release.

## Implementation matrix

| Requirement | Audit finding | Implemented outcome / repository evidence |
|---|---|---|
| Header and lifecycle | Header existed; archive missing | Hotel detail page preserves canonical code/id and labels profile lifecycle; Hotel Setup gains ARCHIVED via canonical ContentStatus. |
| Identity and classification | Canonical model/editor already present | HotelProfile overview renders saved identity, classification/source/verification and identifiers; edits remain in SetupPanel. |
| Structured destination | Free text only | HotelLocationFields reused for create/edit; HotelLocationsController supplies tenant-only bounded suggestions; no second destination master. |
| Contact directory | Saved private contacts already validated | HotelProfile renders reservations, commercial, finance, emergency; API and UI permission boundaries preserved. |
| Operations | Existing canonical fields | Local check-in/out, time zone and notes shown; Setup API validates writes. |
| Categorized amenities | Flat controlled catalogue | AmenityPicker and overview add presentation categories without altering codes, validation or fees. |
| Media/descriptions | APIs existed | Saved descriptions and AuthImage primary preview; genuine empty/error states and private tenant-authenticated image fetch. |
| Property policies | Existing HotelProfile.policies editor | Overview renders general hotel policies; contract cancellation rules remain separate. |
| Distribution eligibility | Shared evaluator already present | HotelOperationalSummary shows API verdict and limitations; approved content never implies sellability. |
| Dynamic checklist | API-owned completeness/readiness already present | Existing Completeness and ReadinessGates retained at top; Fix links use canonical editors. |
| Linked operations | Separate operational tabs, no consolidated overview | Rooms, contract/plan/board/market restrictions, pooled inventory coverage and governed mapping summaries reuse existing APIs with permission-dependent reads. |
| Approval/audit | Maker-checker and audit existed | Setup publication remains the sole activation path; overview shows owner, approver/editor, request/reviewer and latest audit with full history link. |
| Create/retrieve/update | Canonical endpoints existed | Improved creation controls/RBAC and shared location fields; API rejects extra identity inputs and conflicting normalized properties/references. |
| Submit/approve/activate | Canonical maker-checker existed | Reused request/approve/reject/cancel/execute operations, never parallel approval logic. |
| Suspend/archive | Suspend existed; archive missing | Existing status API gains archive and reviewed restoration, preserving all relations and IDs. |
| Duplicate/conflicting IDs | DB external/mapping uniqueness existed; property collision missing | Serialized normalized exact-identity guard for API create/edit; coded 409 responses. Existing fuzzy/ambiguous duplicates require human review. |
| Runtime/RLS | Strict runtime contract and forced RLS existed | No new grants/policies; tests provision/check restricted role only on tmpfs PostgreSQL 16. |
| Concurrency/audit | Setup tokens/idempotency existed | Serialized token checks and legacy compare-and-swap; transaction audit retained; protected private scalars remain omitted from audit. |
| Search regression | COMPLETE and commercial evaluator already authoritative | ARCHIVED remains outside Agent offers; single-night evaluator now also marks it inactive. No booking/payment/live-supplier flag changed. |

## Certification method

Node 24, pnpm 10.4.1. A fresh tmpfs pgvector PostgreSQL 16 container was migrated using the full migration chain; a second fresh database replayed the complete chain and passed drift verification. Browser testing uses the production Admin build, real Nest API and fbeds_api_login (non-owner, non-superuser, non-BYPASSRLS). The browser creates its hotel and performs actual profile/room/amenity/media/approval/archive operations; no HTTP stubs substitute for those gates. Owner connections are used only for disposable migrations and fixtures.

Commands and reusable harness:

- API: type-check, lint, build, test:unit; hotel-setup and strict-runtime-role suites, hotel-commercial/readiness/images, inventory/search-recheck/pool lifecycle, Agent hundred-hotel and transaction-gate regressions.
- Admin: type-check, lint, webpack production build, test; tools/admin-ops-verify/seed-hotel-journey.ts and verify-hotel-journey.cjs.
- Agent: existing unit suite.
- Architecture/schema guards; prisma validate/generate/migrate deploy/status/drift; fresh replay and runtime-role verification.
- Browser: PLAYWRIGHT_EXECUTABLE_PATH=/usr/bin/chromium, SHOT_DIR for evidence; 320/390/768/1280/1440px, axe on profile/operational summaries, maker/checker/read-only accounts.

API lint has one pre-existing unused eslint-disable warning in inventory-admin.service.ts; no lint errors. The existing 100-hotel test now accepts TEST_ARTIFACT_DIR instead of requiring a writable /opt/cursor/artifacts directory.

## Release gates

The final response gives PASS/FAIL and counts observed on the exact implementation commit. Local preflight results and screenshots are under docs/evidence/enterprise-hotel-overview. A local PASS is not a hosted or production certification.

Completed exact-commit certification: [ceac745 results and screenshots](evidence/enterprise-hotel-overview/certified-ceac745/README.md). Implementation commit ceac745a7757cd207845001650d12e82ef894649 passed the local gates; the later evidence-only commit does not change application code.

Required gates: canonical model/API; identity conflicts; lifecycle approval; immutable relations; RBAC/private contacts; runtime role/forced RLS; location/media/policies/amenities; authoritative commercial/search controls; admin browser; accessibility/responsive layout; API/Admin/Agent regressions; production builds; migration replay/drift; architecture/schema checks; exact-commit verification; transaction flags remain disabled.

## Limits and release constraints

- Geography suggestions cover existing tenant properties, not a worldwide destination registry. New cities require explicit entry and review; no automatic geocoding.
- Similar-name duplicate detection or merger is not authorized. Existing records are preserved. Exact normalized collisions and external/mapping identifiers are enforced.
- Runtime-role fixtures intentionally probe denied privileges; expected denial logs do not indicate a passing operation was granted extra authority.
- Hosted authentication and production database/role readiness are NOT VERIFIED. Production migration, deployment, DNS, merge, live suppliers, booking and payments are not executed or enabled.
- RLS is never weakened. No destructive migration or hotel deletion is introduced.
