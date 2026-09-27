INSERT INTO "Permission" ("id", "key", "description") VALUES
  ('perm_supply_suppliers_read', 'supply.suppliers.read', 'Read suppliers'),
  ('perm_supply_suppliers_manage', 'supply.suppliers.manage', 'Manage suppliers')
ON CONFLICT ("key") DO UPDATE SET "description" = EXCLUDED."description";
