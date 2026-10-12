-- Permission for the supplier extranet bookings routes (ADR 0061 Amendment 1). Granted to no role by this migration.
--
-- No database privilege is granted here. Per the strict runtime-role rule (provisioning is the only source of runtime grants; see SR-07), the
-- column-only SELECT on "Booking", "BookingRoom" and "BookingGuest" comes from runtime-role-contract.ts and is applied by the owner with
-- `ops:provision-api-runtime-role` (idempotent: REVOKE ALL, then exactly the contract). Until that runs, the bookings routes fail closed with a
-- database "permission denied" and return nothing.
--
-- Rollback: remove role assignments of the permission, then DELETE FROM "Permission" WHERE "key" = 'supplier.extranet.bookings.read'.
INSERT INTO "Permission" ("id", "key", "description") VALUES
  ('perm_supplier_extranet_bookings_read', 'supplier.extranet.bookings.read', 'Read bookings owned by the authenticated supplier organization (reference, stay, room-level net)')
ON CONFLICT ("key") DO UPDATE SET "description" = EXCLUDED."description";
