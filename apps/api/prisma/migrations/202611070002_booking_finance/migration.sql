-- ADR 0039, Phase 5: money facts for the Admin booking module, and nothing that moves money.
--
-- "The booking module never edits balances directly, it emits events the Finance module books" (spec). This migration adds exactly that:
--   Booking.cancellation_policy   the cancellation rules FROZEN with the booking (JSON: rules in integer percent or minor units, frozenAt, source). Written at creation only;
--                                 no column grant allows it to change. NULL on older bookings: their penalty is a manual decision, never a guess.
--   BookingFinanceEvent           an append-only outbox of money facts per booking (confirmed, on-request hold, hold released, cancelled with penalty and refund, penalty
--                                 decided or waived). Integer minor units + ISO-4217 currency. No ledger entry, wallet or balance is read or written. The Finance module reads it.
-- Tenant-composite key to Booking (cascades with it), tenant_id leading every index, FORCED row-level security, an append-only trigger (cascade exception as BookingEvent).
-- Also data only: three permissions (booking.finance.view, booking.documents.issue, booking.penalty.waive.approve), granted to no role.
--
-- Rollback (forward migration; reviewed before use; only while no Phase 5 writer is running):
--   DROP TABLE "BookingFinanceEvent"; DROP TYPE "BookingFinanceEventType"; DROP FUNCTION "fbeds_booking_finance_event_immutable"(); ALTER TABLE "Booking" DROP COLUMN "cancellation_policy";
--   DELETE FROM "RolePermission" WHERE "permission_id" IN (SELECT "id" FROM "Permission" WHERE "key" IN ('booking.finance.view','booking.documents.issue','booking.penalty.waive.approve')); DELETE FROM "Permission" WHERE "key" IN (<the same three>);
ALTER TABLE "Booking" ADD COLUMN "cancellation_policy" JSONB;

CREATE TYPE "BookingFinanceEventType" AS ENUM ('CONFIRMED', 'ON_REQUEST_HOLD', 'HOLD_RELEASED', 'CANCELLED', 'PENALTY_DECIDED', 'PENALTY_WAIVED');

CREATE TABLE "BookingFinanceEvent" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "booking_id" TEXT NOT NULL,
  "type" "BookingFinanceEventType" NOT NULL,
  "seq" INTEGER NOT NULL DEFAULT 1,
  "currency" CHAR(3) NOT NULL,
  "sell_minor" BIGINT NOT NULL,
  "net_minor" BIGINT,
  "penalty_minor" BIGINT,
  "refund_minor" BIGINT,
  "payment_mode" "BookingPaymentMode",
  "actor_user_id" TEXT,
  "payload" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BookingFinanceEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BookingFinanceEvent_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "BookingFinanceEvent_tenant_id_booking_id_fkey" FOREIGN KEY ("tenant_id", "booking_id") REFERENCES "Booking"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "BookingFinanceEvent_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "BookingFinanceEvent_amounts_check" CHECK ("currency" ~ '^[A-Z]{3}$' AND "seq" >= 1 AND "sell_minor" >= 0 AND ("net_minor" IS NULL OR "net_minor" >= 0)
    AND ("penalty_minor" IS NULL OR ("penalty_minor" >= 0 AND "penalty_minor" <= "sell_minor")) AND ("refund_minor" IS NULL OR ("refund_minor" >= 0 AND "refund_minor" <= "sell_minor"))
    AND (("penalty_minor" IS NULL) = ("refund_minor" IS NULL)) AND ("penalty_minor" IS NULL OR "penalty_minor" + "refund_minor" = "sell_minor"))
);
CREATE UNIQUE INDEX "BookingFinanceEvent_tenant_id_booking_id_type_seq_key" ON "BookingFinanceEvent"("tenant_id", "booking_id", "type", "seq");
CREATE INDEX "BookingFinanceEvent_tenant_id_booking_id_created_at_idx" ON "BookingFinanceEvent"("tenant_id", "booking_id", "created_at");
CREATE INDEX "BookingFinanceEvent_tenant_id_type_created_at_idx" ON "BookingFinanceEvent"("tenant_id", "type", "created_at");

ALTER TABLE "BookingFinanceEvent" ENABLE ROW LEVEL SECURITY; ALTER TABLE "BookingFinanceEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY "BookingFinanceEvent_tenant_isolation" ON "BookingFinanceEvent"
  USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());

CREATE OR REPLACE FUNCTION "fbeds_booking_finance_event_immutable"() RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN COALESCE(NEW, OLD); END IF;
  RAISE EXCEPTION 'BookingFinanceEvent is append-only' USING ERRCODE = '42501';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "BookingFinanceEvent_immutable" BEFORE UPDATE OR DELETE ON "BookingFinanceEvent"
  FOR EACH ROW EXECUTE FUNCTION "fbeds_booking_finance_event_immutable"();

INSERT INTO "Permission" ("id", "key", "description") VALUES
  ('perm_booking_finance_view', 'booking.finance.view', 'See the money facts, cancellation terms and penalty of a booking'),
  ('perm_booking_documents_issue', 'booking.documents.issue', 'Issue and view a booking''s voucher, invoice, credit note and cancellation note'),
  ('perm_booking_penalty_waive_approve', 'booking.penalty.waive.approve', 'Approve reducing a cancellation penalty')
ON CONFLICT ("key") DO UPDATE SET "description" = EXCLUDED."description";
