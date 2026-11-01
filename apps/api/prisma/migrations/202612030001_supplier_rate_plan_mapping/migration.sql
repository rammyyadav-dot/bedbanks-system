-- ADR 0081: governed mapping of a supplier rate plan code to one canonical contracted RatePlan.
--
-- SupplierRatePlanMapping   child of an approved SupplierRoomMapping (ADR 0004). Same PENDING / MAPPED / REJECTED lifecycle. Only MAPPED rows are used to resolve ingested observations
--                           (ADR 0078); nothing here writes DailyRate, DailyAvailability or CancellationPolicy.
-- SupplierRoomMapping       gains UNIQUE (tenant_id, id) and RatePlan gains UNIQUE (tenant_id, id) so the new table can use composite tenant foreign keys, like every other tenant-owned reference.
--                           Both column pairs are already unique through "id", so the new indexes cannot fail on existing data.
-- fbeds_supplier_rate_plan_mapping_guard()   BEFORE INSERT/UPDATE: the plan must be of the mapped room type and of a contract with the mapped supplier, in the same tenant; identity columns are immutable;
--                           a MAPPED row requires its room mapping to be MAPPED.
-- fbeds_supplier_room_mapping_dependents()   BEFORE UPDATE OF status on SupplierRoomMapping: a room mapping cannot leave MAPPED while a MAPPED rate plan mapping depends on it.
--
-- Mapping rows are written by the privileged mapping-governance path (PRIVILEGED_WRITE_MODELS); the strict API runtime role gets SELECT only, through the runtime role contract, not through this migration.
-- Row-level security is ENABLED and FORCED. tenant_id leads every index. No money columns.
--
-- Rollback (forward migration; reviewed before use; mappings are decisions, so export them first):
--   DROP TRIGGER "SupplierRoomMapping_rate_plan_dependents" ON "SupplierRoomMapping"; DROP FUNCTION "fbeds_supplier_room_mapping_dependents"();
--   DROP TABLE "SupplierRatePlanMapping"; DROP FUNCTION "fbeds_supplier_rate_plan_mapping_guard"();
--   DROP INDEX "RatePlan_tenant_id_id_key"; DROP INDEX "SupplierRoomMapping_tenant_id_id_key";

-- CreateTable
CREATE TABLE "SupplierRatePlanMapping" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "supplier_room_mapping_id" TEXT NOT NULL,
    "supplier_rate_plan_code" TEXT NOT NULL,
    "rate_plan_id" TEXT NOT NULL,
    "status" "MappingStatus" NOT NULL DEFAULT 'PENDING',
    "confidence" INTEGER,
    "source_metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierRatePlanMapping_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SupplierRatePlanMapping_tenant_id_status_idx" ON "SupplierRatePlanMapping"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierRatePlanMapping_tenant_id_supplier_room_mapping_id__key" ON "SupplierRatePlanMapping"("tenant_id", "supplier_room_mapping_id", "supplier_rate_plan_code");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierRatePlanMapping_tenant_id_rate_plan_id_key" ON "SupplierRatePlanMapping"("tenant_id", "rate_plan_id");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierRoomMapping_tenant_id_id_key" ON "SupplierRoomMapping"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RatePlan_tenant_id_id_key" ON "RatePlan"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "SupplierRatePlanMapping" ADD CONSTRAINT "SupplierRatePlanMapping_tenant_id_supplier_room_mapping_id_fkey" FOREIGN KEY ("tenant_id", "supplier_room_mapping_id") REFERENCES "SupplierRoomMapping"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierRatePlanMapping" ADD CONSTRAINT "SupplierRatePlanMapping_tenant_id_rate_plan_id_fkey" FOREIGN KEY ("tenant_id", "rate_plan_id") REFERENCES "RatePlan"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Integrity beyond Prisma
ALTER TABLE "SupplierRatePlanMapping"
  ADD CONSTRAINT "SupplierRatePlanMapping_code_format" CHECK ("supplier_rate_plan_code" ~ '^[A-Za-z0-9_.:/-]{1,64}$'),
  ADD CONSTRAINT "SupplierRatePlanMapping_confidence" CHECK ("confidence" IS NULL OR "confidence" BETWEEN 0 AND 100);

CREATE FUNCTION "fbeds_supplier_rate_plan_mapping_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  room_row RECORD;
  plan_row RECORD;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."tenant_id" <> OLD."tenant_id" OR NEW."supplier_room_mapping_id" <> OLD."supplier_room_mapping_id" OR NEW."supplier_rate_plan_code" <> OLD."supplier_rate_plan_code"
       OR NEW."rate_plan_id" <> OLD."rate_plan_id" OR NEW."created_at" <> OLD."created_at" THEN
      RAISE EXCEPTION 'SupplierRatePlanMapping identity is immutable' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  SELECT r."status", r."room_type_id", h."supplier_id" INTO room_row
    FROM "SupplierRoomMapping" r JOIN "SupplierHotelMapping" h ON h."id" = r."supplier_hotel_mapping_id"
   WHERE r."id" = NEW."supplier_room_mapping_id" AND r."tenant_id" = NEW."tenant_id";
  SELECT p."room_type_id", c."supplier_id" INTO plan_row
    FROM "RatePlan" p JOIN "Contract" c ON c."id" = p."contract_id"
   WHERE p."id" = NEW."rate_plan_id" AND p."tenant_id" = NEW."tenant_id";
  IF room_row IS NULL OR plan_row IS NULL THEN
    RAISE EXCEPTION 'Rate plan mapping needs a room mapping and a rate plan of the same tenant' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF plan_row."room_type_id" <> room_row."room_type_id" THEN
    RAISE EXCEPTION 'The rate plan is not of the mapped room type' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF plan_row."supplier_id" <> room_row."supplier_id" THEN
    RAISE EXCEPTION 'The rate plan belongs to a contract with another supplier' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."status" = 'MAPPED' AND room_row."status" <> 'MAPPED' THEN
    RAISE EXCEPTION 'Approve the room mapping first' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "SupplierRatePlanMapping_guard" BEFORE INSERT OR UPDATE ON "SupplierRatePlanMapping" FOR EACH ROW EXECUTE FUNCTION "fbeds_supplier_rate_plan_mapping_guard"();

CREATE FUNCTION "fbeds_supplier_room_mapping_dependents"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" = 'MAPPED' AND NEW."status" <> 'MAPPED'
     AND EXISTS (SELECT 1 FROM "SupplierRatePlanMapping" m WHERE m."tenant_id" = OLD."tenant_id" AND m."supplier_room_mapping_id" = OLD."id" AND m."status" = 'MAPPED') THEN
    RAISE EXCEPTION 'Reopen the approved rate plan mappings of this room mapping first' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "SupplierRoomMapping_rate_plan_dependents" BEFORE UPDATE OF "status" ON "SupplierRoomMapping" FOR EACH ROW EXECUTE FUNCTION "fbeds_supplier_room_mapping_dependents"();

-- Row-level security
ALTER TABLE "SupplierRatePlanMapping" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SupplierRatePlanMapping" FORCE ROW LEVEL SECURITY;
CREATE POLICY "SupplierRatePlanMapping_tenant_isolation" ON "SupplierRatePlanMapping" USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());
