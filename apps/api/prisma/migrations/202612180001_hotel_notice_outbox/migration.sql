-- ADR 0106: hotel reservation notice outbox.
--
-- HotelNotice  a transactional outbox of reservation notices to the HOTEL's reservations desk. A NEW row is inserted in the SAME transaction that confirms a
--              contracted booking, so a confirmed booking always has its notice queued (or visibly FAILED) and a rolled-back confirmation queues nothing. One row
--              per booking and kind (unique), so a retried confirmation cannot queue a second notice.
--              to_address is a SNAPSHOT of HotelProfile.contacts.reservations.email at the moment of confirmation (the hotel profile is the only source). It is
--              null only when the profile had no usable reservations email, in which case the row is born FAILED with last_error_code NO_RESERVATIONS_EMAIL so
--              Operations can see it: a missing address is never silently skipped and never replaced by another contact (commercial, finance, emergency).
--              Stores the address and codes only, never guest data and never the message body: the dispatcher renders the message from the booking.
-- fbeds_hotel_notice_due_tenants(now)  SECURITY DEFINER, returns only tenant ids with a notice due. EXECUTE is granted to the booking group role by the
--              owner-run provisioning script, not here.
-- tenant_id leads every index; FORCED row-level security (tenant_id = fbeds_current_tenant_id()). No existing row, constraint, policy or grant changes.
-- No privilege is granted by this migration (owner-run provisioning states every grant).
--
-- Rollback (forward migration; reviewed before use; only while the hotel notice dispatcher is stopped):
--   DROP FUNCTION "fbeds_hotel_notice_due_tenants"(timestamp);
--   DROP TABLE "HotelNotice";
--   DROP TYPE "HotelNoticeStatus"; DROP TYPE "HotelNoticeKind";
CREATE TYPE "HotelNoticeKind" AS ENUM ('NEW', 'AMEND', 'CANCEL');
CREATE TYPE "HotelNoticeStatus" AS ENUM ('QUEUED', 'SENDING', 'RETRY_WAIT', 'SENT', 'FAILED');

CREATE TABLE "HotelNotice" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "booking_id" TEXT NOT NULL,
    "kind" "HotelNoticeKind" NOT NULL,
    "to_address" TEXT,
    "status" "HotelNoticeStatus" NOT NULL DEFAULT 'QUEUED',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "run_after" TIMESTAMP(3) NOT NULL,
    "locked_until" TIMESTAMP(3),
    "last_error_code" TEXT,
    "provider_message_id" TEXT,
    "requested_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "sent_at" TIMESTAMP(3),
    CONSTRAINT "HotelNotice_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "HotelNotice_attempts_check" CHECK ("attempt" >= 0 AND "max_attempts" BETWEEN 1 AND 10 AND "attempt" <= "max_attempts"),
    CONSTRAINT "HotelNotice_recipient_check" CHECK (("to_address" IS NULL AND "status" = 'FAILED' AND "last_error_code" = 'NO_RESERVATIONS_EMAIL')
      OR ("to_address" IS NOT NULL AND length("to_address") BETWEEN 3 AND 254 AND position('@' IN "to_address") > 1)),
    CONSTRAINT "HotelNotice_sent_check" CHECK (("status" = 'SENT') = ("sent_at" IS NOT NULL))
);
CREATE INDEX "HotelNotice_tenant_id_status_run_after_idx" ON "HotelNotice"("tenant_id", "status", "run_after");
CREATE UNIQUE INDEX "HotelNotice_tenant_id_booking_id_kind_key" ON "HotelNotice"("tenant_id", "booking_id", "kind");
ALTER TABLE "HotelNotice" ADD CONSTRAINT "HotelNotice_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HotelNotice" ADD CONSTRAINT "HotelNotice_tenant_id_booking_id_fkey" FOREIGN KEY ("tenant_id", "booking_id") REFERENCES "Booking"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "HotelNotice" ENABLE ROW LEVEL SECURITY; ALTER TABLE "HotelNotice" FORCE ROW LEVEL SECURITY;
CREATE POLICY "HotelNotice_tenant_isolation" ON "HotelNotice"
  USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());

-- Tenants with a notice to send. A SENDING row whose lock expired (a crashed dispatcher) counts as due.
CREATE FUNCTION "fbeds_hotel_notice_due_tenants"(now_ts TIMESTAMP) RETURNS SETOF TEXT AS $$
  SELECT DISTINCT n."tenant_id" FROM "HotelNotice" n
   WHERE (n."status" IN ('QUEUED', 'RETRY_WAIT') AND n."run_after" <= now_ts)
      OR (n."status" = 'SENDING' AND n."locked_until" IS NOT NULL AND n."locked_until" <= now_ts)
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION "fbeds_hotel_notice_due_tenants"(TIMESTAMP) FROM PUBLIC;
