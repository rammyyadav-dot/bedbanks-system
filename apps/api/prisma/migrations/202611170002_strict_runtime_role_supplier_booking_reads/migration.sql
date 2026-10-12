-- Supplier extranet bookings (ADR 0061 Amendment 1): column-only READS of the booking tables for the API runtime role.
-- No write of any kind. Sell price, markup, FX rate, agency, agent, channel, payment, the raw search snapshot, rate keys, child ages,
-- and every guest contact column stay unreadable by the role, so a query bug cannot leak them. Every query on these tables must name its columns.
-- Booking rows remain behind forced tenant row-level security; supplier scoping is an additional application filter on supplier_id.
-- No-op if the group role is absent; provisioning applies the same contract later.
-- Rollback: revoke these grants (REVOKE ALL on the three tables and their columns FROM fbeds_api) or provision the previous contract as an owner.
DO $$
DECLARE r record;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fbeds_api') THEN
    -- Table REVOKE does not revoke column ACLs. Clear both before converging.
    FOR r IN SELECT c.relname, a.attname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
      WHERE n.nspname='public' AND c.relname IN ('Booking','BookingRoom','BookingGuest') AND a.attnum>0 AND NOT a.attisdropped
    LOOP
      EXECUTE format('REVOKE ALL (%I) ON %I FROM fbeds_api', r.attname, r.relname);
    END LOOP;
    EXECUTE 'REVOKE ALL ON "Booking" FROM fbeds_api';
    EXECUTE 'GRANT SELECT ("id", "tenant_id", "reference", "supplier_id", "hotel_id", "status", "currency", "net_minor", "check_in", "check_out", "nights", "supplier_ref", "hotel_confirmation_no", "created_at", "updated_at") ON "Booking" TO fbeds_api';
    EXECUTE 'REVOKE ALL ON "BookingRoom" FROM fbeds_api';
    EXECUTE 'GRANT SELECT ("id", "tenant_id", "booking_id", "position", "quantity", "room_name", "board_code", "adults", "children", "net_minor") ON "BookingRoom" TO fbeds_api';
    EXECUTE 'REVOKE ALL ON "BookingGuest" FROM fbeds_api';
    EXECUTE 'GRANT SELECT ("id", "tenant_id", "booking_id", "first_name", "last_name", "is_lead") ON "BookingGuest" TO fbeds_api';
  END IF;
END $$;

-- Permission for the extranet bookings routes. Granted to no role by this migration.
INSERT INTO "Permission" ("id", "key", "description") VALUES
  ('perm_supplier_extranet_bookings_read', 'supplier.extranet.bookings.read', 'Read bookings owned by the authenticated supplier organization (reference, stay, room-level net)')
ON CONFLICT ("key") DO UPDATE SET "description" = EXCLUDED."description";
-- Rollback of the permission: remove role assignments of it, then DELETE FROM "Permission" WHERE "key" = 'supplier.extranet.bookings.read'.
