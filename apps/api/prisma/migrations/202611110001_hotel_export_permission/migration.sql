-- ADR 0051: permission to download the hotel directory as CSV. Data only: one Permission row, granted to no role.
-- Tenant administrators grant it through the normal role assignment flow; nothing is exported until they do.
--
-- Rollback (forward migration; reviewed before use):
--   DELETE FROM "RolePermission" WHERE "permission_id" IN (SELECT "id" FROM "Permission" WHERE "key" = 'supply.hotels.export');
--   DELETE FROM "Permission" WHERE "key" = 'supply.hotels.export';
INSERT INTO "Permission" ("id", "key", "description") VALUES
  ('perm_supply_hotels_export', 'supply.hotels.export', 'Download the hotel directory as CSV')
ON CONFLICT ("key") DO UPDATE SET "description" = EXCLUDED."description";
