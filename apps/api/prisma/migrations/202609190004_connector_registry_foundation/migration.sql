-- Forward-only supply foundation 4: connector registry, secure references and auditable events.
CREATE TYPE "ConnectorType" AS ENUM ('API_JSON', 'XML_IN', 'XML_OUT', 'CHANNEL_MANAGER', 'MANUAL_EXTRANET');
CREATE TYPE "ConnectorStatus" AS ENUM ('DRAFT', 'ACTIVE', 'SUSPENDED', 'DISABLED');

CREATE TABLE "ConnectorDefinition" (
  "id" TEXT NOT NULL, "tenant_id" TEXT NOT NULL, "supplier_id" TEXT NOT NULL,
  "type" "ConnectorType" NOT NULL, "status" "ConnectorStatus" NOT NULL DEFAULT 'DRAFT',
  "name" TEXT NOT NULL, "capabilities" JSONB NOT NULL DEFAULT '[]',
  "transport_metadata" JSONB NOT NULL DEFAULT '{}', "version" TEXT NOT NULL,
  "health_state" TEXT NOT NULL DEFAULT 'unknown', "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ConnectorDefinition_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ConnectorDefinition_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ConnectorDefinition_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ConnectorDefinition_supplier_id_name_key" ON "ConnectorDefinition"("supplier_id", "name");
CREATE INDEX "ConnectorDefinition_tenant_id_status_idx" ON "ConnectorDefinition"("tenant_id", "status");

CREATE TABLE "ConnectorCredentialReference" (
  "id" TEXT NOT NULL, "connector_id" TEXT NOT NULL, "secret_ref" TEXT NOT NULL,
  "purpose" TEXT NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ConnectorCredentialReference_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ConnectorCredentialReference_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "ConnectorDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ConnectorCredentialReference_secret_ref_check" CHECK ("secret_ref" !~* '(password|token|secret|apikey|authorization|cookie|bearer)')
);
CREATE UNIQUE INDEX "ConnectorCredentialReference_connector_id_purpose_key" ON "ConnectorCredentialReference"("connector_id", "purpose");

CREATE TABLE "ConnectorExecution" (
  "id" TEXT NOT NULL, "tenant_id" TEXT NOT NULL, "connector_id" TEXT NOT NULL,
  "correlation_id" TEXT NOT NULL, "operation" TEXT NOT NULL,
  "status" "ConnectorExecutionStatus" NOT NULL DEFAULT 'RECEIVED',
  "latency_ms" INTEGER, "retry_count" INTEGER NOT NULL DEFAULT 0,
  "error_classification" TEXT, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ConnectorExecution_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ConnectorExecution_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "ConnectorDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ConnectorExecution_values_check" CHECK (("latency_ms" IS NULL OR "latency_ms" >= 0) AND "retry_count" >= 0)
);
CREATE UNIQUE INDEX "ConnectorExecution_connector_id_correlation_id_key" ON "ConnectorExecution"("connector_id", "correlation_id");
CREATE INDEX "ConnectorExecution_tenant_id_created_at_idx" ON "ConnectorExecution"("tenant_id", "created_at");

CREATE TABLE "InventoryUpdateEvent" (
  "id" TEXT NOT NULL, "tenant_id" TEXT NOT NULL, "supplier_id" TEXT NOT NULL,
  "connector_id" TEXT, "idempotency_key" TEXT NOT NULL,
  "outcome" "ConnectorExecutionStatus" NOT NULL DEFAULT 'RECEIVED',
  "validation_errors" JSONB NOT NULL DEFAULT '[]', "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processed_at" TIMESTAMP(3),
  CONSTRAINT "InventoryUpdateEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InventoryUpdateEvent_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "InventoryUpdateEvent_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "InventoryUpdateEvent_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "ConnectorDefinition"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "InventoryUpdateEvent_supplier_id_idempotency_key_key" ON "InventoryUpdateEvent"("supplier_id", "idempotency_key");
CREATE INDEX "InventoryUpdateEvent_tenant_id_received_at_idx" ON "InventoryUpdateEvent"("tenant_id", "received_at");

ALTER TABLE "ConnectorDefinition" ENABLE ROW LEVEL SECURITY; ALTER TABLE "ConnectorDefinition" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ConnectorExecution" ENABLE ROW LEVEL SECURITY; ALTER TABLE "ConnectorExecution" FORCE ROW LEVEL SECURITY;
ALTER TABLE "InventoryUpdateEvent" ENABLE ROW LEVEL SECURITY; ALTER TABLE "InventoryUpdateEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ConnectorDefinition_tenant_isolation" ON "ConnectorDefinition" USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());
CREATE POLICY "ConnectorExecution_tenant_isolation" ON "ConnectorExecution" USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());
CREATE POLICY "InventoryUpdateEvent_tenant_isolation" ON "InventoryUpdateEvent" USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());
ALTER TABLE "ConnectorCredentialReference" ENABLE ROW LEVEL SECURITY; ALTER TABLE "ConnectorCredentialReference" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ConnectorCredentialReference_tenant_isolation" ON "ConnectorCredentialReference"
  USING (EXISTS (SELECT 1 FROM "ConnectorDefinition" WHERE "ConnectorDefinition"."id" = "ConnectorCredentialReference"."connector_id" AND "ConnectorDefinition"."tenant_id" = "fbeds_current_tenant_id"()))
  WITH CHECK (EXISTS (SELECT 1 FROM "ConnectorDefinition" WHERE "ConnectorDefinition"."id" = "ConnectorCredentialReference"."connector_id" AND "ConnectorDefinition"."tenant_id" = "fbeds_current_tenant_id"()));
