-- ADR 0076: the Finance consumer of BookingFinanceEvent (booking audit F-gate 2).
--
-- BookingFinancePosting   one row per BookingFinanceEvent: what the consumer did (POSTED | SKIPPED | REVIEW_REQUIRED), why (a stable code), and the net effect on the agency
--                         account and on what is owed to the supplier. Written in the same transaction as the ledger and payable entries it describes, so an event is either fully
--                         accounted for or not at all. POSTED and SKIPPED rows never change. REVIEW_REQUIRED is the only row that is updated, and only to a final status.
-- SupplierPayableEntry    append-only, signed movements of what the operator owes a supplier for a booking (accrual on confirmation, adjustment on a price amendment, reversal on a
--                         penalty-free cancellation). There is no payment or settlement state here; paying a supplier stays undecided (ADR 0054).
-- BookingFinanceEvent     gains UNIQUE (tenant_id, id) so the two tables above can use composite tenant foreign keys, like every other tenant-owned reference.
-- fbeds_finance_posting_due_tenants()  SECURITY DEFINER, tenant ids only, for the worker (no cross-tenant read). A REVIEW_REQUIRED event is due again after five minutes.
-- fbeds_is_finance_posting_role() + policy "AuditEvent_finance_posting_system_insert"  the consumer is a system actor, and the general AuditEvent insert policy refuses SYSTEM rows,
--                         so (like the hold-expiry, sandbox and rate-plan-expiry roles) its two audit actions are admitted by a policy that names the role, the tenant, the actor and the actions.
--
-- Nothing in this migration writes "LedgerEntry" or "Wallet". The only writer of "LedgerEntry" stays apps/api/src/ledger/ledger-core.ts (ADR 0062); this consumer calls it.
-- No table here is granted to any role: the narrow role `fbeds_finpost_ops` is provisioned by the owner tool (apps/api/src/database/finance-posting-role.ts).
-- Row-level security is ENABLED and FORCED on both tables. Every foreign key into a tenant-owned table is composite (tenant_id, id). tenant_id leads every new index.
-- Money: BIGINT minor units + CHAR(3) currency. No floating point, no currency conversion.
--
-- Rollback (forward migration; reviewed before use; only while the worker is stopped; it discards the consumer's record of what it posted, which the ledger entries then no longer explain):
--   DROP POLICY "AuditEvent_finance_posting_system_insert" ON "AuditEvent"; DROP FUNCTION "fbeds_is_finance_posting_role"();
--   DROP FUNCTION "fbeds_finance_posting_due_tenants"();
--   DROP TABLE "SupplierPayableEntry"; DROP TABLE "BookingFinancePosting";
--   DROP FUNCTION "fbeds_finance_posting_guard"(); DROP FUNCTION "fbeds_finance_posting_immutable"();
--   DROP TYPE "SupplierPayableKind"; DROP TYPE "BookingFinancePostingStatus";
--   DROP INDEX "BookingFinanceEvent_tenant_id_id_key";
--   Ledger entries already appended are immutable and stay; reverse them with a reviewed compensating entry, never by deleting.

-- CreateEnum
CREATE TYPE "BookingFinancePostingStatus" AS ENUM ('POSTED', 'SKIPPED', 'REVIEW_REQUIRED');

-- CreateEnum
CREATE TYPE "SupplierPayableKind" AS ENUM ('ACCRUAL', 'ADJUSTMENT', 'REVERSAL');

-- CreateTable
CREATE TABLE "BookingFinancePosting" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "booking_id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "status" "BookingFinancePostingStatus" NOT NULL,
    "reason" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "wallet_id" TEXT,
    "currency" CHAR(3) NOT NULL,
    "agency_effect_minor" BIGINT NOT NULL DEFAULT 0,
    "payable_effect_minor" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingFinancePosting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierPayableEntry" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "booking_id" TEXT NOT NULL,
    "supplier_id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "kind" "SupplierPayableKind" NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplierPayableEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BookingFinancePosting_tenant_id_status_updated_at_idx" ON "BookingFinancePosting"("tenant_id", "status", "updated_at");

-- CreateIndex
CREATE INDEX "BookingFinancePosting_tenant_id_booking_id_idx" ON "BookingFinancePosting"("tenant_id", "booking_id");

-- CreateIndex
CREATE UNIQUE INDEX "BookingFinancePosting_tenant_id_event_id_key" ON "BookingFinancePosting"("tenant_id", "event_id");

-- CreateIndex
CREATE INDEX "SupplierPayableEntry_tenant_id_booking_id_idx" ON "SupplierPayableEntry"("tenant_id", "booking_id");

-- CreateIndex
CREATE INDEX "SupplierPayableEntry_tenant_id_supplier_id_currency_idx" ON "SupplierPayableEntry"("tenant_id", "supplier_id", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierPayableEntry_tenant_id_event_id_kind_key" ON "SupplierPayableEntry"("tenant_id", "event_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "BookingFinanceEvent_tenant_id_id_key" ON "BookingFinanceEvent"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "BookingFinancePosting" ADD CONSTRAINT "BookingFinancePosting_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingFinancePosting" ADD CONSTRAINT "BookingFinancePosting_tenant_id_booking_id_fkey" FOREIGN KEY ("tenant_id", "booking_id") REFERENCES "Booking"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingFinancePosting" ADD CONSTRAINT "BookingFinancePosting_tenant_id_event_id_fkey" FOREIGN KEY ("tenant_id", "event_id") REFERENCES "BookingFinanceEvent"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierPayableEntry" ADD CONSTRAINT "SupplierPayableEntry_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierPayableEntry" ADD CONSTRAINT "SupplierPayableEntry_tenant_id_booking_id_fkey" FOREIGN KEY ("tenant_id", "booking_id") REFERENCES "Booking"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierPayableEntry" ADD CONSTRAINT "SupplierPayableEntry_tenant_id_supplier_id_fkey" FOREIGN KEY ("tenant_id", "supplier_id") REFERENCES "Supplier"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierPayableEntry" ADD CONSTRAINT "SupplierPayableEntry_tenant_id_event_id_fkey" FOREIGN KEY ("tenant_id", "event_id") REFERENCES "BookingFinanceEvent"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Integrity beyond Prisma
ALTER TABLE "BookingFinancePosting"
  ADD CONSTRAINT "BookingFinancePosting_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "BookingFinancePosting_attempts" CHECK ("attempts" BETWEEN 1 AND 100000),
  ADD CONSTRAINT "BookingFinancePosting_reason" CHECK (("status" = 'POSTED' AND "reason" IS NULL) OR ("status" <> 'POSTED' AND "reason" ~ '^[A-Z][A-Z0-9_]{2,63}$')),
  ADD CONSTRAINT "BookingFinancePosting_effect_needs_post" CHECK ("status" = 'POSTED' OR ("agency_effect_minor" = 0 AND "payable_effect_minor" = 0));

ALTER TABLE "SupplierPayableEntry"
  ADD CONSTRAINT "SupplierPayableEntry_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "SupplierPayableEntry_amount_nonzero" CHECK ("amount_minor" <> 0),
  ADD CONSTRAINT "SupplierPayableEntry_sign" CHECK (("kind" = 'ACCRUAL' AND "amount_minor" > 0) OR ("kind" = 'REVERSAL' AND "amount_minor" < 0) OR "kind" = 'ADJUSTMENT');

-- Payable entries are append-only.
CREATE FUNCTION "fbeds_finance_posting_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
CREATE TRIGGER "SupplierPayableEntry_immutable" BEFORE UPDATE OR DELETE ON "SupplierPayableEntry" FOR EACH ROW EXECUTE FUNCTION "fbeds_finance_posting_immutable"();

-- A posting is never deleted; only a REVIEW_REQUIRED posting may be updated, and its identity never changes.
CREATE FUNCTION "fbeds_finance_posting_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'BookingFinancePosting is never deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."status" <> 'REVIEW_REQUIRED' THEN
    RAISE EXCEPTION 'A final BookingFinancePosting is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."tenant_id" <> OLD."tenant_id" OR NEW."booking_id" <> OLD."booking_id" OR NEW."event_id" <> OLD."event_id" OR NEW."currency" <> OLD."currency" OR NEW."created_at" <> OLD."created_at" THEN
    RAISE EXCEPTION 'BookingFinancePosting identity is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "BookingFinancePosting_guard" BEFORE UPDATE OR DELETE ON "BookingFinancePosting" FOR EACH ROW EXECUTE FUNCTION "fbeds_finance_posting_guard"();

-- Row-level security
ALTER TABLE "BookingFinancePosting" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BookingFinancePosting" FORCE ROW LEVEL SECURITY;
CREATE POLICY "BookingFinancePosting_tenant_isolation" ON "BookingFinancePosting" USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());
ALTER TABLE "SupplierPayableEntry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SupplierPayableEntry" FORCE ROW LEVEL SECURITY;
CREATE POLICY "SupplierPayableEntry_tenant_isolation" ON "SupplierPayableEntry" USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());

-- Tenants with an event the consumer has not finished. SECURITY DEFINER so the worker needs no cross-tenant read; it returns tenant ids only.
-- A REVIEW_REQUIRED event is due again once its last attempt is five minutes old. EXECUTE is granted by the role provisioning, not here.
CREATE FUNCTION "fbeds_finance_posting_due_tenants"() RETURNS SETOF TEXT AS $$
  SELECT DISTINCT e."tenant_id" FROM "BookingFinanceEvent" e
   WHERE NOT EXISTS (
     SELECT 1 FROM "BookingFinancePosting" p
      WHERE p."tenant_id" = e."tenant_id" AND p."event_id" = e."id"
        AND (p."status" IN ('POSTED', 'SKIPPED') OR p."updated_at" > now() - interval '5 minutes'))
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION "fbeds_finance_posting_due_tenants"() FROM PUBLIC;

-- The consumer's own audit rows: SYSTEM actor, this tenant, no user, and only these two actions about a booking.
CREATE FUNCTION "fbeds_is_finance_posting_role"()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM pg_roles r
     WHERE r.rolname = 'fbeds_finpost'
       AND pg_has_role(current_user, r.oid, 'MEMBER')
  )
$$ LANGUAGE SQL STABLE;

CREATE POLICY "AuditEvent_finance_posting_system_insert" ON "AuditEvent"
  FOR INSERT WITH CHECK (
    "fbeds_is_finance_posting_role"()
    AND "tenant_id" = "fbeds_current_tenant_id"()
    AND "actor_type" = 'SYSTEM'
    AND "user_id" IS NULL
    AND "action" IN ('booking.finance.posted', 'booking.finance.review_required')
    AND "entity_type" = 'booking'
  );
