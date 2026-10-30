-- ADR 0106: amend and cancel notices to the hotel, and copies to the travel agent and admin.
--
-- HotelNotice.event_key       what the notice is about, so one booking can have several notices of one kind: 'initial' for the NEW notice (the value every existing
--                             row gets), the amendment id for an AMEND, 'cancel' for a CANCEL. The unique key becomes (tenant, booking, kind, event_key); a retried
--                             amendment approval or cancellation therefore still cannot queue a second notice.
-- HotelNotice.copy_addresses  blind-copy recipients (the booking agent's account email and the admin mailbox), snapshotted when the NEW notice is queued and reused by
--                             its follow-ups. Sent as BCC so the hotel's private reservations address is never shown to an agent. At most 3 (CHECK). Never the hotel.
-- No privilege is granted by this migration (owner-run provisioning states every grant). The existing unique index is replaced inside this migration; the table is
-- new in 202612180001 and its dispatcher is off by default, so there is no traffic to lock out.
--
-- Rollback (forward migration; reviewed before use; only while the hotel notice dispatcher is stopped, and only while no booking has more than one notice per kind):
--   DROP INDEX "HotelNotice_tenant_id_booking_id_kind_event_key_key";
--   CREATE UNIQUE INDEX "HotelNotice_tenant_id_booking_id_kind_key" ON "HotelNotice"("tenant_id", "booking_id", "kind");
--   ALTER TABLE "HotelNotice" DROP CONSTRAINT "HotelNotice_copies_check", DROP CONSTRAINT "HotelNotice_event_key_check";
--   ALTER TABLE "HotelNotice" DROP COLUMN "copy_addresses", DROP COLUMN "event_key";
ALTER TABLE "HotelNotice" ADD COLUMN "event_key" TEXT NOT NULL DEFAULT 'initial';
ALTER TABLE "HotelNotice" ADD COLUMN "copy_addresses" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "HotelNotice" ADD CONSTRAINT "HotelNotice_event_key_check" CHECK (length("event_key") BETWEEN 1 AND 64);
ALTER TABLE "HotelNotice" ADD CONSTRAINT "HotelNotice_copies_check" CHECK (COALESCE(array_length("copy_addresses", 1), 0) <= 3);
DROP INDEX "HotelNotice_tenant_id_booking_id_kind_key";
CREATE UNIQUE INDEX "HotelNotice_tenant_id_booking_id_kind_event_key_key" ON "HotelNotice"("tenant_id", "booking_id", "kind", "event_key");
