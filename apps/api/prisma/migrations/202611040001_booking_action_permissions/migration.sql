-- ADR 0039, Phase 2: ten action permissions for the booking lifecycle. DATA ONLY: no table, column, index, constraint, policy or grant change.
--
-- booking.on-request.resolve   confirm or reject an on-request booking
-- booking.confirm.manual       record a supplier answer on a pending-supplier booking (replaces the forbidden key booking.confirm)
-- booking.supplier-ref.edit    add or correct supplier / hotel / agent references
-- booking.amend                request, approve or reject an amendment (operator)
-- booking.amend.request        request an amendment (agency user, own agency only)
-- booking.cancel.request       request a cancellation (agency user, own agency only)
-- booking.cancel.nonrefundable cancel a non-refundable (or refundability-unknown) booking
-- booking.rebook               close a failed booking as failed
-- booking.no-show.mark         mark a checked-out booking no-show within 7 days of check-in
-- booking.manual.create        enter a booking manually (also needs ADMIN_MANUAL_BOOKING_ENABLED)
-- (booking.cancel already exists.) Nothing is granted to any role; owner membership implies none of them.
-- Idempotent. The Permission table is a global catalogue with no tenant column, so there is no tenant-index or RLS question.
--
-- Rollback (owner only, and only if no role holds them):
--   DELETE FROM "RolePermission" WHERE "permission_id" IN (SELECT "id" FROM "Permission" WHERE "key" IN (<the ten keys>));
--   DELETE FROM "Permission" WHERE "key" IN (<the ten keys>);
INSERT INTO "Permission" ("id", "key", "description") VALUES
  ('perm_booking_on_request_resolve', 'booking.on-request.resolve', 'Confirm or reject an on-request booking'),
  ('perm_booking_confirm_manual', 'booking.confirm.manual', 'Record a supplier answer on a pending-supplier booking'),
  ('perm_booking_supplier_ref_edit', 'booking.supplier-ref.edit', 'Add or correct supplier, hotel and agent references'),
  ('perm_booking_amend', 'booking.amend', 'Request, approve or reject a booking amendment'),
  ('perm_booking_amend_request', 'booking.amend.request', 'Request an amendment as an agency user'),
  ('perm_booking_cancel_request', 'booking.cancel.request', 'Request a cancellation as an agency user'),
  ('perm_booking_cancel_nonrefundable', 'booking.cancel.nonrefundable', 'Cancel a non-refundable booking'),
  ('perm_booking_rebook', 'booking.rebook', 'Close a failed booking as failed'),
  ('perm_booking_no_show_mark', 'booking.no-show.mark', 'Mark a no-show'),
  ('perm_booking_manual_create', 'booking.manual.create', 'Enter a booking manually')
ON CONFLICT ("key") DO UPDATE SET "description" = EXCLUDED."description";
