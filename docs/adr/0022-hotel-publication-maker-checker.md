# ADR 0022: Hotel publication maker-checker

## Status
Accepted. No migration: it reuses `ApprovalRequest` (ADR 0016) and promotes the planned catalogue key `hotel.activate` to enforced. Stacks on ADR 0021.

## Context
ADR 0021 let one holder of `supply.hotels.manage` edit a hotel and publish it (`contentStatus: COMPLETE`). Publishing makes a hotel eligible for the Agent catalogue, so it is a sensitive action. The platform already has a single-use maker-checker foundation (ADR 0016) used for markups (ADR 0018) and agency suspension (ADR 0020).

## Decisions
1. **Publishing needs two people.** `hotel.activate` is an `approvalOnly` S3 key (the catalogue requires approval-only actions to be S3) refining `supply.hotels.manage`; it is not granted separately. The maker requests, a different holder of `supply.hotels.manage` approves or rejects, and the approved request is applied once. Requester and approver differ (ApprovalService rule plus database CHECK). Anyone with `supply.hotels.manage`, including the maker, may press apply; the approver is recorded as the checker of record (`approvedById`).
2. **The request is bound to what was reviewed.** It stores the setup version (`profileVersion.updatedAt`). An edit after the request cannot be approved (409 `HOTEL_CHANGED_AFTER_REQUEST`); an edit after approval cannot be applied (409 `HOTEL_CHANGED_AFTER_APPROVAL`). An approved request for a changed version no longer blocks a new request. A pending stale request is withdrawn by its maker or rejected by another manager.
3. **Requirements are checked three times:** at request, and again when the approved request is applied (the 12 requirements from ADR 0021 decision on publication). Approval does not waive a requirement.
4. **One open request per hotel**, idempotent by the caller's `requestId`. A request cannot be decided or applied through another hotel's URL (404).
5. **`POST /setup/status` no longer accepts `to: COMPLETE`** (409 `HOTEL_PUBLICATION_REQUIRES_APPROVAL`). Un-publishing (DRAFT, INCOMPLETE, SUSPENDED) stays single-actor because it only removes exposure, and clears the approver.
6. **Audit.** Applying writes `hotel.setup.status_changed` with the approval id, the approver and the executor (the event's user), never the reason text; the approval flow writes `approval.requested`, `approval.approved|rejected|cancelled|executed` as in ADR 0016.
7. **Publishing still enables nothing transactional.** No booking, payment or supplier path changes.

## Consequences
- A tenant needs at least two people holding `supply.hotels.manage` to publish a hotel. With one, hotels stay unpublished. This is intended and not configurable.
- The Admin Setup tab gets a Publication section (request, approve, reject, withdraw, publish now); the status form no longer offers COMPLETE.
- The legacy `POST/PATCH /supply/hotels` that still accept `contentStatus: COMPLETE` bypass this flow until ADR 0023 closes them.
- Rollback: revert the API and Admin. Open requests stay in `ApprovalRequest` and are inert; no data change to undo.
