-- ADR 0072: booking amendments. Forward-only.
--
-- BookingAmendment          One structured amendment of a Confirmed booking: the requested change (stay dates and/or room occupancy: dates and head counts only, no guest data),
--                           the booking as it was, and, once approved, the supplier-confirmed price and the signed difference. At most ONE open (REQUESTED) amendment per booking.
--                           tenant_id leads every index; FORCED row-level security (tenant_id = fbeds_current_tenant_id()). The proposal and the before-state are never updatable
--                           (the booking role is granted UPDATE on the decision columns only; see database/booking-ops-role.ts). Granted by the owner-run provisioning script, not here.
-- BookingFinanceEvent       adjustment_minor: the signed difference of an AMENDED event. Required for AMENDED, forbidden for every other type. The table stays append-only.
--
-- Booking and BookingRoom columns written by an approved amendment (dates, nights, sell, net, markup, deadline; occupancy) already exist. No existing row, constraint or policy changes.
-- Tenant-index review: BookingAmendment (tenant_id, booking_id, created_at) serves the detail read; the partial unique index (tenant_id, booking_id) WHERE status = 'REQUESTED' serves the open-amendment lookup.
--
-- Rollback (forward migration; reviewed before use; only while amendments are switched off and none is open):
--   ALTER TABLE "BookingFinanceEvent" DROP CONSTRAINT "BookingFinanceEvent_adjustment_check"; ALTER TABLE "BookingFinanceEvent" DROP COLUMN "adjustment_minor";
--   DROP TABLE "BookingAmendment"; DROP TYPE "BookingAmendmentStatus";
CREATE TYPE "BookingAmendmentStatus" AS ENUM ('REQUESTED', 'APPROVED', 'REJECTED');

CREATE TABLE "BookingAmendment" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "booking_id" TEXT NOT NULL,
  "status" "BookingAmendmentStatus" NOT NULL DEFAULT 'REQUESTED',
  "from_version" INTEGER NOT NULL,
  "proposal" JSONB NOT NULL,
  "before_state" JSONB NOT NULL,
  "approved_sell_minor" BIGINT,
  "approved_net_minor" BIGINT,
  "difference_minor" BIGINT,
  "approved_cancel_deadline" TIMESTAMP(3),
  "documents_not_reissued" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "requested_by_user_id" TEXT,
  "decided_by_user_id" TEXT,
  "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decided_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BookingAmendment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BookingAmendment_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "BookingAmendment_tenant_id_booking_id_fkey" FOREIGN KEY ("tenant_id", "booking_id") REFERENCES "Booking"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "BookingAmendment_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "BookingAmendment_decided_by_user_id_fkey" FOREIGN KEY ("decided_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "BookingAmendment_proposal_check" CHECK (jsonb_typeof("proposal") = 'object' AND jsonb_typeof("before_state") = 'object'),
  CONSTRAINT "BookingAmendment_decision_check" CHECK (
    ("status" = 'REQUESTED' AND "decided_at" IS NULL AND "approved_sell_minor" IS NULL AND "difference_minor" IS NULL)
    OR ("status" = 'REJECTED' AND "decided_at" IS NOT NULL AND "approved_sell_minor" IS NULL AND "difference_minor" IS NULL)
    OR ("status" = 'APPROVED' AND "decided_at" IS NOT NULL AND "approved_sell_minor" IS NOT NULL AND "approved_sell_minor" > 0 AND "difference_minor" IS NOT NULL
        AND ("approved_net_minor" IS NULL OR ("approved_net_minor" >= 0 AND "approved_net_minor" <= "approved_sell_minor")))
  )
);
CREATE UNIQUE INDEX "BookingAmendment_tenant_id_id_key" ON "BookingAmendment"("tenant_id", "id");
CREATE INDEX "BookingAmendment_tenant_id_booking_id_created_at_idx" ON "BookingAmendment"("tenant_id", "booking_id", "created_at");
CREATE UNIQUE INDEX "BookingAmendment_one_open_idx" ON "BookingAmendment"("tenant_id", "booking_id") WHERE "status" = 'REQUESTED';

ALTER TABLE "BookingAmendment" ENABLE ROW LEVEL SECURITY; ALTER TABLE "BookingAmendment" FORCE ROW LEVEL SECURITY;
CREATE POLICY "BookingAmendment_tenant_isolation" ON "BookingAmendment"
  USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());

ALTER TABLE "BookingFinanceEvent" ADD COLUMN "adjustment_minor" BIGINT;
ALTER TABLE "BookingFinanceEvent" ADD CONSTRAINT "BookingFinanceEvent_adjustment_check" CHECK (("adjustment_minor" IS NOT NULL) = ("type" = 'AMENDED'));
