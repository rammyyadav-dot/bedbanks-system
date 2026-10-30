# ADR 0106: Redis coordination and hotel reservation notices

Status: Accepted by the owner (2026-10-30). Partly implemented; "Not built" is the honest boundary.

## Decisions (owner)
1. **Redis is approved**, for coordination only. PostgreSQL stays authoritative for inventory, holds, bookings and money; a Redis outage, flush or expiry must never change them (supersedes the "INTERFACE ONLY" status in `docs/booking-concurrency-foundation.md`).
2. **Hotels are told about contracted bookings by every supported channel**: email and channel-manager XML (OpenTravel `OTA_HotelResNotifRQ`), chosen per hotel. The product is a global bedbank, so notices are multi-language and the XML is the industry standard rather than one vendor's dialect.
3. For everything else the owner accepted the recommendations in `docs/booking-operations-completion-gap-analysis.md`: outbound webhooks under ADR 0075, PDF as a separate rendering step, and supervised overrides as proposed in ADR 0105.

## Redis scope
Used through the existing `RedisCacheAdapter` (`REDIS_URL`), no new dependency. BullMQ is **not** adopted: its queue state would be a second source of truth beside the PostgreSQL outboxes (`BookingEmail`, `BookingSupplierJob`) that already give durable retries, and it needs a client library the repo does not use. Redis is used for:
- `runExclusive` (`common/cache/single-runner.ts`): a lease so one API instance runs a scheduled sweep per interval. It fails open (no Redis, Redis down: run anyway) and a lapsed lease may overlap another instance, which is safe because every guarded job is idempotent. Wired into `HoldExpirySweeper` first.
- Existing shared connector gate and cache.
Secrets: `REDIS_URL` is a secret reference like other credentials; `rediss://` in production.

## Hotel reservation notices
- Canonical `HotelReservationNotice` (connectors-core, `hotel-notice/ota-res-notif.ts`): reference, kind NEW/AMEND/CANCEL, the hotel's own code, stay, rooms, guest names, special requests. **No price, net rate, markup or buying-agency name.** `EchoToken = <reference>-<kind>` so a retry is recognisable.
- Renderers: OTA XML (`buildOtaHotelResNotif`, escaped through `el`) and email (`renderHotelNoticeEmail`) in `en`, `ar` (right-to-left), `fr`, `es`. Subjects never carry guest names.
- Guest names are personal data sent to a third party: the outbox must store recipients and ids only, never the rendered body, and nothing logs a notice (invariant 7).

## Not built (do not present as capability, invariant 10)
- **The outbox and dispatcher.** Needs a reviewed migration (a `HotelNotice` table per hotel/booking/kind/channel with forced RLS, tenant indexes, rollback notes), a hotel channel configuration (email address or XML endpoint + secret reference, locale, consent), a booking-role grant, and a dispatcher modelled on `BookingEmailDispatcher` (ADR 0066) and the XML transport SSRF rules. Until then nothing is sent to any hotel.
- Receiving a hotel's OTA response / confirmation number.
- Translation review by native speakers; legal wording for tax invoices.
- PDF engine, outbound webhooks, ADR 0105 overrides, `penaltySchedule` route.
- `BookingLifecycleJobs`, the email dispatcher and the supplier runner do not yet use `runExclusive`.

## Rollback
Unset `REDIS_URL`; every instance sweeps again (ADR 0005 behaviour). The notice builders are unreferenced pure code.
