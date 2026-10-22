-- ADR 0085: two permissions for connector administration (audit findings F4 and F9). DATA ONLY: no table, column, index, constraint, policy or grant changes.
--
-- `supply.connectors.read` shows connectors, their status and which credential purposes are configured (never a reference or a value). `supply.connectors.manage` creates connectors,
-- attaches credential references, suspends or disables them and takes part in activation approvals; activation itself is the approval-only action `connector.activate`, which is not a
-- Permission row (approval-only actions are catalogue entries gated by the permission they refine, ADR 0016). Nothing is granted to any role by this migration.
--
-- Idempotent (ON CONFLICT updates only the description). Same pattern as 202610250001_pool_capacity_permissions. The Permission table is a global catalogue with no tenant column.
--
-- Rollback (owner only, and only if no role holds them):
--   DELETE FROM "RolePermission" WHERE "permission_id" IN (SELECT "id" FROM "Permission" WHERE "key" IN ('supply.connectors.read','supply.connectors.manage'));
--   DELETE FROM "Permission" WHERE "key" IN ('supply.connectors.read','supply.connectors.manage');
INSERT INTO "Permission" ("id", "key", "description") VALUES
  ('perm_supply_connectors_read', 'supply.connectors.read', 'View connectors, their status and which credential purposes are configured (never a reference or value)'),
  ('perm_supply_connectors_manage', 'supply.connectors.manage', 'Create connectors, attach credential references, suspend or disable them, and take part in activation approvals')
ON CONFLICT ("key") DO UPDATE SET "description" = EXCLUDED."description";
