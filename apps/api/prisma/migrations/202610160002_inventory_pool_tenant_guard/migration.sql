-- Inventory pool tenant guard (ADR 0030). InventoryPool references Hotel and Supplier by id only, so the foreign keys alone would
-- accept another tenant's hotel or supplier. This trigger makes the database refuse it, in addition to the service check.
--
-- No table, column or data change. Tenant-index review: nothing new is queried. Rollback is a later forward migration:
--   DROP TRIGGER "InventoryPool_tenant_guard" ON "InventoryPool"; DROP FUNCTION "fbeds_inventory_pool_tenant_guard"();

CREATE OR REPLACE FUNCTION "fbeds_inventory_pool_tenant_guard"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Hotel" WHERE "id" = NEW."hotel_id" AND "tenant_id" = NEW."tenant_id") THEN
    RAISE EXCEPTION 'inventory pool hotel belongs to another tenant' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "Supplier" WHERE "id" = NEW."supplier_id" AND "tenant_id" = NEW."tenant_id") THEN
    RAISE EXCEPTION 'inventory pool supplier belongs to another tenant' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER "InventoryPool_tenant_guard" BEFORE INSERT OR UPDATE OF "tenant_id", "hotel_id", "supplier_id" ON "InventoryPool"
  FOR EACH ROW EXECUTE FUNCTION "fbeds_inventory_pool_tenant_guard"();
