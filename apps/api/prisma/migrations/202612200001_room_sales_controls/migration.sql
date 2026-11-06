-- ADR 0113: room sales controls, allocation breakdown, supplier requests and a simulated distribution outbox.
--
-- Sales controls are not stock. InventoryPoolDay.capacity, sold and held stay the physical counters. PoolNightAllocation
-- records the contracted figure, adjustments and blocked rooms that explain that capacity. RoomSalesRule records Free Sale,
-- Stop Sale, On Request and Limited for a room night and scope. A Free Sale rule does not by itself authorize unlimited stock.
--
-- Rollback (forward migration; nothing else references these objects):
--   DROP TABLE "SupplierStayRequest"; DROP TABLE "SalesDistributionJob"; DROP TABLE "RoomSalesAudit";
--   DROP TABLE "RoomSalesRule"; DROP TABLE "PoolNightAllocation"; DROP TABLE "RoomSalesBatch";
--   DROP FUNCTION "fbeds_room_sales_audit_guard"();
--   DROP TYPE "SupplierStayRequestStatus"; DROP TYPE "SalesDistributionStatus"; DROP TYPE "RoomSalesMode";

CREATE TYPE "RoomSalesMode" AS ENUM ('FREE_SALE', 'STOP_SALE', 'ON_REQUEST', 'LIMITED');
CREATE TYPE "SalesDistributionStatus" AS ENUM ('PENDING', 'ACKNOWLEDGED', 'FAILED');
CREATE TYPE "SupplierStayRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED');

CREATE TABLE "RoomSalesBatch" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "hotel_id" TEXT NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "actor_id" TEXT NOT NULL,
  "cell_count" INTEGER NOT NULL,
  "idempotency_key" VARCHAR(80) NOT NULL,
  "request_hash" CHAR(64) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RoomSalesBatch_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RoomSalesRule" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "hotel_id" TEXT NOT NULL,
  "room_type_id" TEXT NOT NULL,
  "stay_date" DATE NOT NULL,
  "pool_key" VARCHAR(40) NOT NULL DEFAULT '',
  "plan_key" VARCHAR(40) NOT NULL DEFAULT '',
  "channel_key" VARCHAR(40) NOT NULL DEFAULT '',
  "market_key" VARCHAR(8) NOT NULL DEFAULT '',
  "contract_key" VARCHAR(40) NOT NULL DEFAULT '',
  "mode" "RoomSalesMode" NOT NULL,
  "sales_cap" INTEGER,
  "consumes_inventory" BOOLEAN NOT NULL DEFAULT true,
  "response_deadline_hours" INTEGER,
  "request_owner_label" VARCHAR(80),
  "escalation_policy" VARCHAR(200),
  "reason" VARCHAR(500) NOT NULL,
  "source" VARCHAR(24) NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "override_expires_at" TIMESTAMP(3),
  "batch_id" TEXT NOT NULL,
  "actor_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RoomSalesRule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RoomSalesAudit" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "hotel_id" TEXT NOT NULL,
  "batch_id" TEXT NOT NULL,
  "room_type_id" TEXT NOT NULL,
  "stay_date" DATE NOT NULL,
  "before_mode" VARCHAR(24),
  "after_mode" VARCHAR(24),
  "before_cap" INTEGER,
  "after_cap" INTEGER,
  "actor_id" TEXT NOT NULL,
  "source" VARCHAR(24) NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RoomSalesAudit_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PoolNightAllocation" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "hotel_id" TEXT NOT NULL,
  "pool_id" TEXT NOT NULL,
  "stay_date" DATE NOT NULL,
  "contracted" INTEGER NOT NULL,
  "approved_adjustment" INTEGER NOT NULL DEFAULT 0,
  "blocked_quantity" INTEGER NOT NULL DEFAULT 0,
  "blocked_excluded" BOOLEAN NOT NULL DEFAULT false,
  "post_release_policy" VARCHAR(32) NOT NULL DEFAULT 'CLOSED',
  "release_cutoff_days" INTEGER,
  "release_time_local" CHAR(5),
  "response_deadline_hours" INTEGER,
  "request_owner_label" VARCHAR(80),
  "escalation_policy" VARCHAR(200),
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PoolNightAllocation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SalesDistributionJob" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "hotel_id" TEXT NOT NULL,
  "batch_id" TEXT NOT NULL,
  "status" "SalesDistributionStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "last_error" VARCHAR(300),
  "payload_hash" CHAR(64) NOT NULL,
  "simulated" BOOLEAN NOT NULL DEFAULT true,
  "acknowledged_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SalesDistributionJob_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SupplierStayRequest" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "hotel_id" TEXT NOT NULL,
  "room_type_id" TEXT NOT NULL,
  "rate_plan_id" TEXT NOT NULL,
  "check_in" DATE NOT NULL,
  "check_out" DATE NOT NULL,
  "rooms" INTEGER NOT NULL,
  "status" "SupplierStayRequestStatus" NOT NULL DEFAULT 'PENDING',
  "deadline_at" TIMESTAMP(3) NOT NULL,
  "owner_label" VARCHAR(80) NOT NULL,
  "escalation_policy" VARCHAR(200) NOT NULL,
  "idempotency_key" VARCHAR(80) NOT NULL,
  "request_hash" CHAR(64) NOT NULL,
  "decision_reason" VARCHAR(500),
  "created_by_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SupplierStayRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RoomSalesBatch_tenant_id_id_key" ON "RoomSalesBatch"("tenant_id", "id");
CREATE UNIQUE INDEX "RoomSalesBatch_tenant_id_idempotency_key_key" ON "RoomSalesBatch"("tenant_id", "idempotency_key");
CREATE INDEX "RoomSalesBatch_tenant_id_hotel_id_created_at_idx" ON "RoomSalesBatch"("tenant_id", "hotel_id", "created_at");
CREATE INDEX "RoomSalesBatch_hotel_id_idx" ON "RoomSalesBatch"("hotel_id");

CREATE UNIQUE INDEX "RoomSalesRule_scope" ON "RoomSalesRule"("tenant_id", "room_type_id", "stay_date", "pool_key", "plan_key", "channel_key", "market_key", "contract_key");
CREATE UNIQUE INDEX "RoomSalesRule_tenant_id_id_key" ON "RoomSalesRule"("tenant_id", "id");
CREATE INDEX "RoomSalesRule_tenant_id_hotel_id_stay_date_idx" ON "RoomSalesRule"("tenant_id", "hotel_id", "stay_date");
CREATE INDEX "RoomSalesRule_hotel_id_room_type_id_idx" ON "RoomSalesRule"("hotel_id", "room_type_id");
CREATE INDEX "RoomSalesRule_batch_id_idx" ON "RoomSalesRule"("batch_id");

CREATE INDEX "RoomSalesAudit_tenant_id_hotel_id_room_type_id_stay_date_idx" ON "RoomSalesAudit"("tenant_id", "hotel_id", "room_type_id", "stay_date");
CREATE INDEX "RoomSalesAudit_batch_id_idx" ON "RoomSalesAudit"("batch_id");
CREATE INDEX "RoomSalesAudit_hotel_id_idx" ON "RoomSalesAudit"("hotel_id");

CREATE UNIQUE INDEX "PoolNightAllocation_pool_id_stay_date_key" ON "PoolNightAllocation"("pool_id", "stay_date");
CREATE UNIQUE INDEX "PoolNightAllocation_tenant_id_id_key" ON "PoolNightAllocation"("tenant_id", "id");
CREATE INDEX "PoolNightAllocation_tenant_id_hotel_id_stay_date_idx" ON "PoolNightAllocation"("tenant_id", "hotel_id", "stay_date");
CREATE INDEX "PoolNightAllocation_hotel_id_idx" ON "PoolNightAllocation"("hotel_id");

CREATE UNIQUE INDEX "SalesDistributionJob_tenant_id_batch_id_key" ON "SalesDistributionJob"("tenant_id", "batch_id");
CREATE UNIQUE INDEX "SalesDistributionJob_tenant_id_id_key" ON "SalesDistributionJob"("tenant_id", "id");
CREATE INDEX "SalesDistributionJob_tenant_id_hotel_id_status_idx" ON "SalesDistributionJob"("tenant_id", "hotel_id", "status");
CREATE INDEX "SalesDistributionJob_hotel_id_idx" ON "SalesDistributionJob"("hotel_id");
CREATE INDEX "SalesDistributionJob_batch_id_idx" ON "SalesDistributionJob"("batch_id");

CREATE UNIQUE INDEX "SupplierStayRequest_tenant_id_idempotency_key_key" ON "SupplierStayRequest"("tenant_id", "idempotency_key");
CREATE UNIQUE INDEX "SupplierStayRequest_tenant_id_id_key" ON "SupplierStayRequest"("tenant_id", "id");
CREATE INDEX "SupplierStayRequest_tenant_id_hotel_id_status_idx" ON "SupplierStayRequest"("tenant_id", "hotel_id", "status");
CREATE INDEX "SupplierStayRequest_hotel_id_room_type_id_idx" ON "SupplierStayRequest"("hotel_id", "room_type_id");

ALTER TABLE "RoomSalesBatch" ADD CONSTRAINT "RoomSalesBatch_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RoomSalesBatch" ADD CONSTRAINT "RoomSalesBatch_tenant_id_hotel_id_fkey" FOREIGN KEY ("tenant_id", "hotel_id") REFERENCES "Hotel"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RoomSalesRule" ADD CONSTRAINT "RoomSalesRule_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RoomSalesRule" ADD CONSTRAINT "RoomSalesRule_tenant_id_hotel_id_fkey" FOREIGN KEY ("tenant_id", "hotel_id") REFERENCES "Hotel"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RoomSalesRule" ADD CONSTRAINT "RoomSalesRule_hotel_id_room_type_id_fkey" FOREIGN KEY ("hotel_id", "room_type_id") REFERENCES "RoomType"("hotel_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RoomSalesRule" ADD CONSTRAINT "RoomSalesRule_tenant_id_batch_id_fkey" FOREIGN KEY ("tenant_id", "batch_id") REFERENCES "RoomSalesBatch"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RoomSalesAudit" ADD CONSTRAINT "RoomSalesAudit_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RoomSalesAudit" ADD CONSTRAINT "RoomSalesAudit_tenant_id_hotel_id_fkey" FOREIGN KEY ("tenant_id", "hotel_id") REFERENCES "Hotel"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RoomSalesAudit" ADD CONSTRAINT "RoomSalesAudit_tenant_id_batch_id_fkey" FOREIGN KEY ("tenant_id", "batch_id") REFERENCES "RoomSalesBatch"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RoomSalesAudit" ADD CONSTRAINT "RoomSalesAudit_hotel_id_room_type_id_fkey" FOREIGN KEY ("hotel_id", "room_type_id") REFERENCES "RoomType"("hotel_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PoolNightAllocation" ADD CONSTRAINT "PoolNightAllocation_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PoolNightAllocation" ADD CONSTRAINT "PoolNightAllocation_tenant_id_hotel_id_fkey" FOREIGN KEY ("tenant_id", "hotel_id") REFERENCES "Hotel"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PoolNightAllocation" ADD CONSTRAINT "PoolNightAllocation_tenant_id_pool_id_fkey" FOREIGN KEY ("tenant_id", "pool_id") REFERENCES "InventoryPool"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SalesDistributionJob" ADD CONSTRAINT "SalesDistributionJob_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SalesDistributionJob" ADD CONSTRAINT "SalesDistributionJob_tenant_id_hotel_id_fkey" FOREIGN KEY ("tenant_id", "hotel_id") REFERENCES "Hotel"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SalesDistributionJob" ADD CONSTRAINT "SalesDistributionJob_tenant_id_batch_id_fkey" FOREIGN KEY ("tenant_id", "batch_id") REFERENCES "RoomSalesBatch"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SupplierStayRequest" ADD CONSTRAINT "SupplierStayRequest_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupplierStayRequest" ADD CONSTRAINT "SupplierStayRequest_tenant_id_hotel_id_fkey" FOREIGN KEY ("tenant_id", "hotel_id") REFERENCES "Hotel"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupplierStayRequest" ADD CONSTRAINT "SupplierStayRequest_hotel_id_room_type_id_fkey" FOREIGN KEY ("hotel_id", "room_type_id") REFERENCES "RoomType"("hotel_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RoomSalesRule" ADD CONSTRAINT "RoomSalesRule_shape_check" CHECK (
  "version" >= 1
  AND char_length(btrim("reason")) BETWEEN 3 AND 500
  AND "source" IN ('MANUAL', 'SUPPLIER', 'SYSTEM', 'RELEASE')
  AND ("mode" <> 'LIMITED' OR ("sales_cap" BETWEEN 1 AND 9999))
  AND ("mode" = 'LIMITED' OR "sales_cap" IS NULL)
  AND ("mode" <> 'ON_REQUEST' OR ("response_deadline_hours" BETWEEN 1 AND 168 AND char_length(btrim("request_owner_label")) >= 2 AND char_length(btrim("escalation_policy")) >= 3))
  AND ("mode" = 'ON_REQUEST' OR ("response_deadline_hours" IS NULL AND "request_owner_label" IS NULL AND "escalation_policy" IS NULL))
);

ALTER TABLE "PoolNightAllocation" ADD CONSTRAINT "PoolNightAllocation_shape_check" CHECK (
  "contracted" BETWEEN 0 AND 9999
  AND "approved_adjustment" BETWEEN -9999 AND 9999
  AND "blocked_quantity" BETWEEN 0 AND 9999
  AND "version" >= 1
  AND "post_release_policy" IN ('CLOSED', 'ON_REQUEST', 'AUTHORIZED_FREE_SALE')
  AND ("release_cutoff_days" IS NULL OR "release_cutoff_days" BETWEEN 0 AND 365)
  AND ("release_time_local" IS NULL OR "release_time_local" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
  AND ("post_release_policy" <> 'ON_REQUEST' OR ("response_deadline_hours" BETWEEN 1 AND 168 AND char_length(btrim("request_owner_label")) >= 2 AND char_length(btrim("escalation_policy")) >= 3))
);

ALTER TABLE "SupplierStayRequest" ADD CONSTRAINT "SupplierStayRequest_shape_check" CHECK (
  "rooms" BETWEEN 1 AND 50
  AND "check_out" > "check_in"
  AND char_length(btrim("owner_label")) >= 2
  AND char_length(btrim("escalation_policy")) >= 3
);

CREATE FUNCTION "fbeds_room_sales_audit_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ROOM_SALES_AUDIT_IMMUTABLE' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER "RoomSalesAudit_immutable" BEFORE UPDATE OR DELETE ON "RoomSalesAudit" FOR EACH ROW EXECUTE FUNCTION "fbeds_room_sales_audit_guard"();

ALTER TABLE "RoomSalesBatch" ENABLE ROW LEVEL SECURITY; ALTER TABLE "RoomSalesBatch" FORCE ROW LEVEL SECURITY;
CREATE POLICY "RoomSalesBatch_tenant_isolation" ON "RoomSalesBatch" USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());
ALTER TABLE "RoomSalesRule" ENABLE ROW LEVEL SECURITY; ALTER TABLE "RoomSalesRule" FORCE ROW LEVEL SECURITY;
CREATE POLICY "RoomSalesRule_tenant_isolation" ON "RoomSalesRule" USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());
ALTER TABLE "RoomSalesAudit" ENABLE ROW LEVEL SECURITY; ALTER TABLE "RoomSalesAudit" FORCE ROW LEVEL SECURITY;
CREATE POLICY "RoomSalesAudit_tenant_isolation" ON "RoomSalesAudit" USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());
ALTER TABLE "PoolNightAllocation" ENABLE ROW LEVEL SECURITY; ALTER TABLE "PoolNightAllocation" FORCE ROW LEVEL SECURITY;
CREATE POLICY "PoolNightAllocation_tenant_isolation" ON "PoolNightAllocation" USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());
ALTER TABLE "SalesDistributionJob" ENABLE ROW LEVEL SECURITY; ALTER TABLE "SalesDistributionJob" FORCE ROW LEVEL SECURITY;
CREATE POLICY "SalesDistributionJob_tenant_isolation" ON "SalesDistributionJob" USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());
ALTER TABLE "SupplierStayRequest" ENABLE ROW LEVEL SECURITY; ALTER TABLE "SupplierStayRequest" FORCE ROW LEVEL SECURITY;
CREATE POLICY "SupplierStayRequest_tenant_isolation" ON "SupplierStayRequest" USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());
