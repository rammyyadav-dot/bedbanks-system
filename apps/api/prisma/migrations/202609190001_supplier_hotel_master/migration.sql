-- Forward-only supply foundation 1: canonical supplier and hotel content.
CREATE TYPE "SupplierType" AS ENUM ('HOTEL_DIRECT', 'DMC', 'CHANNEL_MANAGER', 'BEDBANK', 'GDS');
CREATE TYPE "SupplierStatus" AS ENUM ('DRAFT', 'PENDING_REVIEW', 'ACTIVE', 'SUSPENDED', 'INACTIVE');
CREATE TYPE "ContentStatus" AS ENUM ('DRAFT', 'INCOMPLETE', 'COMPLETE', 'SUSPENDED');

CREATE TABLE "Supplier" (
  "id" TEXT NOT NULL, "tenant_id" TEXT NOT NULL, "type" "SupplierType" NOT NULL,
  "status" "SupplierStatus" NOT NULL DEFAULT 'DRAFT', "legal_name" TEXT NOT NULL,
  "display_name" TEXT NOT NULL, "country_code" CHAR(2) NOT NULL,
  "default_currency" CHAR(3) NOT NULL, "contact_metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Supplier_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "Supplier_country_code_check" CHECK ("country_code" ~ '^[A-Z]{2}$'),
  CONSTRAINT "Supplier_default_currency_check" CHECK ("default_currency" ~ '^[A-Z]{3}$')
);
CREATE UNIQUE INDEX "Supplier_tenant_id_legal_name_key" ON "Supplier"("tenant_id", "legal_name");
CREATE INDEX "Supplier_tenant_id_status_idx" ON "Supplier"("tenant_id", "status");
CREATE INDEX "Supplier_tenant_id_country_code_idx" ON "Supplier"("tenant_id", "country_code");

CREATE TABLE "Hotel" (
  "id" TEXT NOT NULL, "tenant_id" TEXT NOT NULL, "name" TEXT NOT NULL,
  "property_type" TEXT NOT NULL, "star_rating" INTEGER, "address" TEXT,
  "city" TEXT NOT NULL, "country_code" CHAR(2) NOT NULL,
  "latitude" DECIMAL(9,6), "longitude" DECIMAL(9,6),
  "time_zone" TEXT NOT NULL DEFAULT 'Asia/Dubai',
  "content_status" "ContentStatus" NOT NULL DEFAULT 'DRAFT', "external_ref" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Hotel_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Hotel_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "Hotel_star_rating_check" CHECK ("star_rating" IS NULL OR "star_rating" BETWEEN 1 AND 7),
  CONSTRAINT "Hotel_country_code_check" CHECK ("country_code" ~ '^[A-Z]{2}$')
);
CREATE UNIQUE INDEX "Hotel_tenant_id_external_ref_key" ON "Hotel"("tenant_id", "external_ref");
CREATE INDEX "Hotel_tenant_id_country_code_city_idx" ON "Hotel"("tenant_id", "country_code", "city");
CREATE INDEX "Hotel_tenant_id_content_status_idx" ON "Hotel"("tenant_id", "content_status");

CREATE TABLE "RoomType" (
  "id" TEXT NOT NULL, "hotel_id" TEXT NOT NULL, "name" TEXT NOT NULL, "code" TEXT NOT NULL,
  "max_adults" INTEGER NOT NULL, "max_children" INTEGER NOT NULL DEFAULT 0,
  "max_occupancy" INTEGER NOT NULL, "bedding_metadata" JSONB NOT NULL DEFAULT '{}',
  "is_active" BOOLEAN NOT NULL DEFAULT true, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RoomType_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RoomType_hotel_id_fkey" FOREIGN KEY ("hotel_id") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "RoomType_occupancy_check" CHECK ("max_adults" > 0 AND "max_children" >= 0 AND "max_occupancy" >= "max_adults")
);
CREATE UNIQUE INDEX "RoomType_hotel_id_code_key" ON "RoomType"("hotel_id", "code");
CREATE INDEX "RoomType_hotel_id_is_active_idx" ON "RoomType"("hotel_id", "is_active");

CREATE TABLE "BoardBasis" (
  "id" TEXT NOT NULL, "tenant_id" TEXT NOT NULL, "code" CHAR(3) NOT NULL,
  "name" TEXT NOT NULL, "description" TEXT, "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BoardBasis_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BoardBasis_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "BoardBasis_tenant_id_code_key" ON "BoardBasis"("tenant_id", "code");
CREATE INDEX "BoardBasis_tenant_id_is_active_idx" ON "BoardBasis"("tenant_id", "is_active");

ALTER TABLE "Supplier" ENABLE ROW LEVEL SECURITY; ALTER TABLE "Supplier" FORCE ROW LEVEL SECURITY;
ALTER TABLE "Hotel" ENABLE ROW LEVEL SECURITY; ALTER TABLE "Hotel" FORCE ROW LEVEL SECURITY;
ALTER TABLE "BoardBasis" ENABLE ROW LEVEL SECURITY; ALTER TABLE "BoardBasis" FORCE ROW LEVEL SECURITY;
CREATE POLICY "Supplier_tenant_isolation" ON "Supplier" USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());
CREATE POLICY "Hotel_tenant_isolation" ON "Hotel" USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());
CREATE POLICY "BoardBasis_tenant_isolation" ON "BoardBasis" USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());
ALTER TABLE "RoomType" ENABLE ROW LEVEL SECURITY; ALTER TABLE "RoomType" FORCE ROW LEVEL SECURITY;
CREATE POLICY "RoomType_tenant_isolation" ON "RoomType"
  USING (EXISTS (SELECT 1 FROM "Hotel" WHERE "Hotel"."id" = "RoomType"."hotel_id" AND "Hotel"."tenant_id" = "fbeds_current_tenant_id"()))
  WITH CHECK (EXISTS (SELECT 1 FROM "Hotel" WHERE "Hotel"."id" = "RoomType"."hotel_id" AND "Hotel"."tenant_id" = "fbeds_current_tenant_id"()));
