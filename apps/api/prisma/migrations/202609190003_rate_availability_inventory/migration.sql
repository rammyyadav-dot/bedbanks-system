-- Forward-only supply foundation 3: dated rate and availability inventory.
CREATE TYPE "ConnectorExecutionStatus" AS ENUM ('RECEIVED', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'RETRYING');

CREATE TABLE "DailyAvailability" (
  "id" TEXT NOT NULL, "tenant_id" TEXT NOT NULL, "rate_plan_id" TEXT NOT NULL,
  "stay_date" DATE NOT NULL, "allotment" INTEGER NOT NULL, "sold" INTEGER NOT NULL DEFAULT 0,
  "stop_sell" BOOLEAN NOT NULL DEFAULT false, "min_stay" INTEGER NOT NULL DEFAULT 1,
  "closed_to_arrival" BOOLEAN NOT NULL DEFAULT false, "closed_to_departure" BOOLEAN NOT NULL DEFAULT false,
  "source_updated_at" TIMESTAMP(3), "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DailyAvailability_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DailyAvailability_rate_plan_id_fkey" FOREIGN KEY ("rate_plan_id") REFERENCES "RatePlan"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "DailyAvailability_inventory_check" CHECK ("allotment" >= 0 AND "sold" >= 0 AND "sold" <= "allotment" AND "min_stay" > 0)
);
CREATE UNIQUE INDEX "DailyAvailability_rate_plan_id_stay_date_key" ON "DailyAvailability"("rate_plan_id", "stay_date");
CREATE INDEX "DailyAvailability_tenant_id_stay_date_idx" ON "DailyAvailability"("tenant_id", "stay_date");

CREATE TABLE "DailyRate" (
  "id" TEXT NOT NULL, "tenant_id" TEXT NOT NULL, "rate_plan_id" TEXT NOT NULL,
  "stay_date" DATE NOT NULL, "occupancy" INTEGER NOT NULL, "amount_minor" BIGINT NOT NULL,
  "currency" CHAR(3) NOT NULL, "tax_metadata" JSONB NOT NULL DEFAULT '{}',
  "fee_metadata" JSONB NOT NULL DEFAULT '{}', "source_version" TEXT,
  "source_updated_at" TIMESTAMP(3), "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DailyRate_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DailyRate_rate_plan_id_fkey" FOREIGN KEY ("rate_plan_id") REFERENCES "RatePlan"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "DailyRate_values_check" CHECK ("occupancy" > 0 AND "amount_minor" >= 0 AND "currency" ~ '^[A-Z]{3}$')
);
CREATE UNIQUE INDEX "DailyRate_rate_plan_id_stay_date_occupancy_key" ON "DailyRate"("rate_plan_id", "stay_date", "occupancy");
CREATE INDEX "DailyRate_tenant_id_stay_date_idx" ON "DailyRate"("tenant_id", "stay_date");

ALTER TABLE "DailyAvailability" ENABLE ROW LEVEL SECURITY; ALTER TABLE "DailyAvailability" FORCE ROW LEVEL SECURITY;
ALTER TABLE "DailyRate" ENABLE ROW LEVEL SECURITY; ALTER TABLE "DailyRate" FORCE ROW LEVEL SECURITY;
CREATE POLICY "DailyAvailability_tenant_isolation" ON "DailyAvailability" USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());
CREATE POLICY "DailyRate_tenant_isolation" ON "DailyRate" USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());
