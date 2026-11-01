-- Existing-day capacity edits only. No INSERT or stock/provenance/freshness mutation.
-- Column-only hold reads support tenant-scoped attribution, never transactions.
-- No-op if the group role is absent; provisioning applies the same contract later.
-- Rollback: revoke these grants and provision the previous contract as an owner.
DO $$
DECLARE r record;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fbeds_api') THEN
    -- Table REVOKE does not revoke column ACLs. Clear both before converging.
    FOR r IN SELECT c.relname, a.attname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
      WHERE n.nspname='public' AND c.relname IN ('InventoryPoolDay','InventoryHold','InventoryHoldNight') AND a.attnum>0 AND NOT a.attisdropped
    LOOP
      EXECUTE format('REVOKE ALL (%I) ON %I FROM fbeds_api', r.attname, r.relname);
    END LOOP;
    EXECUTE 'REVOKE ALL ON "InventoryPoolDay" FROM fbeds_api';
    EXECUTE 'GRANT SELECT ON "InventoryPoolDay" TO fbeds_api';
    EXECUTE 'GRANT UPDATE ("capacity", "updated_at") ON "InventoryPoolDay" TO fbeds_api';
    EXECUTE 'REVOKE ALL ON "InventoryHoldNight" FROM fbeds_api';
    EXECUTE 'GRANT SELECT ("tenant_id", "hold_id", "pool_day_id", "counter_kind", "quantity") ON "InventoryHoldNight" TO fbeds_api';
    EXECUTE 'REVOKE ALL ON "InventoryHold" FROM fbeds_api';
    EXECUTE 'GRANT SELECT ("id", "tenant_id", "rate_plan_id", "status") ON "InventoryHold" TO fbeds_api';
  END IF;
END $$;
