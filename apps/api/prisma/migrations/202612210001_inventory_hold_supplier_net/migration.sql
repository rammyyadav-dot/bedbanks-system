-- Portal booking creation freezes the supplier net that recheck already priced (ADR 0061).
-- The column is nullable: holds created before this change, and holds that were not repriced, stay null.
-- No backfill. A net is never invented from a later rate read. Integer minor units in the hold's sell currency.
-- The booking transaction role already has table-level INSERT and SELECT on InventoryHold, so the new column
-- is written at hold creation and is not in the column-level UPDATE list (it cannot be rewritten).
-- The API runtime role's column SELECT does not include it.
--
-- Rollback (forward migration, only while no new hold relies on the column):
--   ALTER TABLE "InventoryHold" DROP CONSTRAINT "InventoryHold_net_amount_minor_within_sell";
--   ALTER TABLE "InventoryHold" DROP COLUMN "net_amount_minor";

ALTER TABLE "InventoryHold" ADD COLUMN "net_amount_minor" BIGINT;

ALTER TABLE "InventoryHold"
  ADD CONSTRAINT "InventoryHold_net_amount_minor_within_sell"
  CHECK ("net_amount_minor" IS NULL OR ("net_amount_minor" >= 1 AND "net_amount_minor" <= "sell_amount_minor"));
