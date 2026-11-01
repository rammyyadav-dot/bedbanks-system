-- ADR 0036: two permissions for the Admin pool capacity editor. DATA ONLY: no table, column, index, constraint, policy or grant changes.
--
-- Viewing a pool and its consumption keeps `supply.availability.read`. Previewing a capacity edit and applying one are separate grants, so a
-- role can be allowed to see what an edit would do without being allowed to write it. Nothing is granted to any role by this migration: an
-- administrator assigns the permissions to roles.
--
-- Idempotent (ON CONFLICT updates only the description). Same pattern as 202609220001_supply_permissions and 202610100001.
-- The Permission table is a global catalogue with no tenant column, so there is no tenant-index or RLS question.
--
-- Rollback (owner only, and only if no role holds them):
--   DELETE FROM "RolePermission" WHERE "permission_id" IN (SELECT "id" FROM "Permission" WHERE "key" IN ('supply.pool_capacity.preview','supply.pool_capacity.apply'));
--   DELETE FROM "Permission" WHERE "key" IN ('supply.pool_capacity.preview','supply.pool_capacity.apply');
INSERT INTO "Permission" ("id", "key", "description") VALUES
  ('perm_supply_pool_capacity_preview', 'supply.pool_capacity.preview', 'Preview a shared pool capacity change (no write)'),
  ('perm_supply_pool_capacity_apply', 'supply.pool_capacity.apply', 'Apply a shared pool capacity change')
ON CONFLICT ("key") DO UPDATE SET "description" = EXCLUDED."description";
