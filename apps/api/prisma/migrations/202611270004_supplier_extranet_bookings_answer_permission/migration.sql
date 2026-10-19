-- Permission for the supplier booking-answer route (ADR 0061 Amendment 2). Granted to no role by this migration.
--
-- No database privilege is granted here. The write runs on the booking-module role (BOOKING_OPS_DATABASE_URL) through transitionBooking, whose
-- grants already exist; the API runtime role gains no write on any booking table.
--
-- Rollback: remove role assignments of the permission, then DELETE FROM "Permission" WHERE "key" = 'supplier.extranet.bookings.answer'.
INSERT INTO "Permission" ("id", "key", "description") VALUES
  ('perm_supplier_extranet_bookings_answer', 'supplier.extranet.bookings.answer', 'Confirm, put on request, or reject a booking owned by the authenticated supplier organization')
ON CONFLICT ("key") DO UPDATE SET "description" = EXCLUDED."description";
