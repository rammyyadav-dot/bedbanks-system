-- ADR 0066: bedbank checkout details and the booking confirmation email outbox.
--
-- Booking.special_requests  non-binding requests captured at checkout ({ "codes": [...], "note": "..." }). Not part of the commercial snapshot, so it never
--                           changes price or idempotency. Free text may carry personal data: it is never logged.
-- BookingGuest.room_number  which of the identical rooms on a room line a guest sleeps in (1-based). Null for bookings made before this change.
-- BookingEmail              a transactional outbox. A row is inserted in the SAME transaction that confirms the booking (so a confirmed booking always has
--                           its email queued, and a rolled-back confirmation queues nothing). The booking module's dispatcher sends it. One row per
--                           booking and kind (unique), so a retried confirmation cannot queue a second email. It stores recipient addresses only
--                           (the booking agent's account email and up to three CC addresses), never guest contact data and never the message body:
--                           the dispatcher renders the message from the issued, immutable voucher and invoice.
-- fbeds_booking_email_due_tenants(now)  SECURITY DEFINER, returns only tenant ids with an email due, so the dispatcher can visit tenants without a
--                           cross-tenant table read. EXECUTE is granted to the booking group role by the owner-run provisioning script, not here.
-- tenant_id leads every index; FORCED row-level security (tenant_id = fbeds_current_tenant_id()). No existing row, constraint, policy or grant changes.
-- No privilege is granted by this migration (owner-run provisioning states every grant).
--
-- Rollback (forward migration; reviewed before use; only while the email dispatcher is stopped):
--   DROP FUNCTION "fbeds_booking_email_due_tenants"(timestamp);
--   DROP TABLE "BookingEmail";
--   DROP TYPE "BookingEmailStatus"; DROP TYPE "BookingEmailKind";
--   ALTER TABLE "BookingGuest" DROP COLUMN "room_number";
--   ALTER TABLE "Booking" DROP COLUMN "special_requests";
CREATE TYPE "BookingEmailKind" AS ENUM ('BOOKING_CONFIRMATION');
CREATE TYPE "BookingEmailStatus" AS ENUM ('QUEUED', 'SENDING', 'RETRY_WAIT', 'SENT', 'FAILED');

ALTER TABLE "Booking" ADD COLUMN "special_requests" JSONB;
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_special_requests_check" CHECK ("special_requests" IS NULL OR jsonb_typeof("special_requests") = 'object');

ALTER TABLE "BookingGuest" ADD COLUMN "room_number" INTEGER;
ALTER TABLE "BookingGuest" ADD CONSTRAINT "BookingGuest_room_number_check" CHECK ("room_number" IS NULL OR "room_number" BETWEEN 1 AND 8);

CREATE TABLE "BookingEmail" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "booking_id" TEXT NOT NULL,
    "kind" "BookingEmailKind" NOT NULL,
    "to_address" TEXT NOT NULL,
    "cc_addresses" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "BookingEmailStatus" NOT NULL DEFAULT 'QUEUED',
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
    CONSTRAINT "BookingEmail_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BookingEmail_attempts_check" CHECK ("attempt" >= 0 AND "max_attempts" BETWEEN 1 AND 10 AND "attempt" <= "max_attempts"),
    CONSTRAINT "BookingEmail_recipients_check" CHECK (length("to_address") BETWEEN 3 AND 254 AND position('@' IN "to_address") > 1
      AND COALESCE(array_length("cc_addresses", 1), 0) <= 3),
    CONSTRAINT "BookingEmail_sent_check" CHECK (("status" = 'SENT') = ("sent_at" IS NOT NULL))
);
CREATE INDEX "BookingEmail_tenant_id_status_run_after_idx" ON "BookingEmail"("tenant_id", "status", "run_after");
CREATE UNIQUE INDEX "BookingEmail_tenant_id_booking_id_kind_key" ON "BookingEmail"("tenant_id", "booking_id", "kind");
ALTER TABLE "BookingEmail" ADD CONSTRAINT "BookingEmail_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BookingEmail" ADD CONSTRAINT "BookingEmail_tenant_id_booking_id_fkey" FOREIGN KEY ("tenant_id", "booking_id") REFERENCES "Booking"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BookingEmail" ENABLE ROW LEVEL SECURITY; ALTER TABLE "BookingEmail" FORCE ROW LEVEL SECURITY;
CREATE POLICY "BookingEmail_tenant_isolation" ON "BookingEmail"
  USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());

-- Tenants with an email to send. A SENDING row whose lock expired (a crashed dispatcher) counts as due.
CREATE FUNCTION "fbeds_booking_email_due_tenants"(now_ts TIMESTAMP) RETURNS SETOF TEXT AS $$
  SELECT DISTINCT e."tenant_id" FROM "BookingEmail" e
   WHERE (e."status" IN ('QUEUED', 'RETRY_WAIT') AND e."run_after" <= now_ts)
      OR (e."status" = 'SENDING' AND e."locked_until" IS NOT NULL AND e."locked_until" <= now_ts)
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION "fbeds_booking_email_due_tenants"(TIMESTAMP) FROM PUBLIC;
