INSERT INTO "Permission" ("id", "key", "description") VALUES
  ('perm_supply_hotels_read', 'supply.hotels.read', 'Read hotels'),
  ('perm_supply_hotels_manage', 'supply.hotels.manage', 'Manage hotels'),
  ('perm_supply_rooms_read', 'supply.rooms.read', 'Read room types'),
  ('perm_supply_rooms_manage', 'supply.rooms.manage', 'Manage room types'),
  ('perm_supply_contracts_read', 'supply.contracts.read', 'Read contracts'),
  ('perm_supply_contracts_manage', 'supply.contracts.manage', 'Manage contracts'),
  ('perm_supply_rates_read', 'supply.rates.read', 'Read rates and rate plans'),
  ('perm_supply_rates_manage', 'supply.rates.manage', 'Manage rates and rate plans'),
  ('perm_supply_availability_read', 'supply.availability.read', 'Read availability'),
  ('perm_supply_availability_manage', 'supply.availability.manage', 'Manage availability')
ON CONFLICT ("key") DO UPDATE SET "description" = EXCLUDED."description";
