-- ADR 0039, Phase 6D: booking export. Data only: two permissions, granted to no role. Forward-only; no table, column, index or policy changes.
--
-- Rollback notes: nothing in the schema changes, so an application rollback needs no database step. To remove the permissions after the endpoint is gone:
--   DELETE FROM "RolePermission" WHERE "permission_id" IN (SELECT "id" FROM "Permission" WHERE "key" IN ('booking.export', 'booking.export.agency'));
--   DELETE FROM "Permission" WHERE "key" IN ('booking.export', 'booking.export.agency');
-- Tenant-index review: not applicable (no table is touched).

INSERT INTO "Permission" ("id", "key", "description") VALUES
  ('perm_booking_export', 'booking.export', 'Export the filtered booking list as a CSV file (audited; at most 1,000 rows)'),
  ('perm_booking_export_agency', 'booking.export.agency', 'Export the caller''s own agency bookings as a CSV file (audited; at most 1,000 rows)')
ON CONFLICT ("key") DO UPDATE SET "description" = EXCLUDED."description";
