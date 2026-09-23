-- Forward-only mapping governance. Existing rows are checked before any DDL.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "SupplierHotelMapping" m
    LEFT JOIN "Supplier" s ON s.id = m.supplier_id
    LEFT JOIN "Hotel" h ON h.id = m.hotel_id
    WHERE s.id IS NULL OR h.id IS NULL
      OR m.tenant_id IS DISTINCT FROM s.tenant_id
      OR m.tenant_id IS DISTINCT FROM h.tenant_id
      OR m.supplier_hotel_id IS NULL OR btrim(m.supplier_hotel_id) = ''
      OR m.status::text NOT IN ('PENDING', 'MAPPED', 'REJECTED')
  ) OR EXISTS (
    SELECT 1 FROM "SupplierHotelMapping"
    GROUP BY supplier_id, supplier_hotel_id HAVING count(*) > 1
  ) OR EXISTS (
    SELECT 1 FROM "SupplierHotelMapping"
    GROUP BY supplier_id, hotel_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Supplier mapping preflight failed: inspect existing rows before applying this migration';
  END IF;
END $$;

CREATE UNIQUE INDEX "Supplier_tenant_id_id_key" ON "Supplier" ("tenant_id", "id");
CREATE UNIQUE INDEX "Hotel_tenant_id_id_key" ON "Hotel" ("tenant_id", "id");
CREATE UNIQUE INDEX "RoomType_hotel_id_id_key" ON "RoomType" ("hotel_id", "id");
CREATE UNIQUE INDEX "SupplierHotelMapping_tenant_id_id_hotel_id_key" ON "SupplierHotelMapping" ("tenant_id", "id", "hotel_id");

ALTER TABLE "SupplierHotelMapping" ADD CONSTRAINT "SupplierHotelMapping_supplier_hotel_id_nonblank"
  CHECK (btrim("supplier_hotel_id") <> '');
-- The composite constraints replace the two single-column keys atomically;
-- they retain the original cascade behavior and strengthen tenant integrity.
ALTER TABLE "SupplierHotelMapping" DROP CONSTRAINT "SupplierHotelMapping_supplier_id_fkey";
ALTER TABLE "SupplierHotelMapping" DROP CONSTRAINT "SupplierHotelMapping_hotel_id_fkey";
ALTER TABLE "SupplierHotelMapping" ADD CONSTRAINT "SupplierHotelMapping_tenant_id_supplier_id_fkey"
  FOREIGN KEY ("tenant_id", "supplier_id") REFERENCES "Supplier" ("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SupplierHotelMapping" ADD CONSTRAINT "SupplierHotelMapping_tenant_id_hotel_id_fkey"
  FOREIGN KEY ("tenant_id", "hotel_id") REFERENCES "Hotel" ("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "SupplierRoomMapping" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "supplier_hotel_mapping_id" TEXT NOT NULL,
  "hotel_id" TEXT NOT NULL,
  "supplier_room_id" TEXT NOT NULL,
  "room_type_id" TEXT NOT NULL,
  "status" "MappingStatus" NOT NULL DEFAULT 'PENDING',
  "confidence" INTEGER,
  "source_metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SupplierRoomMapping_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SupplierRoomMapping_supplier_room_id_nonblank" CHECK (btrim("supplier_room_id") <> ''),
  CONSTRAINT "SupplierRoomMapping_confidence_check" CHECK ("confidence" IS NULL OR "confidence" BETWEEN 0 AND 100),
  CONSTRAINT "SupplierRoomMapping_tenant_id_supplier_hotel_mapping_id_ho_fkey" FOREIGN KEY ("tenant_id", "supplier_hotel_mapping_id", "hotel_id")
    REFERENCES "SupplierHotelMapping" ("tenant_id", "id", "hotel_id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SupplierRoomMapping_hotel_id_room_type_id_fkey" FOREIGN KEY ("hotel_id", "room_type_id")
    REFERENCES "RoomType" ("hotel_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "SupplierRoomMapping_supplier_hotel_mapping_id_supplier_room_key"
  ON "SupplierRoomMapping" ("supplier_hotel_mapping_id", "supplier_room_id");
CREATE INDEX "SupplierRoomMapping_tenant_id_status_idx" ON "SupplierRoomMapping" ("tenant_id", "status");
CREATE INDEX "SupplierRoomMapping_hotel_id_room_type_id_idx" ON "SupplierRoomMapping" ("hotel_id", "room_type_id");

ALTER TABLE "SupplierRoomMapping" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SupplierRoomMapping" FORCE ROW LEVEL SECURITY;
CREATE POLICY "SupplierRoomMapping_tenant_isolation" ON "SupplierRoomMapping"
  USING ("tenant_id" = "fbeds_current_tenant_id"())
  WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());

INSERT INTO "Permission" ("id", "key", "description") VALUES
  ('perm_supply_mappings_read', 'supply.mappings.read', 'Read supplier hotel and room mapping governance'),
  ('perm_supply_mappings_manage', 'supply.mappings.manage', 'Manage supplier hotel and room mapping governance')
ON CONFLICT ("key") DO UPDATE SET "description" = EXCLUDED."description";
