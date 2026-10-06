-- ADR 0039, Phase 1: three read-side permissions for the Admin booking module. DATA ONLY: no table, column, index, constraint, policy or grant change.
--
-- booking.view.agency  an agency-scoped user sees the bookings of their own agency only (the spec's "Tenant admin").
-- booking.view.net     net rate, markup and margin are shown (the spec's "See net rate and margin").
-- booking.pii.view     guest names are shown unmasked; every unmasked read is audited.
-- `booking.read` (existing) remains the operator-level read of every agency's bookings.
--
-- Nothing is granted to any role by this migration, and owner membership does not imply any of them: an administrator assigns them to roles.
-- Idempotent (ON CONFLICT updates only the description). The Permission table is a global catalogue with no tenant column, so there is no tenant-index or RLS question.
--
-- Rollback (owner only, and only if no role holds them):
--   DELETE FROM "RolePermission" WHERE "permission_id" IN (SELECT "id" FROM "Permission" WHERE "key" IN ('booking.view.agency','booking.view.net','booking.pii.view'));
--   DELETE FROM "Permission" WHERE "key" IN ('booking.view.agency','booking.view.net','booking.pii.view');
INSERT INTO "Permission" ("id", "key", "description") VALUES
  ('perm_booking_view_agency', 'booking.view.agency', 'View the bookings of the caller''s own agency only'),
  ('perm_booking_view_net', 'booking.view.net', 'See net rate, markup and margin on a booking'),
  ('perm_booking_pii_view', 'booking.pii.view', 'See guest names and contact details unmasked (audited)')
ON CONFLICT ("key") DO UPDATE SET "description" = EXCLUDED."description";
