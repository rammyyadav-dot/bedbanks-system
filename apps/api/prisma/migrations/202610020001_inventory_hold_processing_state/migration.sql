-- Adds the PROCESSING state: a hold that a booking attempt has atomically claimed.
-- The hold-expiry sweeper only expires HELD rows, so a claimed hold can no longer be
-- released out from under an in-flight supplier prebook.
--
-- Additive and idempotent. No data is rewritten and no tenant index is affected.
-- Rollback notes: PostgreSQL cannot drop an enum value. To roll back, first resolve every
-- PROCESSING hold (release it or mark it FAILED), redeploy the previous application, and
-- leave the unused value in place; it is harmless to the previous code.
ALTER TYPE "InventoryHoldStatus" ADD VALUE IF NOT EXISTS 'PROCESSING';
