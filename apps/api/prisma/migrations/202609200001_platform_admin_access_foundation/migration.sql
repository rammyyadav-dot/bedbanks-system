-- P0-E: explicit platform authorization assignments and transaction-local platform audit context.
CREATE TABLE "PlatformPermission" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "description" TEXT,
  CONSTRAINT "PlatformPermission_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PlatformPermission_key_key" ON "PlatformPermission"("key");

CREATE TABLE "PlatformRole" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlatformRole_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PlatformRole_name_key" ON "PlatformRole"("name");

CREATE TABLE "PlatformRolePermission" (
  "role_id" TEXT NOT NULL,
  "permission_id" TEXT NOT NULL,
  CONSTRAINT "PlatformRolePermission_pkey" PRIMARY KEY ("role_id", "permission_id"),
  CONSTRAINT "PlatformRolePermission_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "PlatformRole"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PlatformRolePermission_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "PlatformPermission"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "PlatformRoleAssignment" (
  "user_id" TEXT NOT NULL,
  "role_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlatformRoleAssignment_pkey" PRIMARY KEY ("user_id", "role_id"),
  CONSTRAINT "PlatformRoleAssignment_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PlatformRoleAssignment_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "PlatformRole"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "PlatformRoleAssignment_role_id_idx" ON "PlatformRoleAssignment"("role_id");

INSERT INTO "PlatformPermission" ("id", "key", "description") VALUES
  ('platform-permission-tenants-read', 'platform.tenants.read', 'Read the platform tenant directory'),
  ('platform-permission-tenants-access', 'platform.tenants.access', 'Read a selected tenant through controlled platform context')
ON CONFLICT ("key") DO NOTHING;

CREATE OR REPLACE FUNCTION "fbeds_platform_access_allowed"()
RETURNS BOOLEAN AS $$
  SELECT current_setting('app.platform_access', true) = 'true'
$$ LANGUAGE SQL STABLE;

DROP POLICY "AuditEvent_tenant_isolation" ON "AuditEvent";
CREATE POLICY "AuditEvent_tenant_isolation" ON "AuditEvent"
  USING ("tenant_id" = "fbeds_current_tenant_id"() OR ("tenant_id" IS NULL AND "fbeds_platform_access_allowed"()))
  WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"() OR ("tenant_id" IS NULL AND "fbeds_platform_access_allowed"()));
