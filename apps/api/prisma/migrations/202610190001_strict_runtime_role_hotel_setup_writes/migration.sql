-- P0.5 hotel setup journey (ADR 0032 amendment): the Admin hotel setup journey (create hotel, set up the profile, add rooms and room amenities, ...)
-- must be completable on the strict API runtime role, so the three tables its remaining steps write join the explicit write set.
--
--   Hotel       SELECT, INSERT, and UPDATE on 11 profile columns (INSERT added; DELETE and every other column stay privileged)
--   RoomType    SELECT, INSERT, UPDATE on 8 columns (name, code, max_adults, max_children, max_occupancy, bedding_metadata, is_active, updated_at)
--   RoomAmenity SELECT, INSERT, UPDATE, DELETE
--
-- Same convergence rule as 202610180001: revoke everything on each table, then grant exactly what
-- apps/api/src/database/runtime-role-contract.ts grants; a spec regenerates these statements from that module and fails on any difference.
-- Row-level security is untouched (Hotel and RoomAmenity by tenant_id, RoomType through its hotel's tenant). No-op when the role does not exist.
-- Rollback (owner only): re-run the Hotel statements of 202610180001 and REVOKE ALL on RoomType and RoomAmenity, then GRANT SELECT on RoomType.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fbeds_api') THEN
    EXECUTE 'REVOKE ALL ON "Hotel" FROM fbeds_api';
    EXECUTE 'GRANT SELECT, INSERT ON "Hotel" TO fbeds_api';
    EXECUTE 'GRANT UPDATE ("name", "property_type", "country_code", "city", "address", "latitude", "longitude", "time_zone", "star_rating", "content_status", "updated_at") ON "Hotel" TO fbeds_api';
    EXECUTE 'REVOKE ALL ON "RoomType" FROM fbeds_api';
    EXECUTE 'GRANT SELECT, INSERT ON "RoomType" TO fbeds_api';
    EXECUTE 'GRANT UPDATE ("name", "code", "max_adults", "max_children", "max_occupancy", "bedding_metadata", "is_active", "updated_at") ON "RoomType" TO fbeds_api';
    EXECUTE 'REVOKE ALL ON "RoomAmenity" FROM fbeds_api';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON "RoomAmenity" TO fbeds_api';
  END IF;
END $$;
