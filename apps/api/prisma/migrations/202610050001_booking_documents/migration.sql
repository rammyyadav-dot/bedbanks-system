-- Immutable booking documents (voucher, invoice, credit note). Each is issued once per booking and type,
-- numbered deterministically from the booking reference, and stored as a frozen JSON snapshot so a re-print
-- always shows exactly what was issued. Tenant-isolated by row-level security; UPDATE is rejected by trigger.
-- Rollback: DROP TABLE "BookingDocument"; DROP TYPE "BookingDocumentType"; DROP FUNCTION "BookingDocument_immutable"();
CREATE TYPE "BookingDocumentType" AS ENUM ('VOUCHER', 'INVOICE', 'CREDIT_NOTE');

CREATE TABLE "BookingDocument" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "booking_id" TEXT NOT NULL,
  "type" "BookingDocumentType" NOT NULL,
  "number" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BookingDocument_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BookingDocument_number_check" CHECK (length("number") BETWEEN 6 AND 80)
);
CREATE UNIQUE INDEX "BookingDocument_booking_id_type_key" ON "BookingDocument"("booking_id", "type");
CREATE UNIQUE INDEX "BookingDocument_tenant_id_number_key" ON "BookingDocument"("tenant_id", "number");
CREATE INDEX "BookingDocument_tenant_id_booking_id_idx" ON "BookingDocument"("tenant_id", "booking_id");
ALTER TABLE "BookingDocument" ADD CONSTRAINT "BookingDocument_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BookingDocument" ADD CONSTRAINT "BookingDocument_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "BookingDocument" ENABLE ROW LEVEL SECURITY; ALTER TABLE "BookingDocument" FORCE ROW LEVEL SECURITY;
CREATE POLICY "BookingDocument_tenant_isolation" ON "BookingDocument"
  USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());

CREATE FUNCTION "BookingDocument_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'BookingDocument is immutable' USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
CREATE TRIGGER "BookingDocument_no_update" BEFORE UPDATE ON "BookingDocument" FOR EACH ROW EXECUTE FUNCTION "BookingDocument_immutable"();
