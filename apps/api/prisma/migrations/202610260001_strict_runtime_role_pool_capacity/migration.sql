-- ADR 0036 amendment: the Admin pool capacity editor and the per-plan consumption report must work on the strict API runtime role.
-- The smallest privilege set that makes them work, and nothing nearby:
--
--   InventoryPoolDay    SELECT (unchanged) plus UPDATE on 6 columns only: capacity, source, source_updated_at, received_at, fresh_until, updated_at
--                       (the edit and the ADMIN provenance stamp). NOT sold, held, tenant_id, pool_id, stay_date, id or created_at; no INSERT, no DELETE.
--   InventoryHold       SELECT on 4 columns only: id, tenant_id, rate_plan_id, status (which plan holds what, and its lifecycle status). No table-level SELECT, no write.
--   InventoryHoldNight  SELECT on 5 columns only: tenant_id, hold_id, pool_day_id, counter_kind, quantity (the recorded counter reference and units). No table-level SELECT, no write.
--
-- Same convergence rule as 202610180001: revoke everything on each table, then grant exactly what apps/api/src/database/runtime-role-contract.ts
-- grants; a spec regenerates these statements from that module and fails on any difference. Row-level security is untouched: all three tables keep the
-- forced tenant_isolation policy on tenant_id (granted readable above, because a policy expression is evaluated with the caller's privileges).
-- The guest, money, offer, search, idempotency and user columns of InventoryHold stay unreadable, so the credit view (which sums sell_amount_minor)
-- still reports "committed holds unavailable" on this role, exactly as before. No-op when the role does not exist (a fresh replay), and
-- idempotent when it does.
--
-- Rollback (owner only): REVOKE ALL ON "InventoryHold", "InventoryHoldNight" FROM fbeds_api; then
--   REVOKE ALL ON "InventoryPoolDay" FROM fbeds_api; GRANT SELECT ON "InventoryPoolDay" TO fbeds_api;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fbeds_api') THEN
    EXECUTE 'REVOKE ALL ON "InventoryPoolDay" FROM fbeds_api';
    EXECUTE 'GRANT SELECT ON "InventoryPoolDay" TO fbeds_api';
    EXECUTE 'GRANT UPDATE ("capacity", "source", "source_updated_at", "received_at", "fresh_until", "updated_at") ON "InventoryPoolDay" TO fbeds_api';
    EXECUTE 'REVOKE ALL ON "InventoryHold" FROM fbeds_api';
    EXECUTE 'GRANT SELECT ("id", "tenant_id", "rate_plan_id", "status") ON "InventoryHold" TO fbeds_api';
    EXECUTE 'REVOKE ALL ON "InventoryHoldNight" FROM fbeds_api';
    EXECUTE 'GRANT SELECT ("tenant_id", "hold_id", "pool_day_id", "counter_kind", "quantity") ON "InventoryHoldNight" TO fbeds_api';
  END IF;
END $$;
