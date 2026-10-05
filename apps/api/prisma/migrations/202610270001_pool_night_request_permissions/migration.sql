-- ADR 0036 Amendment 3: two permissions for the Admin "request new pool nights" maker-checker flow. DATA ONLY: no table, column, index, constraint,
-- policy or grant changes. Nothing is granted to any role by this migration; an administrator assigns the permissions.
--
-- Idempotent (ON CONFLICT updates only the description). Same pattern as 202610250001_pool_capacity_permissions.
-- The Permission table is a global catalogue with no tenant column, so there is no tenant-index or RLS question.
--
-- Rollback (owner only, and only if no role holds them):
--   DELETE FROM "RolePermission" WHERE "permission_id" IN (SELECT "id" FROM "Permission" WHERE "key" IN ('supply.pool_nights.request','supply.pool_nights.decide'));
--   DELETE FROM "Permission" WHERE "key" IN ('supply.pool_nights.request','supply.pool_nights.decide');
INSERT INTO "Permission" ("id", "key", "description") VALUES
  ('perm_supply_pool_nights_request', 'supply.pool_nights.request', 'Request opening new nights on a shared pool (applied by the database owner after approval)'),
  ('perm_supply_pool_nights_decide', 'supply.pool_nights.decide', 'Approve or reject a request to open new pool nights')
ON CONFLICT ("key") DO UPDATE SET "description" = EXCLUDED."description";
