-- Adds the terminal CONFIRMED state for a hold whose inventory was converted to sold by a confirmed booking.
-- Additive and idempotent; no rows are rewritten and no tenant index changes.
-- Rollback notes: PostgreSQL cannot drop an enum value. Before redeploying older code, confirm no hold is
-- CONFIRMED that the older code would mishandle (older code treats unknown states as inactive), and leave the
-- unused value in place.
ALTER TYPE "InventoryHoldStatus" ADD VALUE IF NOT EXISTS 'CONFIRMED';
