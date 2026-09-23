INSERT INTO "PlatformPermission" ("id", "key", "description") VALUES
  ('platform_roles_read', 'platform.roles.read', 'Read platform roles and permissions.'),
  ('platform_roles_manage', 'platform.roles.manage', 'Manage platform roles and permission bundles.'),
  ('platform_assignments_read', 'platform.assignments.read', 'Read platform role assignments.'),
  ('platform_assignments_manage', 'platform.assignments.manage', 'Manage platform role assignments.')
ON CONFLICT ("key") DO UPDATE SET "description" = EXCLUDED."description";

INSERT INTO "PlatformRolePermission" ("roleId", "permissionId")
SELECT rp."roleId", p_new."id"
FROM "PlatformRolePermission" rp
JOIN "PlatformPermission" p_old ON p_old."id" = rp."permissionId"
JOIN "PlatformPermission" p_new ON p_new."key" = CASE
  WHEN p_old."key" = 'platform.access.read' THEN 'platform.roles.read'
  WHEN p_old."key" = 'platform.access.manage' THEN 'platform.roles.manage'
END
WHERE p_old."key" IN ('platform.access.read', 'platform.access.manage')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

INSERT INTO "PlatformRolePermission" ("roleId", "permissionId")
SELECT rp."roleId", p_new."id"
FROM "PlatformRolePermission" rp
JOIN "PlatformPermission" p_old ON p_old."id" = rp."permissionId"
JOIN "PlatformPermission" p_new ON p_new."key" = CASE
  WHEN p_old."key" = 'platform.access.read' THEN 'platform.assignments.read'
  WHEN p_old."key" = 'platform.access.manage' THEN 'platform.assignments.manage'
END
WHERE p_old."key" IN ('platform.access.read', 'platform.access.manage')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
