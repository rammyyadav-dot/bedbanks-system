-- Tenant-scoped Admin settings (1:1 with tenants).
-- Default currency and low-balance threshold are alert/display preferences only.
-- They do not convert wallets, rewrite ledger rows, or invent FX.
--
-- Rollback:
--   DROP POLICY IF EXISTS "tenant_settings_tenant_isolation" ON "tenant_settings";
--   DROP TABLE IF EXISTS "tenant_settings";
--   DELETE FROM "Permission" WHERE "key" = 'settings.manage';
-- Do not drop tenants. Existing Tenant.name values are unchanged by rollback of this table.

CREATE TABLE "tenant_settings" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "support_email" TEXT,
  "default_language" TEXT NOT NULL DEFAULT 'en',
  "time_zone" TEXT NOT NULL DEFAULT 'UTC',
  "default_currency" CHAR(3) NOT NULL DEFAULT 'USD',
  "low_balance_threshold_minor" BIGINT NOT NULL DEFAULT 0,
  "low_balance_currency" CHAR(3) NOT NULL DEFAULT 'USD',
  "last_idempotency_key" TEXT,
  "last_mutation_fingerprint" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tenant_settings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tenant_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "tenant_settings_tenant_id_key" ON "tenant_settings"("tenant_id");

ALTER TABLE "tenant_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_settings_tenant_isolation" ON "tenant_settings"
  USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());

INSERT INTO "Permission" ("id", "key", "description") VALUES
  ('perm_settings_manage', 'settings.manage', 'Read and update authenticated tenant workspace settings')
ON CONFLICT ("key") DO UPDATE SET "description" = EXCLUDED."description";
