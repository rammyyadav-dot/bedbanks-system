-- Forward-only: existing status enum, tenant data, ledger and entitlements remain intact.
ALTER TABLE "memberships" ADD COLUMN "revoked_at" TIMESTAMP(3);
CREATE TABLE "tenant_control_profiles" (
  "tenant_id" TEXT PRIMARY KEY REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "business" JSONB NOT NULL, "registration_key" TEXT NOT NULL UNIQUE, "classification" TEXT NOT NULL DEFAULT 'BUYER', "country" CHAR(2) NOT NULL,
  "stage" TEXT NOT NULL DEFAULT 'DRAFT', "compliance_status" TEXT NOT NULL DEFAULT 'PENDING',
  "compliance_approved_by" TEXT, "updated_by" TEXT NOT NULL, "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tenant_control_stage" CHECK ("stage" IN ('DRAFT','REVIEW','APPROVED')),
  CONSTRAINT "tenant_control_classification" CHECK ("classification" IN ('BUYER','SUPPLIER','HYBRID')),
  CONSTRAINT "tenant_control_compliance" CHECK ("compliance_status" IN ('PENDING','APPROVED','REJECTED')),
  CONSTRAINT "tenant_control_version" CHECK ("version" > 0)
);
CREATE INDEX "tenant_control_profiles_classification_country_idx" ON "tenant_control_profiles"("classification", "country");
CREATE INDEX "tenant_control_profiles_stage_idx" ON "tenant_control_profiles"("stage");
ALTER TABLE "tenant_control_profiles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_control_profiles" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_control_scoped" ON "tenant_control_profiles" USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());
-- Directory is platform-only, while a detail/write transaction must select exactly one tenant.
CREATE POLICY "tenant_control_directory" ON "tenant_control_profiles" FOR SELECT USING ("fbeds_platform_access_allowed"() AND "fbeds_current_tenant_id"() IS NULL);
INSERT INTO "PlatformPermission" ("id", "key", "description") VALUES
 ('platform.tenants.create','platform.tenants.create','Onboard inactive tenants'),
 ('platform.tenants.manage','platform.tenants.manage','Edit tenant business identity'),
 ('platform.tenants.memberships.manage','platform.tenants.memberships.manage','Manage tenant memberships without platform privileges'),
 ('platform.tenants.lifecycle.request','platform.tenants.lifecycle.request','Request tenant lifecycle decisions'),
 ('platform.tenants.lifecycle.approve','platform.tenants.lifecycle.approve','Decide and apply another operator lifecycle request'),
 ('platform.tenants.compliance.approve','platform.tenants.compliance.approve','Review another operator compliance submission'),
 ('platform.tenants.audit.read','platform.tenants.audit.read','Read a selected tenant audit trail')
ON CONFLICT ("key") DO NOTHING;
-- No grants to fbeds_api; provisioning of the dedicated authoring login is an owner-reviewed step.
