# ADR 0021: Hotel Setup and Hotel Operations

## Status
Accepted for stage 1 (Hotel Setup). Adds the reviewed forward-only migration `202610120001_hotel_profile`, replayed only on disposable local databases. It carries conditional `GRANT`s for the API runtime role, which are production privilege changes in effect and need the ADR 0013 human decision before the migration is applied anywhere persistent. Later stages append to this ADR.

## Context
The Hotels module already had a directory, a Hotel 360 view and commercial tabs (ADR 0014), but the hotel record held only name, type, rating, address, city, country, coordinates, time zone, a content status and one external reference. There was nowhere to store legal name, chain, brand, area, descriptions, languages, check-in and check-out times, private contacts, hotel-level policies, classification verification, approval metadata, or external identifiers such as GIATA. Hotel content could be set to COMPLETE by anyone holding `supply.hotels.manage`, with no completeness check and no concurrency control.

## Decisions
1. **One profile per canonical hotel.** `HotelProfile` (tenant-scoped, forced RLS) holds the descriptive and operational content. It is created by the first save, so an existing hotel has no profile until then and is reported as such. `HotelExternalIdentifier` holds external identifiers apart from the canonical id: one value per scheme per hotel, unique per tenant and scheme. No existing column moved.
2. **No competing lifecycle.** `Hotel.contentStatus` (DRAFT, INCOMPLETE, COMPLETE, SUSPENDED) remains the profile approval state. Approval and star-verification metadata live on the profile.
3. **Drafts may be incomplete.** A save validates only the fields it contains. Publication (COMPLETE) is a separate gate over explicit requirements (name, type, country, city, address, coordinates, time zone, verified star category, short description, check-in and check-out times, a reservations contact, one active canonical room), evaluated by the API. A published hotel cannot lose a requirement through an edit; change the status first.
4. **Optimistic concurrency and idempotency.** Every change carries an opaque concurrency token (profile version plus the hotel's `updatedAt`, so an edit through the older hotel endpoint also invalidates an open form) and a client idempotency key. A stale token is rejected with `HOTEL_SETUP_STALE`; a repeated key returns the stored result and changes nothing.
5. **Audit.** Each change writes `hotel.setup.updated` or `hotel.setup.status_changed` in the same transaction, with actor, server request id, idempotency key, optional reason, version, changed field names and before and after values for non-private scalars only. Contacts, descriptions, notes and identifier values are never written to the audit payload.
6. **Contacts are private.** Returned only to `supply.hotels.manage`, absent from every Agent, Website and supplier response (tested against Agent search). Hotel policies are hotel information; rate cancellation terms stay on contracts and are not accepted here.
7. **Publication enables nothing transactional.** COMPLETE only makes the hotel eligible for catalogue search. Sellability still needs mapping, contract, rates and inventory, and no booking, payment or supplier path changes.
8. **Directory.** Rows gain verified supplier-mapping count and a profile summary (completeness, star verification, area, last editor, external ids). Search matches name, legacy code, exact canonical id and external identifier value. Property type and star filters are added. A denied profile read (42501) is reported as "unavailable", never as "no profile".
9. **Permissions.** No new permission key: `supply.hotels.read` and `supply.hotels.manage`.

## Known gaps and decisions for the owner
- **Legacy hotel endpoints.** `POST` and `PATCH /supply/hotels` still accept `contentStatus: COMPLETE` directly (existing end-to-end tests rely on it). The Admin UI no longer offers that path: new hotels are created as DRAFT and published through the gated status change. Closing the API path is a breaking change to be decided.
- **Single-actor approval.** Existing policy lets one holder of `supply.hotels.manage` edit and publish. This ADR does not add maker-checker; `hotel.activate` (planned, S2) is the natural place if the business wants it.
- **Images** have no approved storage mechanism in the repository, so no upload is offered and no thumbnail is shown.
- **Owner picker.** Choosing a profile owner needs a tenant member list that hotel managers cannot read; the owner field is stored but not editable in the UI.

## Consequences
- Rollback is a later forward migration (`DROP TABLE "HotelExternalIdentifier", "HotelProfile"`); do not edit the applied file.
