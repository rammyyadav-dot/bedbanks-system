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

## Amend and cancel notices, and copies (owner decision, 2026-10-30)
- **CANCEL** is queued by `transitionBooking` whenever a booking reaches `CANCELLED`, whichever route did it (agent, operator, supplier answer, runner), in the same transaction. **AMEND** is queued when an amendment is **approved** and changes the stay or occupancy (a rejection, or an approval that changes nothing, queues nothing).
- A follow-up goes **only to a hotel that we told**: it copies the address and copies from the booking's NEW notice (so the booking role needs no access to the hotel profile). A booking with no NEW notice (not sold from contracted inventory, or confirmed before notices existed) queues nothing. If the NEW notice never had an address, the follow-up is born `FAILED` (`NO_RESERVATIONS_EMAIL`), visible like the original.
- A follow-up is **sent** only after the NEW notice was `SENT` (it waits while that is pending, and stops with `HOTEL_NEVER_NOTIFIED` if it failed), and only while it is still true: AMEND needs the booking `CONFIRMED`, CANCEL needs it `CANCELLED`.
- Each notice is identified by (booking, kind, `event_key`): `initial`, the amendment id, or `cancel`. A repeat of the same approval or cancellation queues nothing more.
- **Travel agent and admin copies:** the booking agent's account email (from the session, as for the confirmation email) and the single admin mailbox `HOTEL_NOTICE_ADMIN_COPY_EMAIL` are snapshotted on the NEW notice (at most three, deduplicated, never the hotel's own address) and reused by follow-ups. They are **blind copies in the same send**, so a failure can never resend to the hotel, the hotel's private desk address is not shown to agents (contacts are private, ADR 0021), and no one sees the others. A copy is identical to what the hotel received; it is not a separate message.
- Migration `202612190001_hotel_notice_followups_and_copies` adds `event_key`, `copy_addresses` and the new unique key. The booking role gains INSERT on `HotelNotice` (re-run `ops:provision-booking-ops-role`).

## Built (verified on PostgreSQL 16 with the full migration history)
- NEW, AMEND and CANCEL notices queued in the transaction that changes the booking, and sent by `HotelNoticeDispatcher` (SKIP LOCKED claim, retries after 1, 5, 15 and 60 minutes, permanent rejection final, a lost last attempt never resent). Off unless `HOTEL_NOTICE_DISPATCH_ENABLED=true`; same `EMAIL_FROM`/`EMAIL_SES_REGION` and `BOOKING_OPS_DATABASE_URL` as the confirmation email.
- Verified by the confirmation, cancellation (including 25 simultaneous cancellations) and amendment e2e suites, the last under the strict booking role, plus the role-provisioning e2e.

## Owner actions before enabling
1. Deploy migrations `202612180001_hotel_notice_outbox` and `202612190001_hotel_notice_followups_and_copies`.
2. Re-run `ops:provision-booking-ops-role` (SELECT/UPDATE/INSERT on `HotelNotice`, EXECUTE on the due-tenants function); the dispatcher and the follow-ups need it.
3. Set `HOTEL_NOTICE_ADMIN_COPY_EMAIL` to the mailbox that should receive admin copies (optional; unset means agent copies only).
4. Confirm SES sender verification (as ADR 0066), then set `HOTEL_NOTICE_DISPATCH_ENABLED=true`.
5. Until hotels have a reservations email on their profile, expect `NO_RESERVATIONS_EMAIL` notices.

## Not built (do not present as capability, invariant 10)
- **Channel-manager XML delivery.** `buildOtaHotelResNotif` exists but there is no per-hotel endpoint configuration, secret reference, transport or dispatcher, and the hotel profile has no field for them. Email is the only live channel.
- **Notices for bookings confirmed by operators** (`recordConfirmed`, on-request) or sold by a live supplier: the hotel there is the supplier's concern, and no NEW notice is queued, so no follow-ups either.
- **Re-sending to a corrected address.** A follow-up reuses the NEW notice's snapshotted address; fixing the hotel profile afterwards does not re-queue a `FAILED` notice. A resend/re-queue action and an Operations view of notices are not built.
- A copy is not a distinct message (no "copy" banner), and the admin copy is one mailbox, not a per-tenant list.
- Receiving a hotel's response or confirmation number.
- PDF engine, outbound webhooks, ADR 0105 overrides, `penaltySchedule` route.
- `BookingLifecycleJobs`, the email dispatchers and the supplier runner do not yet use `runExclusive`.

## Rollback
Unset `REDIS_URL`; every instance sweeps again (ADR 0005 behaviour). Set `HOTEL_NOTICE_DISPATCH_ENABLED=false` to stop sending; confirmation keeps queuing rows, which wait. To remove the feature entirely, stop the dispatcher and follow the rollback notes in the migration.
