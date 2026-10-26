-- ADR 0095 part B: partial credit notes to an agency for a charged booking (supplier service failure, price correction, goodwill).
--
-- BookingCreditNote   PROPOSED by one person, APPROVED or REJECTED by another (CHECK: the approver is never the proposer). Approval posts exactly one REFUND to the agency account in the
--                     SAME transaction and links it in ledger_entry_id (unique), which is how a credit note can never be posted twice. Integer minor units in the booking currency, never converted.
--                     (tenant, request_id) makes a proposal idempotent; (booking, seq) numbers the notes of one booking from 1 and `number` is CN-<booking reference>-P<seq>, unique per tenant.
--                     Once APPROVED or REJECTED a row never changes and no row is ever deleted (trigger). An approved row must carry its ledger entry, a rejected or proposed one must not (CHECK).
-- Permissions        finance.creditnote.propose and finance.creditnote.approve, granted to no role here.
-- Not changed        Cancelled bookings keep the cancellation settlement path (ADR 0069); the existing one-per-booking CREDIT_NOTE document is untouched. Revenue and supplier-payable reports are not netted.
--
-- No table is granted to any role: the credit note service runs on the API connection like the cancellation settlement (the booking module's role has no ledger access, ADR 0032), and the table
-- is classified finance-gated in the runtime-role contract. Row-level security is ENABLED and FORCED. The booking reference is composite (tenant_id, id). tenant_id leads every new index.
--
-- Rollback (forward migration; reviewed before use; it discards the record of proposed and decided credit notes, so export them first; REFUND ledger entries already posted stay, the ledger is append-only):
--   DROP TABLE "BookingCreditNote"; DROP FUNCTION "fbeds_credit_note_guard"(); DROP TYPE "CreditNoteStatus"; DROP TYPE "CreditNoteReason";
--   DELETE FROM "Permission" WHERE key IN ('finance.creditnote.propose', 'finance.creditnote.approve');

-- CreateEnum
CREATE TYPE "CreditNoteReason" AS ENUM ('SUPPLIER_SERVICE_FAILURE', 'PRICE_CORRECTION', 'GOODWILL');

-- CreateEnum
CREATE TYPE "CreditNoteStatus" AS ENUM ('PROPOSED', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "BookingCreditNote" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "booking_id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "number" TEXT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "reason" "CreditNoteReason" NOT NULL,
    "note" TEXT NOT NULL,
    "status" "CreditNoteStatus" NOT NULL DEFAULT 'PROPOSED',
    "request_id" TEXT NOT NULL,
    "proposed_by_id" TEXT NOT NULL,
    "decided_by_id" TEXT,
    "decided_at" TIMESTAMP(3),
    "decision_reason" TEXT,
    "ledger_entry_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingCreditNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BookingCreditNote_ledger_entry_id_key" ON "BookingCreditNote"("ledger_entry_id");

-- CreateIndex
CREATE INDEX "BookingCreditNote_tenant_id_status_created_at_idx" ON "BookingCreditNote"("tenant_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "BookingCreditNote_tenant_id_booking_id_idx" ON "BookingCreditNote"("tenant_id", "booking_id");

-- CreateIndex
CREATE UNIQUE INDEX "BookingCreditNote_tenant_id_id_key" ON "BookingCreditNote"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "BookingCreditNote_tenant_id_request_id_key" ON "BookingCreditNote"("tenant_id", "request_id");

-- CreateIndex
CREATE UNIQUE INDEX "BookingCreditNote_tenant_id_number_key" ON "BookingCreditNote"("tenant_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "BookingCreditNote_booking_id_seq_key" ON "BookingCreditNote"("booking_id", "seq");

-- AddForeignKey
ALTER TABLE "BookingCreditNote" ADD CONSTRAINT "BookingCreditNote_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingCreditNote" ADD CONSTRAINT "BookingCreditNote_tenant_id_booking_id_fkey" FOREIGN KEY ("tenant_id", "booking_id") REFERENCES "Booking"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingCreditNote" ADD CONSTRAINT "BookingCreditNote_ledger_entry_id_fkey" FOREIGN KEY ("ledger_entry_id") REFERENCES "LedgerEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Integrity beyond Prisma
ALTER TABLE "BookingCreditNote"
  ADD CONSTRAINT "BookingCreditNote_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "BookingCreditNote_amount_positive" CHECK ("amount_minor" > 0),
  ADD CONSTRAINT "BookingCreditNote_seq" CHECK ("seq" >= 1),
  ADD CONSTRAINT "BookingCreditNote_number" CHECK (char_length("number") BETWEEN 5 AND 120),
  ADD CONSTRAINT "BookingCreditNote_note" CHECK (char_length("note") BETWEEN 3 AND 500),
  ADD CONSTRAINT "BookingCreditNote_request_id" CHECK (char_length("request_id") BETWEEN 8 AND 80),
  ADD CONSTRAINT "BookingCreditNote_reason" CHECK ("decision_reason" IS NULL OR char_length("decision_reason") BETWEEN 3 AND 500),
  ADD CONSTRAINT "BookingCreditNote_status_facts" CHECK (
    CASE "status"
      WHEN 'PROPOSED' THEN "decided_by_id" IS NULL AND "decided_at" IS NULL AND "decision_reason" IS NULL AND "ledger_entry_id" IS NULL
      WHEN 'APPROVED' THEN "decided_by_id" IS NOT NULL AND "decided_at" IS NOT NULL AND "ledger_entry_id" IS NOT NULL
      WHEN 'REJECTED' THEN "decided_by_id" IS NOT NULL AND "decided_at" IS NOT NULL AND "decision_reason" IS NOT NULL AND "ledger_entry_id" IS NULL
    END
  ),
  ADD CONSTRAINT "BookingCreditNote_second_person" CHECK ("status" = 'PROPOSED' OR "decided_by_id" <> "proposed_by_id");

-- Never deleted. Only a PROPOSED note may be updated (to its decision); its identity and amount never change.
CREATE FUNCTION "fbeds_credit_note_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'BookingCreditNote is never deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."status" <> 'PROPOSED' THEN
    RAISE EXCEPTION 'A decided BookingCreditNote is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."tenant_id" <> OLD."tenant_id" OR NEW."booking_id" <> OLD."booking_id" OR NEW."seq" <> OLD."seq" OR NEW."number" <> OLD."number" OR NEW."currency" <> OLD."currency"
     OR NEW."amount_minor" <> OLD."amount_minor" OR NEW."reason" <> OLD."reason" OR NEW."note" <> OLD."note" OR NEW."request_id" <> OLD."request_id"
     OR NEW."proposed_by_id" <> OLD."proposed_by_id" OR NEW."created_at" <> OLD."created_at" THEN
    RAISE EXCEPTION 'BookingCreditNote identity and amount are immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "BookingCreditNote_guard" BEFORE UPDATE OR DELETE ON "BookingCreditNote" FOR EACH ROW EXECUTE FUNCTION "fbeds_credit_note_guard"();

-- Row-level security
ALTER TABLE "BookingCreditNote" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BookingCreditNote" FORCE ROW LEVEL SECURITY;
CREATE POLICY "BookingCreditNote_tenant_isolation" ON "BookingCreditNote" USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());

-- Permission keys enforced by the credit note API. Granted to no role here.
INSERT INTO "Permission" ("id", "key", "description") VALUES
  (gen_random_uuid()::text, 'finance.creditnote.propose', 'Propose a partial credit note to an agency for a charged booking; no money moves until it is approved'),
  (gen_random_uuid()::text, 'finance.creditnote.approve', 'Approve or reject a proposed credit note; approval credits the agency account (never the person who proposed it)')
ON CONFLICT ("key") DO NOTHING;
