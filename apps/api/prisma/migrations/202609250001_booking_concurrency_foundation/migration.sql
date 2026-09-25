-- Forward-only booking concurrency foundation. This creates non-bookable,
-- tenant-scoped inventory holds; it does not enable booking or supplier confirmation.
CREATE TYPE "InventoryHoldStatus" AS ENUM (
  'PENDING_RECHECK', 'RECHECKED', 'HOLD_PENDING', 'HELD', 'RELEASED', 'EXPIRED', 'FAILED'
);

ALTER TABLE "DailyAvailability" ADD COLUMN "held" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "DailyAvailability" DROP CONSTRAINT "DailyAvailability_inventory_check";
ALTER TABLE "DailyAvailability" ADD CONSTRAINT "DailyAvailability_inventory_check"
  CHECK ("allotment" >= 0 AND "sold" >= 0 AND "held" >= 0 AND "sold" + "held" <= "allotment" AND "min_stay" > 0);
CREATE UNIQUE INDEX "DailyAvailability_tenant_id_id_key" ON "DailyAvailability"("tenant_id", "id");

CREATE TABLE "InventoryHold" (
  "id" TEXT NOT NULL, "tenant_id" TEXT NOT NULL, "rate_plan_id" TEXT NOT NULL,
  "offer_id" TEXT NOT NULL, "search_id" TEXT NOT NULL, "canonical_hotel_id" TEXT NOT NULL,
  "canonical_room_type_id" TEXT NOT NULL, "board_basis_id" TEXT NOT NULL,
  "check_in" DATE NOT NULL, "check_out" DATE NOT NULL, "rooms" INTEGER NOT NULL,
  "currency" CHAR(3) NOT NULL, "sell_amount_minor" BIGINT NOT NULL,
  "idempotency_key" TEXT NOT NULL, "request_fingerprint" TEXT NOT NULL,
  "request_id" TEXT NOT NULL, "created_by_user_id" TEXT NOT NULL,
  "status" "InventoryHoldStatus" NOT NULL DEFAULT 'HOLD_PENDING',
  "expires_at" TIMESTAMP(3) NOT NULL, "released_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "InventoryHold_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InventoryHold_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "InventoryHold_values_check" CHECK (
    "rooms" > 0 AND "check_out" > "check_in" AND "sell_amount_minor" >= 0 AND
    "currency" ~ '^[A-Z]{3}$' AND length("idempotency_key") BETWEEN 8 AND 128 AND
    length("request_fingerprint") = 64 AND "expires_at" > "created_at"
  )
);
CREATE UNIQUE INDEX "InventoryHold_tenant_id_idempotency_key_key" ON "InventoryHold"("tenant_id", "idempotency_key");
CREATE UNIQUE INDEX "InventoryHold_tenant_id_id_key" ON "InventoryHold"("tenant_id", "id");
CREATE INDEX "InventoryHold_tenant_id_status_expires_at_idx" ON "InventoryHold"("tenant_id", "status", "expires_at");
CREATE INDEX "InventoryHold_tenant_id_rate_plan_id_check_in_check_out_idx" ON "InventoryHold"("tenant_id", "rate_plan_id", "check_in", "check_out");

CREATE TABLE "InventoryHoldNight" (
  "id" TEXT NOT NULL, "tenant_id" TEXT NOT NULL, "hold_id" TEXT NOT NULL,
  "availability_id" TEXT NOT NULL, "stay_date" DATE NOT NULL, "quantity" INTEGER NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InventoryHoldNight_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InventoryHoldNight_tenant_id_hold_id_fkey" FOREIGN KEY ("tenant_id", "hold_id") REFERENCES "InventoryHold"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "InventoryHoldNight_tenant_id_availability_id_fkey" FOREIGN KEY ("tenant_id", "availability_id") REFERENCES "DailyAvailability"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "InventoryHoldNight_quantity_check" CHECK ("quantity" > 0)
);
CREATE UNIQUE INDEX "InventoryHoldNight_hold_id_availability_id_key" ON "InventoryHoldNight"("hold_id", "availability_id");
CREATE INDEX "InventoryHoldNight_tenant_id_stay_date_idx" ON "InventoryHoldNight"("tenant_id", "stay_date");

ALTER TABLE "InventoryHold" ENABLE ROW LEVEL SECURITY; ALTER TABLE "InventoryHold" FORCE ROW LEVEL SECURITY;
ALTER TABLE "InventoryHoldNight" ENABLE ROW LEVEL SECURITY; ALTER TABLE "InventoryHoldNight" FORCE ROW LEVEL SECURITY;
CREATE POLICY "InventoryHold_tenant_isolation" ON "InventoryHold"
  USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());
CREATE POLICY "InventoryHoldNight_tenant_isolation" ON "InventoryHoldNight"
  USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());
