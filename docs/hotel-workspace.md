# Hotel administration workspace

Selecting a canonical Hotel ID opens six primary sections: Profile Setup, Bookings – All Reservations, Quick Update, Room Type, Rate Plan and Reports. Existing `?tab=` links remain valid; every old panel is reachable within its primary section. Profile Setup includes overview, setup, amenities, images, policies, mappings and audit. Quick Update includes the existing calendar and inventory pools. Rate Plan includes contracts and distribution/readiness.

The header retains canonical identity, mapping, suppliers and readiness, and adds room count and profile editor/time. Under Review reflects an open publication request, not incomplete content. Existing publication, suspension, duplicate checks, mapping and servicing APIs are reused.

A Hotel ID change remounts the workspace before rendering new data, discarding drafts and stale responses. Panel navigation remounts the selected editor and rereads its shared backend records. Successful Quick Update revalidates the workspace summary. Setup, policy, room and amenity forms, and Quick Update warn on link navigation and browser unload when edited. Browser history traversal within the same document is not intercepted by this guard.

## Reports

`GET /admin/operations/hotels/:hotelId/reports` and `/reports/export` require session authentication, tenant context, `supply.hotels.read` and scoped booking access. Booking financial visibility follows existing `booking.view.net` and operator-only `booking.finance.view`. The API validates dates and Hotel ID, constrains every booking read to tenant/hotel/agency, and refuses ranges exceeding 367 inclusive days or 5,000 bookings. Reads use the existing restricted booking database connection; exports use the same calculation, include metric definitions and record an audit event. Browser downloads carry the validated active-tenant header.

Reports use persisted booking money and room quantities; no hotel or rate-plan edits affect historical reporting. Stay-date reporting counts overlapping room nights and full booking values for that cohort, not allocated nightly revenue. Different currencies remain separate; reporting currency equals original currency with identity conversion. Missing values remain unavailable. Cancellation refund entitlement is distinguished from cash settlement.

## Dependencies and coverage

- No schema migration or database grant changes are introduced.
- Live verification needs configured `DATABASE_URL` and `BOOKING_OPS_DATABASE_URL` with the existing restricted-role grants, plus authenticated test users.
- Supplier synchronization and promotions are not supported by the Quick Update API. Its success state says Saved in FBEDS, not Synced. Remote retry/failure behavior requires a real integration job contract.
- Maximum stay, cancellation and payment terms remain in the existing rate-plan/contract editors; Quick Update supports its existing dated price, stock, stop-sell, minimum stay and arrival/departure restrictions.
- Guest nationality is not stored on booking guests and is reported as Unknown. Tax components and FX target-currency evidence require persisted contracts before detailed tax or converted reporting can be added.
- Existing single-room rate-plan relationships and supplier product mappings are preserved; no synthetic capabilities are introduced.

Verification includes exact-money reporting, overlapping nights across all booked rooms, missing evidence, hidden financial fields, tenant/hotel/agency scopes, range/size validation, guard wiring, legacy section URLs, and the existing Quick Update/publication rules. Browser smoke checks use isolated API fixtures; they do not establish live database or supplier connectivity.
