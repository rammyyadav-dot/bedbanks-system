-- ADR 0039: BookingStatus grows from four values to the spec's ten. Forward-only.
--
-- Old -> new mapping (no row changes meaning):
--   PENDING   -> PENDING_SUPPLIER  (renamed in place; every existing PENDING row, and the column default, follow the rename)
--   CONFIRMED -> CONFIRMED         (unchanged)
--   CANCELLED -> CANCELLED         (unchanged)
--   FAILED    -> FAILED            (unchanged)
-- Added, with no existing rows: ON_REQUEST, AMEND_REQUESTED, CANCEL_REQUESTED, CHECKED_OUT, NO_SHOW, REJECTED.
--
-- Rollback notes: PostgreSQL cannot drop an enum value. To roll back, first ensure no row uses an added value, then
-- ALTER TYPE "BookingStatus" RENAME VALUE 'PENDING_SUPPLIER' TO 'PENDING'; the six added values may stay unused.
-- No data rewrite, no index change, no policy change: tenant indexes ("Booking_tenant_id_status_idx") already cover status.

ALTER TYPE "BookingStatus" RENAME VALUE 'PENDING' TO 'PENDING_SUPPLIER';
ALTER TYPE "BookingStatus" ADD VALUE IF NOT EXISTS 'ON_REQUEST';
ALTER TYPE "BookingStatus" ADD VALUE IF NOT EXISTS 'AMEND_REQUESTED';
ALTER TYPE "BookingStatus" ADD VALUE IF NOT EXISTS 'CANCEL_REQUESTED';
ALTER TYPE "BookingStatus" ADD VALUE IF NOT EXISTS 'CHECKED_OUT';
ALTER TYPE "BookingStatus" ADD VALUE IF NOT EXISTS 'NO_SHOW';
ALTER TYPE "BookingStatus" ADD VALUE IF NOT EXISTS 'REJECTED';
