# fBeds Hotel Overview bugfix audit

Baseline: `b4c6a33f10e0663153f33f9c18e6cf61540357a2`, branch `feat/admin-hotel-profile-overview`, clean worktree. Prior certification applies to ceac745 only. This follow-up changes backend concurrency/approval safeguards and the verification harness; it creates no second Hotel Master, approval workflow, geography registry or sellability evaluator.

## Verified findings and fixes

| Severity | Reproduction / observed failure | Root cause | Fix / repository evidence |
|---|---|---|---|
| HIGH | Pause a reviewed draft edit after loading its snapshot; execute an approved publication; resume the edit clearing the required address. Both returned 200. | Publication did not acquire Setup's lock before reading. Setup validated its earlier DRAFT snapshot, so the timestamp check on publication alone did not prevent the later edit. | HotelPublicationService.execute takes lockHotelSetup before loading and checking its bound approval. Setup and legacy hotel writers share the helper. Concurrent edit wins and publication returns HOTEL_CHANGED_AFTER_APPROVAL. |
| HIGH | Publish a hotel with one active room, then PATCH the legacy Supply room endpoint with isActive:false. It returned 200. | Legacy room editing bypassed the last-active-room guard in canonical room archiving. | assertRoomActivationAllowed is shared by canonical and legacy room status changes; removal of the last published room returns 422 and preserves the room. |
| HIGH | Publish a hotel with two active rooms and archive both concurrently through canonical endpoints. Both returned 200. | Each transaction counted the other room before either archive committed. | Room writes serialize on the hotel lock before loading current state. One archive succeeds, the other returns 422, leaving one active room. |

Reproduction failures are retained in the bugfix evidence directory. The publication race uses a controlled pause in the real PostgreSQL/HTTP test, not production timing or fabricated inventory. The parallel room test also reproduced two successful archives on the baseline.

Related safeguards: canonical/legacy room writes call the existing touchSetup helper, invalidating approved profile versions and stale forms. Amenity saves take the same lock before checking their existing shared token. Tests cover canonical/legacy room edits after approval and concurrent amenity saves. These are regression safeguards associated with the verified concurrency defects, not separately asserted baseline reproductions.

Partial country input was investigated in the browser and did not produce a failed suggestion request; getHotelLocationOptions already filters incomplete ISO-2 input. No defect or fix is claimed for that path.

## Implementation matrix

The [enterprise implementation matrix](enterprise-hotel-overview-certification.md) documents all twelve Overview sections and their canonical APIs/models. This follow-up preserves those sections and extends these controls:

| Area | Current implementation |
|---|---|
| Identity, location, contacts, operations, descriptions, policies, media, amenities | Existing canonical fields/editors and permission boundaries retained |
| Linked rooms/contracts/plans/boards/inventory/mappings | Existing authoritative services retained; room writes now invalidate the hotel's reviewed version |
| Readiness and distribution eligibility | Existing evaluators retained; COMPLETE remains approval state, not automatic sellability |
| Approval and audit | Existing maker-checker/version/audit flow retained; execution shares the writer lock |
| Suspension/archive/restoration | Canonical status operations retained; browser coverage now includes property suspension and restoration to DRAFT |
| Concurrency and room retention | One shared hotel lock and last-active-room guard across canonical/legacy paths |
| Tenant/RBAC/RLS/runtime grants | No new grants, owner runtime access, table policies or permission bypass |
| Schema/migration | No model extension or migration required |

## Verification and release limits

Run API/Admin type-check, lint, production builds and unit tests; Agent unit regressions; selected Supply, hotel, inventory/search and restricted-role/RLS integration suites; browser create/edit/validation/media/approval/suspend/archive/restore/read-only flows; all five widths and axe; architecture/schema checks; migration replay and drift on disposable PostgreSQL 16. The browser records uncaught exceptions, unexpected console errors, server errors and observed failed HTTP responses, including intentional denial/conflict probes.

Exact implementation SHA, commands, counts, skip counts, screenshots and gate results are recorded in the later evidence-only certification commit. A local PASS does not certify hosted authentication or production database readiness; those remain NOT VERIFIED. No deployment, merge, destructive migration, record deletion, RLS weakening, live supplier activation or booking/payment enablement is authorized or performed. No UAEWB/fabBeds integration or branding change is introduced.

Completed certification: [c8d5c1b exact-commit results and screenshots](evidence/hotel-overview-bugfix/certified-c8d5c1b/README.md). All local gates passed within the stated verification scope. This linked evidence is added in a documentation-only commit after certifying the implementation.
