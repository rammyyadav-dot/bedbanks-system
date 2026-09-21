INSERT INTO "PlatformPermission" ("id", "key", "description") VALUES
  ('platform.tenants.read', 'platform.tenants.read', 'Read the platform tenant directory.'),
  ('platform.tenants.access', 'platform.tenants.access', 'Enter a tenant-scoped support context.'),
  ('platform.access.read', 'platform.access.read', 'Read platform roles, permissions, and assignments.'),
  ('platform.access.manage', 'platform.access.manage', 'Manage platform roles, permissions, and assignments.')
ON CONFLICT ("key") DO UPDATE SET "description" = EXCLUDED."description";
