# ADR 0106: Redis coordination and hotel reservation notices

Status: Accepted by the owner (2026-10-30). Partly implemented; "Not built" is the honest boundary.

## Decisions (owner)
1. **Redis is approved**, for coordination only. PostgreSQL stays authoritative for inventory, holds, bookings and money; a Redis outage, flush or expiry must never change them (supersedes the "INTERFACE ONLY" status in `docs/booking-concurrency-foundation.md`).
2. **Hotels are told about contracted bookings by every supported channel**: email and channel-manager XML (OpenTravel `OTA_HotelResNotifRQ`), chosen per hotel. The product is a global bedbank, so notices are English-only and the XML is the industry standard rather than one vendor's dialect.
3. For everything else the owner accepted the recommendations in `docs/booking-operations-completion-gap-analysis.md`: outbound webhooks under ADR 0075, PDF as a separate rendering step, and supervised overrides as proposed in ADR 0105.

## Redis scope
Used through the existing `RedisCacheAdapter` (`REDIS_URL`), no new dependency. BullMQ is **not** adopted: its queue state would be a second source of truth beside the PostgreSQL outboxes (`BookingEmail`, `BookingSupplierJob`) that already give durable retries, and it needs a client library the repo does not use. Redis is used for:
- `runExclusive` (`common/cache/single-runner.ts`): a lease so one API instance runs a scheduled sweep per interval. It fails open (no Redis, Redis down: run anyway) and a lapsed lease may overlap another instance, which is safe because every guarded job is idempotent. Wired into `HoldExpirySweeper` first.
- Existing shared connector gate and cache.
Secrets: `REDIS_URL` is a secret reference like other credentials; `rediss://` in production.

## Hotel reservation notices
- Canonical `HotelReservationNotice` (connectors-core, `hotel-notice/ota-res-notif.ts`): reference, kind NEW/AMEND/CANCEL, the hotel's own code, stay, rooms, guest names, special requests. **No price, net rate, markup or buying-agency name.** `EchoToken = <reference>-<kind>` so a retry is recognisable.
- Renderers: OTA XML (`buildOtaHotelResNotif`, escaped through `el`) and email (`renderHotelNoticeEmail`), English only (owner decision, 2026-10-30; other languages are out of scope). Subjects never carry guest names.
- Guest names are personal data sent to a third party: the outbox must store recipients and ids only, never the rendered body, and nothing logs a notice (invariant 7).

## Hotel email address: the hotel profile (owner decision, 2026-10-30)
The recipient is **only** `HotelProfile.contacts.reservations.email`, as filled in on the hotel profile (Hotel Setup, ADR 0021). Commercial, finance and emergency contacts are never a fallback, and an address that is not exactly one valid mailbox is treated as absent (`resolveHotelNoticeRecipient`).
- The address is **snapshotted** on the outbox row when the booking is confirmed, so a later profile edit cannot redirect a notice already queued, and the sending role never needs to read `Hotel` or `HotelProfile`.
- No usable address: the row is born `FAILED` with `NO_RESERVATIONS_EMAIL` and an audit event `booking.hotel_notice.failed`. The booking is **not** blocked; Operations sees the gap and fixes the profile. Re-queueing after the profile is fixed is not built.
- The "Reservations contact" completeness rule currently accepts a phone number instead of an email. A hotel with only a phone will therefore pass publication checks but get a FAILED notice. Whether publication should require the email is an open owner question.

## Built (verified on PostgreSQL 16 with the full migration history)
- Migration `202612180001_hotel_notice_outbox`: `HotelNotice` (forced RLS, tenant-first indexes, unique per booking and kind, recipient/attempt/sent CHECKs) and the `fbeds_hotel_notice_due_tenants` function. No grant in the migration; rollback notes inside.
- `queueHotelNotice`: called inside the existing confirmation transaction, so 25 simultaneous confirmations still yield one notice (e2e).
- `HotelNoticeDispatcher`: modelled on `BookingEmailDispatcher` (SKIP LOCKED claim, retries after 1, 5, 15 and 60 minutes, permanent rejection final, a lost last attempt is never resent, the booking must still be `CONFIRMED`). Off unless `HOTEL_NOTICE_DISPATCH_ENABLED=true`; same `EMAIL_FROM`/`EMAIL_SES_REGION` and `BOOKING_OPS_DATABASE_URL` as the confirmation email.
- Booking-role grants: SELECT on `HotelNotice`, UPDATE on progress columns only (never the recipient or keys), EXECUTE on the due-tenants function. The API runtime role holds nothing on it.

## Owner actions before enabling
1. Deploy migration `202612180001_hotel_notice_outbox` through the approved release process.
2. Re-run the booking-ops role provisioning (`ops:provision-booking-ops-role`) so the new grants exist; the dispatcher will refuse to start without them.
3. Confirm SES sender verification (the same as ADR 0066), then set `HOTEL_NOTICE_DISPATCH_ENABLED=true`.
4. Until hotels have a reservations email on their profile, expect `NO_RESERVATIONS_EMAIL` notices.

## Not built (do not present as capability, invariant 10)
- **AMEND and CANCEL notices.** The enum has them and the renderers handle them, but nothing queues them yet (they would be queued by the booking-role amendment and cancellation paths, which need INSERT on `HotelNotice`).
- **Channel-manager XML delivery.** `buildOtaHotelResNotif` exists but there is no per-hotel endpoint configuration, secret reference, transport or dispatcher, and the hotel profile has no field for them. Email is the only live channel.
- Receiving a hotel's response or confirmation number; a resend / re-queue action; an Operations view of notices.
- PDF engine, outbound webhooks, ADR 0105 overrides, `penaltySchedule` route.
- `BookingLifecycleJobs`, the email dispatchers and the supplier runner do not yet use `runExclusive`.

## Rollback
Unset `REDIS_URL`; every instance sweeps again (ADR 0005 behaviour). Set `HOTEL_NOTICE_DISPATCH_ENABLED=false` to stop sending; confirmation keeps queuing rows, which wait. To remove the feature entirely, stop the dispatcher and follow the rollback notes in the migration.
