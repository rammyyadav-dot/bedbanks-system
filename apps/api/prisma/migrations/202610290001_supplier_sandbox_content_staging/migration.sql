-- CreateTable
CREATE TABLE "SandboxContentRun" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "supplier_id" TEXT NOT NULL,
    "connector_id" TEXT NOT NULL,
    "parameter_hash" CHAR(64) NOT NULL,
    "last_update_time" CHAR(10),
    "next_from" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "page_count" INTEGER NOT NULL DEFAULT 0,
    "last_attempt_at" TIMESTAMP(3),
    "last_success_at" TIMESTAMP(3),
    "error_classification" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SandboxContentRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SandboxContentPage" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "from" INTEGER NOT NULL,
    "next_from" INTEGER NOT NULL,
    "payload_hash" CHAR(64) NOT NULL,
    "hotels" JSONB NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SandboxContentPage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SandboxContentLease" (
    "tenant_id" TEXT NOT NULL,
    "supplier_id" TEXT NOT NULL,
    "connector_id" TEXT NOT NULL,
    "token" TEXT,
    "expires_at" TIMESTAMP(3),
    "generation" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "SandboxContentLease_pkey" PRIMARY KEY ("tenant_id","connector_id")
);

-- CreateIndex
CREATE INDEX "SandboxContentRun_tenant_id_connector_id_created_at_idx" ON "SandboxContentRun"("tenant_id", "connector_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "SandboxContentRun_tenant_id_id_key" ON "SandboxContentRun"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "SandboxContentPage_tenant_id_run_id_idx" ON "SandboxContentPage"("tenant_id", "run_id");

-- CreateIndex
CREATE UNIQUE INDEX "SandboxContentPage_run_id_from_key" ON "SandboxContentPage"("run_id", "from");

-- CreateIndex
CREATE UNIQUE INDEX "ConnectorDefinition_tenant_id_id_supplier_id_key" ON "ConnectorDefinition"("tenant_id", "id", "supplier_id");

-- AddForeignKey
ALTER TABLE "SandboxContentRun" ADD CONSTRAINT "SandboxContentRun_tenant_id_connector_id_supplier_id_fkey" FOREIGN KEY ("tenant_id", "connector_id", "supplier_id") REFERENCES "ConnectorDefinition"("tenant_id", "id", "supplier_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SandboxContentRun" ADD CONSTRAINT "SandboxContentRun_tenant_id_supplier_id_fkey" FOREIGN KEY ("tenant_id", "supplier_id") REFERENCES "Supplier"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SandboxContentPage" ADD CONSTRAINT "SandboxContentPage_tenant_id_run_id_fkey" FOREIGN KEY ("tenant_id", "run_id") REFERENCES "SandboxContentRun"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SandboxContentLease" ADD CONSTRAINT "SandboxContentLease_tenant_id_connector_id_supplier_id_fkey" FOREIGN KEY ("tenant_id", "connector_id", "supplier_id") REFERENCES "ConnectorDefinition"("tenant_id", "id", "supplier_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SandboxContentLease" ADD CONSTRAINT "SandboxContentLease_tenant_id_supplier_id_fkey" FOREIGN KEY ("tenant_id", "supplier_id") REFERENCES "Supplier"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Quarantined sandbox storage only. No runtime grants or persistent role provisioning.
ALTER TABLE "SandboxContentRun" ADD CONSTRAINT "sandbox_run_bounds" CHECK (
 "next_from" >= 1 AND "attempt_count" BETWEEN 0 AND 5 AND "page_count" >= 0
 AND "parameter_hash" ~ '^[0-9a-f]{64}$'
 AND "status" IN ('PENDING','PROCESSING','SUCCEEDED','FAILED','QUARANTINED'));
ALTER TABLE "SandboxContentPage" ADD CONSTRAINT "sandbox_page_bounds" CHECK (
 "from" >= 1 AND "next_from" > "from" AND "next_from" <= "from" + 100
 AND "payload_hash" ~ '^[0-9a-f]{64}$' AND jsonb_typeof("hotels") = 'array'
 AND jsonb_array_length("hotels") <= 100);
ALTER TABLE "SandboxContentLease" ADD CONSTRAINT "sandbox_lease_bounds" CHECK (
 "generation" >= 0 AND (("token" IS NULL) = ("expires_at" IS NULL)));
ALTER TABLE "SandboxContentRun" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SandboxContentRun" FORCE ROW LEVEL SECURITY;
CREATE POLICY "SandboxContentRun_tenant_isolation" ON "SandboxContentRun"
 USING ("tenant_id" = fbeds_current_tenant_id())
 WITH CHECK ("tenant_id" = fbeds_current_tenant_id());
ALTER TABLE "SandboxContentPage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SandboxContentPage" FORCE ROW LEVEL SECURITY;
CREATE POLICY "SandboxContentPage_tenant_isolation" ON "SandboxContentPage"
 USING ("tenant_id" = fbeds_current_tenant_id())
 WITH CHECK ("tenant_id" = fbeds_current_tenant_id());
ALTER TABLE "SandboxContentLease" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SandboxContentLease" FORCE ROW LEVEL SECURITY;
CREATE POLICY "SandboxContentLease_tenant_isolation" ON "SandboxContentLease"
 USING ("tenant_id" = fbeds_current_tenant_id())
 WITH CHECK ("tenant_id" = fbeds_current_tenant_id());
