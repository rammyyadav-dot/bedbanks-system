-- Forward-only supply foundation 2: mappings, contracts and commercial rules.
CREATE TYPE "MappingStatus" AS ENUM ('PENDING', 'MAPPED', 'REJECTED');
CREATE TYPE "ContractStatus" AS ENUM ('DRAFT', 'REVIEW', 'ACTIVE', 'EXPIRED', 'SUSPENDED');
CREATE TYPE "RatePlanStatus" AS ENUM ('DRAFT', 'ACTIVE', 'SUSPENDED', 'EXPIRED');

CREATE TABLE "SupplierHotelMapping" (
  "id" TEXT NOT NULL, "tenant_id" TEXT NOT NULL, "supplier_id" TEXT NOT NULL,
  "hotel_id" TEXT NOT NULL, "supplier_hotel_id" TEXT NOT NULL,
  "status" "MappingStatus" NOT NULL DEFAULT 'PENDING', "confidence" INTEGER,
  "source_metadata" JSONB NOT NULL DEFAULT '{}', "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SupplierHotelMapping_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SupplierHotelMapping_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SupplierHotelMapping_hotel_id_fkey" FOREIGN KEY ("hotel_id") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SupplierHotelMapping_confidence_check" CHECK ("confidence" IS NULL OR "confidence" BETWEEN 0 AND 100)
);
CREATE UNIQUE INDEX "SupplierHotelMapping_supplier_id_supplier_hotel_id_key" ON "SupplierHotelMapping"("supplier_id", "supplier_hotel_id");
CREATE UNIQUE INDEX "SupplierHotelMapping_supplier_id_hotel_id_key" ON "SupplierHotelMapping"("supplier_id", "hotel_id");
CREATE INDEX "SupplierHotelMapping_tenant_id_status_idx" ON "SupplierHotelMapping"("tenant_id", "status");
CREATE INDEX "SupplierHotelMapping_hotel_id_idx" ON "SupplierHotelMapping"("hotel_id");

CREATE TABLE "Contract" (
  "id" TEXT NOT NULL, "tenant_id" TEXT NOT NULL, "supplier_id" TEXT NOT NULL,
  "supplier_hotel_mapping_id" TEXT, "code" TEXT NOT NULL,
  "status" "ContractStatus" NOT NULL DEFAULT 'DRAFT', "valid_from" DATE NOT NULL, "valid_to" DATE NOT NULL,
  "settlement_currency" CHAR(3) NOT NULL, "sales_markets" JSONB NOT NULL DEFAULT '[]',
  "nationalities" JSONB NOT NULL DEFAULT '[]', "payment_policy_ref" TEXT,
  "source_metadata" JSONB NOT NULL DEFAULT '{}', "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Contract_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Contract_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "Contract_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "Contract_supplier_hotel_mapping_id_fkey" FOREIGN KEY ("supplier_hotel_mapping_id") REFERENCES "SupplierHotelMapping"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "Contract_dates_check" CHECK ("valid_to" >= "valid_from"),
  CONSTRAINT "Contract_currency_check" CHECK ("settlement_currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "Contract_version_check" CHECK ("version" > 0)
);
CREATE UNIQUE INDEX "Contract_tenant_id_code_version_key" ON "Contract"("tenant_id", "code", "version");
CREATE INDEX "Contract_tenant_id_status_valid_from_valid_to_idx" ON "Contract"("tenant_id", "status", "valid_from", "valid_to");
CREATE INDEX "Contract_supplier_id_status_idx" ON "Contract"("supplier_id", "status");

CREATE TABLE "RatePlan" (
  "id" TEXT NOT NULL, "tenant_id" TEXT NOT NULL, "contract_id" TEXT NOT NULL,
  "room_type_id" TEXT NOT NULL, "board_basis_id" TEXT NOT NULL, "code" TEXT NOT NULL,
  "status" "RatePlanStatus" NOT NULL DEFAULT 'DRAFT', "refundable" BOOLEAN NOT NULL DEFAULT true,
  "occupancy" INTEGER NOT NULL, "currency" CHAR(3) NOT NULL,
  "taxes_included" BOOLEAN NOT NULL DEFAULT false, "fees_included" BOOLEAN NOT NULL DEFAULT false,
  "min_stay" INTEGER NOT NULL DEFAULT 1, "max_stay" INTEGER, "release_days" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RatePlan_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RatePlan_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "Contract"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "RatePlan_room_type_id_fkey" FOREIGN KEY ("room_type_id") REFERENCES "RoomType"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "RatePlan_board_basis_id_fkey" FOREIGN KEY ("board_basis_id") REFERENCES "BoardBasis"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "RatePlan_rules_check" CHECK ("occupancy" > 0 AND "min_stay" > 0 AND ("max_stay" IS NULL OR "max_stay" >= "min_stay") AND "release_days" >= 0),
  CONSTRAINT "RatePlan_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$')
);
CREATE UNIQUE INDEX "RatePlan_contract_id_code_key" ON "RatePlan"("contract_id", "code");
CREATE INDEX "RatePlan_tenant_id_status_idx" ON "RatePlan"("tenant_id", "status");
CREATE INDEX "RatePlan_room_type_id_idx" ON "RatePlan"("room_type_id");

CREATE TABLE "CancellationPolicy" (
  "id" TEXT NOT NULL, "contract_id" TEXT NOT NULL, "days_before_checkin" INTEGER NOT NULL,
  "penalty_percent" INTEGER, "penalty_minor" BIGINT, "currency" CHAR(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CancellationPolicy_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CancellationPolicy_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "Contract"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "CancellationPolicy_values_check" CHECK ("days_before_checkin" >= 0 AND ("penalty_percent" IS NULL OR "penalty_percent" BETWEEN 0 AND 100) AND ("penalty_minor" IS NULL OR "penalty_minor" >= 0))
);
CREATE INDEX "CancellationPolicy_contract_id_idx" ON "CancellationPolicy"("contract_id");
CREATE TABLE "ChildPolicy" (
  "id" TEXT NOT NULL, "contract_id" TEXT NOT NULL, "min_age" INTEGER NOT NULL, "max_age" INTEGER NOT NULL,
  "extra_bed_allowed" BOOLEAN NOT NULL DEFAULT false, "supplement_minor" BIGINT, "currency" CHAR(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ChildPolicy_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ChildPolicy_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "Contract"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ChildPolicy_age_check" CHECK ("min_age" >= 0 AND "max_age" >= "min_age" AND ("supplement_minor" IS NULL OR "supplement_minor" >= 0))
);
CREATE INDEX "ChildPolicy_contract_id_idx" ON "ChildPolicy"("contract_id");
CREATE TABLE "BookingLeadTimeRule" (
  "id" TEXT NOT NULL, "contract_id" TEXT NOT NULL, "min_lead_hours" INTEGER NOT NULL DEFAULT 0,
  "max_lead_days" INTEGER, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BookingLeadTimeRule_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BookingLeadTimeRule_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "Contract"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "BookingLeadTimeRule_check" CHECK ("min_lead_hours" >= 0 AND ("max_lead_days" IS NULL OR "max_lead_days" >= 0))
);
CREATE UNIQUE INDEX "BookingLeadTimeRule_contract_id_key" ON "BookingLeadTimeRule"("contract_id");

ALTER TABLE "SupplierHotelMapping" ENABLE ROW LEVEL SECURITY; ALTER TABLE "SupplierHotelMapping" FORCE ROW LEVEL SECURITY;
ALTER TABLE "Contract" ENABLE ROW LEVEL SECURITY; ALTER TABLE "Contract" FORCE ROW LEVEL SECURITY;
ALTER TABLE "RatePlan" ENABLE ROW LEVEL SECURITY; ALTER TABLE "RatePlan" FORCE ROW LEVEL SECURITY;
CREATE POLICY "SupplierHotelMapping_tenant_isolation" ON "SupplierHotelMapping" USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());
CREATE POLICY "Contract_tenant_isolation" ON "Contract" USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());
CREATE POLICY "RatePlan_tenant_isolation" ON "RatePlan" USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());
ALTER TABLE "CancellationPolicy" ENABLE ROW LEVEL SECURITY; ALTER TABLE "CancellationPolicy" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ChildPolicy" ENABLE ROW LEVEL SECURITY; ALTER TABLE "ChildPolicy" FORCE ROW LEVEL SECURITY;
ALTER TABLE "BookingLeadTimeRule" ENABLE ROW LEVEL SECURITY; ALTER TABLE "BookingLeadTimeRule" FORCE ROW LEVEL SECURITY;
CREATE POLICY "CancellationPolicy_tenant_isolation" ON "CancellationPolicy" USING (EXISTS (SELECT 1 FROM "Contract" WHERE "Contract"."id" = "CancellationPolicy"."contract_id" AND "Contract"."tenant_id" = "fbeds_current_tenant_id"())) WITH CHECK (EXISTS (SELECT 1 FROM "Contract" WHERE "Contract"."id" = "CancellationPolicy"."contract_id" AND "Contract"."tenant_id" = "fbeds_current_tenant_id"()));
CREATE POLICY "ChildPolicy_tenant_isolation" ON "ChildPolicy" USING (EXISTS (SELECT 1 FROM "Contract" WHERE "Contract"."id" = "ChildPolicy"."contract_id" AND "Contract"."tenant_id" = "fbeds_current_tenant_id"())) WITH CHECK (EXISTS (SELECT 1 FROM "Contract" WHERE "Contract"."id" = "ChildPolicy"."contract_id" AND "Contract"."tenant_id" = "fbeds_current_tenant_id"()));
CREATE POLICY "BookingLeadTimeRule_tenant_isolation" ON "BookingLeadTimeRule" USING (EXISTS (SELECT 1 FROM "Contract" WHERE "Contract"."id" = "BookingLeadTimeRule"."contract_id" AND "Contract"."tenant_id" = "fbeds_current_tenant_id"())) WITH CHECK (EXISTS (SELECT 1 FROM "Contract" WHERE "Contract"."id" = "BookingLeadTimeRule"."contract_id" AND "Contract"."tenant_id" = "fbeds_current_tenant_id"()));
