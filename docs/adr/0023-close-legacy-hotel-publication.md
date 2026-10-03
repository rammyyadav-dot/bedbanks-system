# ADR 0023: Close the legacy hotel publication path

## Status
Accepted. No migration. Stacks on ADR 0022.

## Context
ADR 0022 made publication maker-checker, but `POST /supply/hotels` and `PATCH /supply/hotels/:hotelId` (ADR 0007 era) still accepted `contentStatus: COMPLETE` from one holder of `supply.hotels.manage`, which bypassed the second approver.

## Decisions
1. Neither endpoint can create a hotel as COMPLETE or move one to COMPLETE (409 `HOTEL_PUBLICATION_REQUIRES_APPROVAL`). This includes re-publishing a SUSPENDED hotel.
2. A PATCH that leaves a COMPLETE hotel COMPLETE (other fields edited) is unchanged.
3. DRAFT, INCOMPLETE and SUSPENDED stay settable by these endpoints. Moving a hotel down from COMPLETE clears the profile approver (`approvedById`, `approvedAt`), as the Setup status change already does.
4. The generic endpoints do not run the Setup publication requirements; they simply cannot publish.

## Consequences
- Every route to COMPLETE now goes through the approved flow. Existing e2e fixtures that published through the legacy endpoint set `contentStatus` directly in the disposable test database instead.
- Breaking for any client that sent `contentStatus: COMPLETE` to these endpoints. The Admin app, the supplier extranet and the website do not.
- Rollback: revert the API change; no data to undo.
