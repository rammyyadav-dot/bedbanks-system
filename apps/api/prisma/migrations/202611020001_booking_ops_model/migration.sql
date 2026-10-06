-- ADR 0039, Phase 1: the Admin booking module's data model. Forward-only.
--
-- What changes
--   Booking        +agency_id, agent_user_id, channel, agent_ref, supplier_status, supplier_ref, hotel_confirmation_no, check_in, check_out, nights,
--                  net_minor, markup_minor, fx_rate, payment_mode, payment_status, is_refundable, cancel_deadline, assigned_to_id, version, closed_at.
--                  Every column is nullable or defaulted, so no existing row becomes invalid. A null means "unknown", never zero or false.
--   BookingRoom, BookingGuest, BookingEvent: new, tenant-composite keys, FORCED row-level security (tenant_id = fbeds_current_tenant_id()).
--   Agency         +unique (tenant_id, id) so a booking's agency link is tenant-composite.
--   BookingEvent   is immutable: a trigger rejects UPDATE and DELETE.
-- What does not change: the API runtime role (fbeds_api) receives NO grant on any booking table. The booking module reads through its own
--   limited role (see src/database/booking-ops-role.ts), provisioned by an owner-run script, not by this migration.
--
-- Backfill (deterministic, from data already stored; anything not derivable stays null)
--   check_in, check_out, nights  <- search_snapshot.checkIn / checkOut when both are real dates and check_out > check_in
--   supplier_ref, supplier_status <- the latest acknowledged BOOK SupplierMutation that carries a supplier reference
--   agent_user_id, agency_id     <- the first USER audit event of the booking's prebook, then that user's AgencyMember row. No evidence: "Unassigned"
--   BookingRoom                   <- one row per booking from the snapshot (occupancy per room, quantity = rooms), sell = total_minor
--   BookingGuest                  <- the lead guest recorded in the snapshot
--   BookingEvent                  <- one row per booking: from null to the current status, payload.backfill = true. Earlier history is in the audit trail.
-- The backfill runs per tenant with the tenant context set, so it also works for an owner subject to forced row-level security.
--
-- Rollback notes: columns and tables can be dropped in reverse order of creation once nothing reads them; no existing column was altered or
--   dropped. Dropping Booking_tenant_id_id_key requires dropping the three child tables first. The child tables cascade from Booking, so deleting a
--   booking (which the application never does) removes its rooms, guests and log.
-- Tenant-index review: every new index leads with tenant_id; the three child tables are keyed (tenant_id, booking_id).

-- CreateEnum
CREATE TYPE "BookingChannel" AS ENUM ('PORTAL', 'API', 'MANUAL');

-- CreateEnum
CREATE TYPE "BookingPaymentMode" AS ENUM ('CREDIT', 'PREPAID', 'PAY_AT_HOTEL');

-- CreateEnum
CREATE TYPE "BookingPaymentStatus" AS ENUM ('PAID', 'UNPAID', 'OVERDUE');

-- CreateEnum
CREATE TYPE "BookingGuestType" AS ENUM ('ADULT', 'CHILD');

-- CreateEnum
CREATE TYPE "BookingActorType" AS ENUM ('USER', 'SYSTEM', 'SUPPLIER');

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "agency_id" TEXT,
ADD COLUMN     "agent_ref" TEXT,
ADD COLUMN     "agent_user_id" TEXT,
ADD COLUMN     "assigned_to_id" TEXT,
ADD COLUMN     "cancel_deadline" TIMESTAMP(3),
ADD COLUMN     "channel" "BookingChannel" NOT NULL DEFAULT 'PORTAL',
ADD COLUMN     "check_in" DATE,
ADD COLUMN     "check_out" DATE,
ADD COLUMN     "closed_at" TIMESTAMP(3),
ADD COLUMN     "fx_rate" DECIMAL(18,8),
ADD COLUMN     "hotel_confirmation_no" TEXT,
ADD COLUMN     "is_refundable" BOOLEAN,
ADD COLUMN     "markup_minor" BIGINT,
ADD COLUMN     "net_minor" BIGINT,
ADD COLUMN     "nights" INTEGER,
ADD COLUMN     "payment_mode" "BookingPaymentMode",
ADD COLUMN     "payment_status" "BookingPaymentStatus",
ADD COLUMN     "supplier_ref" TEXT,
ADD COLUMN     "supplier_status" TEXT,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "BookingRoom" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "booking_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 1,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "room_type_id" TEXT,
    "room_name" TEXT,
    "board_code" TEXT,
    "adults" INTEGER NOT NULL,
    "children" INTEGER NOT NULL DEFAULT 0,
    "child_ages" INTEGER[],
    "rate_key" TEXT,
    "sell_minor" BIGINT,
    "net_minor" BIGINT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingRoom_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingGuest" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "booking_id" TEXT NOT NULL,
    "room_id" TEXT,
    "title" TEXT,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "is_lead" BOOLEAN NOT NULL DEFAULT false,
    "type" "BookingGuestType" NOT NULL DEFAULT 'ADULT',
    "age" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingGuest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingEvent" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "booking_id" TEXT NOT NULL,
    "from_status" "BookingStatus",
    "to_status" "BookingStatus" NOT NULL,
    "actor_type" "BookingActorType" NOT NULL,
    "actor_id" TEXT,
    "reason" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BookingRoom_tenant_id_booking_id_idx" ON "BookingRoom"("tenant_id", "booking_id");

-- CreateIndex
CREATE UNIQUE INDEX "BookingRoom_tenant_id_id_key" ON "BookingRoom"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "BookingGuest_tenant_id_booking_id_idx" ON "BookingGuest"("tenant_id", "booking_id");

-- CreateIndex
CREATE INDEX "BookingGuest_tenant_id_last_name_idx" ON "BookingGuest"("tenant_id", "last_name");

-- CreateIndex
CREATE INDEX "BookingEvent_tenant_id_booking_id_created_at_idx" ON "BookingEvent"("tenant_id", "booking_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "Agency_tenant_id_id_key" ON "Agency"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "Booking_tenant_id_status_check_in_idx" ON "Booking"("tenant_id", "status", "check_in");

-- CreateIndex
CREATE INDEX "Booking_tenant_id_agency_id_status_idx" ON "Booking"("tenant_id", "agency_id", "status");

-- CreateIndex
CREATE INDEX "Booking_tenant_id_supplier_ref_idx" ON "Booking"("tenant_id", "supplier_ref");

-- CreateIndex
CREATE INDEX "Booking_tenant_id_hotel_confirmation_no_idx" ON "Booking"("tenant_id", "hotel_confirmation_no");

-- CreateIndex
CREATE INDEX "Booking_tenant_id_agent_ref_idx" ON "Booking"("tenant_id", "agent_ref");

-- CreateIndex
CREATE INDEX "Booking_tenant_id_cancel_deadline_idx" ON "Booking"("tenant_id", "cancel_deadline");

-- CreateIndex
CREATE INDEX "Booking_tenant_id_created_at_idx" ON "Booking"("tenant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "Booking_tenant_id_id_key" ON "Booking"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_tenant_id_agency_id_fkey" FOREIGN KEY ("tenant_id", "agency_id") REFERENCES "Agency"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_agent_user_id_fkey" FOREIGN KEY ("agent_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_assigned_to_id_fkey" FOREIGN KEY ("assigned_to_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingRoom" ADD CONSTRAINT "BookingRoom_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingRoom" ADD CONSTRAINT "BookingRoom_tenant_id_booking_id_fkey" FOREIGN KEY ("tenant_id", "booking_id") REFERENCES "Booking"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingGuest" ADD CONSTRAINT "BookingGuest_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingGuest" ADD CONSTRAINT "BookingGuest_tenant_id_booking_id_fkey" FOREIGN KEY ("tenant_id", "booking_id") REFERENCES "Booking"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingGuest" ADD CONSTRAINT "BookingGuest_tenant_id_room_id_fkey" FOREIGN KEY ("tenant_id", "room_id") REFERENCES "BookingRoom"("tenant_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingEvent" ADD CONSTRAINT "BookingEvent_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingEvent" ADD CONSTRAINT "BookingEvent_tenant_id_booking_id_fkey" FOREIGN KEY ("tenant_id", "booking_id") REFERENCES "Booking"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Integrity checks (values are only ever added with these true)
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_stay_dates_check" CHECK ("check_in" IS NULL OR "check_out" IS NULL OR "check_out" > "check_in");
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_nights_check" CHECK ("nights" IS NULL OR "nights" >= 1);
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_version_check" CHECK ("version" >= 1);
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_amounts_check" CHECK (("net_minor" IS NULL OR "net_minor" >= 0) AND ("markup_minor" IS NULL OR "markup_minor" >= 0));
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_fx_rate_check" CHECK ("fx_rate" IS NULL OR "fx_rate" > 0);
ALTER TABLE "BookingRoom" ADD CONSTRAINT "BookingRoom_occupancy_check" CHECK ("adults" >= 1 AND "children" >= 0 AND "quantity" >= 1 AND "position" >= 1);
ALTER TABLE "BookingRoom" ADD CONSTRAINT "BookingRoom_amounts_check" CHECK (("sell_minor" IS NULL OR "sell_minor" >= 0) AND ("net_minor" IS NULL OR "net_minor" >= 0));

-- Forced row-level security, the same tenant policy as Booking
ALTER TABLE "BookingRoom" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BookingGuest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BookingEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BookingRoom" FORCE ROW LEVEL SECURITY;
ALTER TABLE "BookingGuest" FORCE ROW LEVEL SECURITY;
ALTER TABLE "BookingEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY "BookingRoom_tenant_isolation" ON "BookingRoom"
  USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());
CREATE POLICY "BookingGuest_tenant_isolation" ON "BookingGuest"
  USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());
CREATE POLICY "BookingEvent_tenant_isolation" ON "BookingEvent"
  USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());

-- The lifecycle log is append-only: a direct UPDATE or DELETE is rejected. The one exception is the foreign-key cascade when the booking itself is
-- deleted (never done by the application; an owner erasing a booking erases its log with it). A cascade runs inside the foreign-key trigger, so
-- pg_trigger_depth() is greater than 1; a direct statement is at depth 1.
CREATE OR REPLACE FUNCTION "fbeds_booking_event_immutable"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'BookingEvent is append-only' USING ERRCODE = '42501';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "BookingEvent_immutable" BEFORE UPDATE OR DELETE ON "BookingEvent"
  FOR EACH ROW EXECUTE FUNCTION "fbeds_booking_event_immutable"();

-- Backfill ---------------------------------------------------------------------------------------------------------------------------
CREATE FUNCTION pg_temp.fbeds_safe_date(value text) RETURNS date AS $$
BEGIN
  IF value IS NULL OR value !~ '^\d{4}-\d{2}-\d{2}$' THEN RETURN NULL; END IF;
  RETURN value::date;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

DO $backfill$
DECLARE
  tid text;
BEGIN
  FOR tid IN SELECT "id" FROM "tenants" LOOP
    PERFORM set_config('app.current_tenant_id', tid, true);

    UPDATE "Booking" b
       SET "check_in" = pg_temp.fbeds_safe_date(b."search_snapshot"->>'checkIn'),
           "check_out" = pg_temp.fbeds_safe_date(b."search_snapshot"->>'checkOut'),
           "nights" = (pg_temp.fbeds_safe_date(b."search_snapshot"->>'checkOut') - pg_temp.fbeds_safe_date(b."search_snapshot"->>'checkIn'))
     WHERE b."tenant_id" = tid
       AND pg_temp.fbeds_safe_date(b."search_snapshot"->>'checkIn') IS NOT NULL
       AND pg_temp.fbeds_safe_date(b."search_snapshot"->>'checkOut') > pg_temp.fbeds_safe_date(b."search_snapshot"->>'checkIn');

    UPDATE "Booking" b
       SET "supplier_ref" = m."supplier_reference", "supplier_status" = m."supplier_status"
      FROM (SELECT DISTINCT ON ("booking_id") "booking_id", "supplier_reference", "supplier_status"
              FROM "SupplierMutation"
             WHERE "tenant_id" = tid AND "operation" = 'BOOK' AND "supplier_reference" IS NOT NULL AND "status" IN ('ACKNOWLEDGED', 'RESOLVED')
             ORDER BY "booking_id", "created_at" DESC) m
     WHERE b."tenant_id" = tid AND b."id" = m."booking_id";

    UPDATE "Booking" b
       SET "agent_user_id" = a."user_id", "agency_id" = am."agency_id"
      FROM (SELECT DISTINCT ON ("entity_id") "entity_id", "user_id"
              FROM "AuditEvent"
             WHERE "tenant_id" = tid AND "entity_type" = 'booking' AND "actor_type" = 'USER' AND "user_id" IS NOT NULL
               AND "action" IN ('booking.prebook.succeeded', 'booking.prebook.unknown')
             ORDER BY "entity_id", "created_at" ASC) a
      LEFT JOIN "AgencyMember" am ON am."tenant_id" = tid AND am."user_id" = a."user_id"
     WHERE b."tenant_id" = tid AND b."id" = a."entity_id";

    INSERT INTO "BookingRoom" ("id", "tenant_id", "booking_id", "position", "quantity", "room_type_id", "room_name", "board_code", "adults", "children", "child_ages", "sell_minor", "created_at")
    SELECT 'br_' || b."id", tid, b."id", 1,
           CASE WHEN (b."search_snapshot"->>'rooms') ~ '^[1-9][0-9]{0,2}$' THEN (b."search_snapshot"->>'rooms')::int ELSE 1 END,
           NULLIF(b."search_snapshot"->>'canonicalRoomTypeId', ''),
           (SELECT rt."name" FROM "RoomType" rt WHERE rt."id" = b."search_snapshot"->>'canonicalRoomTypeId' AND rt."hotel_id" = b."hotel_id"),
           (SELECT bb."code" FROM "BoardBasis" bb WHERE bb."id" = b."search_snapshot"->>'boardBasisId' AND bb."tenant_id" = tid),
           CASE WHEN (b."search_snapshot"->>'adults') ~ '^[1-9][0-9]?$' THEN (b."search_snapshot"->>'adults')::int ELSE 1 END,
           CASE WHEN (b."search_snapshot"->>'children') ~ '^[0-9]$' THEN (b."search_snapshot"->>'children')::int ELSE 0 END,
           CASE WHEN jsonb_typeof(b."search_snapshot"->'childAges') = 'array'
                THEN COALESCE((SELECT array_agg(x::int) FROM jsonb_array_elements_text(b."search_snapshot"->'childAges') x WHERE x ~ '^[0-9]{1,2}$'), '{}')
                ELSE '{}' END,
           b."total_minor", b."created_at"
      FROM "Booking" b
     WHERE b."tenant_id" = tid AND b."search_snapshot" IS NOT NULL AND jsonb_typeof(b."search_snapshot") = 'object'
       AND NOT EXISTS (SELECT 1 FROM "BookingRoom" r WHERE r."tenant_id" = tid AND r."booking_id" = b."id");

    INSERT INTO "BookingGuest" ("id", "tenant_id", "booking_id", "room_id", "first_name", "last_name", "is_lead", "type", "created_at")
    SELECT 'bg_' || b."id", tid, b."id", 'br_' || b."id",
           left(btrim(b."search_snapshot"->'leadGuest'->>'firstName'), 80), left(btrim(b."search_snapshot"->'leadGuest'->>'lastName'), 80), true, 'ADULT', b."created_at"
      FROM "Booking" b
     WHERE b."tenant_id" = tid AND jsonb_typeof(b."search_snapshot") = 'object'
       AND jsonb_typeof(b."search_snapshot"->'leadGuest') = 'object'
       AND btrim(COALESCE(b."search_snapshot"->'leadGuest'->>'firstName', '')) <> ''
       AND btrim(COALESCE(b."search_snapshot"->'leadGuest'->>'lastName', '')) <> ''
       AND EXISTS (SELECT 1 FROM "BookingRoom" r WHERE r."id" = 'br_' || b."id" AND r."tenant_id" = tid)
       AND NOT EXISTS (SELECT 1 FROM "BookingGuest" g WHERE g."tenant_id" = tid AND g."booking_id" = b."id");

    INSERT INTO "BookingEvent" ("id", "tenant_id", "booking_id", "from_status", "to_status", "actor_type", "reason", "payload", "created_at")
    SELECT 'be_' || b."id", tid, b."id", NULL, b."status", 'SYSTEM',
           'Backfilled when the booking lifecycle log was introduced; earlier history is in the audit trail',
           '{"backfill": true}'::jsonb, b."updated_at"
      FROM "Booking" b
     WHERE b."tenant_id" = tid
       AND NOT EXISTS (SELECT 1 FROM "BookingEvent" e WHERE e."tenant_id" = tid AND e."booking_id" = b."id");
  END LOOP;
  PERFORM set_config('app.current_tenant_id', '', true);
END
$backfill$;
