-- Forward-only correction: the strict role contract already classifies
-- RolePermission as forced-tenant, but no prior migration enabled its RLS.
-- No grants or tenant columns are added. The owning Role supplies the tenant.
-- The caller already has SELECT on Role; its own forced RLS also applies.
-- Rollback (owner-controlled only): DROP POLICY "RolePermission_tenant_isolation"
-- ON "RolePermission"; ALTER TABLE "RolePermission" NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE "RolePermission" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "RolePermission" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "RolePermission" FORCE ROW LEVEL SECURITY;
CREATE POLICY "RolePermission_tenant_isolation" ON "RolePermission"
  USING (EXISTS (
    SELECT 1 FROM "Role"
    WHERE "Role"."id" = "RolePermission"."role_id"
      AND "Role"."tenant_id" = "fbeds_current_tenant_id"()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM "Role"
    WHERE "Role"."id" = "RolePermission"."role_id"
      AND "Role"."tenant_id" = "fbeds_current_tenant_id"()
  ));
