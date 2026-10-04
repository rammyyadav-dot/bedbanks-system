-- P0.5 (ADR 0032): the final, explicit write set of the API runtime group role `fbeds_api`.
--
-- 202610170001 revoked the Admin authoring writes and granted the mandatory commercial-control reads. The owner then decided that the runtime
-- role holds an explicit, documented write set for the Admin workflows that are reachable and supported today (docs/strict-runtime-db-role.md).
-- This migration sets that state. It is a convergence step: for each table below it revokes everything, then grants exactly what
-- apps/api/src/database/runtime-role-contract.ts grants. A spec regenerates these statements from that module and fails on any difference,
-- and another spec proves replay, upgrade and provisioning end in the same state, so the definition cannot drift.
--
-- Granted writes (table-level unless a column list is shown):
--   Agency I,U | AgencyMember I,D | AgencyCreditLimit I,U,D | ApprovalRequest I,U | CommercialMarkupRule I,U | DistributionRestriction I,U
--   ServiceCase I,U | ServiceCaseNote I | HotelProfile I,U | HotelExternalIdentifier I,D | HotelAmenity I,U,D | HotelImage I,U,D
--   Hotel UPDATE on 11 columns only (name, property_type, country_code, city, address, latitude, longitude, time_zone, star_rating, content_status, updated_at)
-- Read-only: InventoryPool, InventoryPoolDay. Nothing at all: RoomAmenity, SupplierMutation (privileged paths).
-- Row-level security is not touched: every table here keeps forced tenant isolation, and a privilege is never a substitute for it.
--
-- A no-op when the role does not exist (a fresh replay): provisioning then applies the same contract.
-- Rollback (owner only): re-run 202610170001's grants for the affected tables, or provision again after reverting runtime-role-contract.ts.
-- No schema, index, policy or data change.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fbeds_api') THEN
    EXECUTE 'REVOKE ALL ON "Agency" FROM fbeds_api';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON "Agency" TO fbeds_api';
    EXECUTE 'REVOKE ALL ON "AgencyCreditLimit" FROM fbeds_api';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON "AgencyCreditLimit" TO fbeds_api';
    EXECUTE 'REVOKE ALL ON "AgencyMember" FROM fbeds_api';
    EXECUTE 'GRANT SELECT, INSERT, DELETE ON "AgencyMember" TO fbeds_api';
    EXECUTE 'REVOKE ALL ON "ApprovalRequest" FROM fbeds_api';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON "ApprovalRequest" TO fbeds_api';
    EXECUTE 'REVOKE ALL ON "CommercialMarkupRule" FROM fbeds_api';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON "CommercialMarkupRule" TO fbeds_api';
    EXECUTE 'REVOKE ALL ON "DistributionRestriction" FROM fbeds_api';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON "DistributionRestriction" TO fbeds_api';
    EXECUTE 'REVOKE ALL ON "Hotel" FROM fbeds_api';
    EXECUTE 'GRANT SELECT ON "Hotel" TO fbeds_api';
    EXECUTE 'GRANT UPDATE ("name", "property_type", "country_code", "city", "address", "latitude", "longitude", "time_zone", "star_rating", "content_status", "updated_at") ON "Hotel" TO fbeds_api';
    EXECUTE 'REVOKE ALL ON "HotelAmenity" FROM fbeds_api';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON "HotelAmenity" TO fbeds_api';
    EXECUTE 'REVOKE ALL ON "HotelExternalIdentifier" FROM fbeds_api';
    EXECUTE 'GRANT SELECT, INSERT, DELETE ON "HotelExternalIdentifier" TO fbeds_api';
    EXECUTE 'REVOKE ALL ON "HotelImage" FROM fbeds_api';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON "HotelImage" TO fbeds_api';
    EXECUTE 'REVOKE ALL ON "HotelProfile" FROM fbeds_api';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON "HotelProfile" TO fbeds_api';
    EXECUTE 'REVOKE ALL ON "InventoryPool" FROM fbeds_api';
    EXECUTE 'GRANT SELECT ON "InventoryPool" TO fbeds_api';
    EXECUTE 'REVOKE ALL ON "InventoryPoolDay" FROM fbeds_api';
    EXECUTE 'GRANT SELECT ON "InventoryPoolDay" TO fbeds_api';
    EXECUTE 'REVOKE ALL ON "RoomAmenity" FROM fbeds_api';
    EXECUTE 'REVOKE ALL ON "ServiceCase" FROM fbeds_api';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON "ServiceCase" TO fbeds_api';
    EXECUTE 'REVOKE ALL ON "ServiceCaseNote" FROM fbeds_api';
    EXECUTE 'GRANT SELECT, INSERT ON "ServiceCaseNote" TO fbeds_api';
    EXECUTE 'REVOKE ALL ON "SupplierMutation" FROM fbeds_api';
  END IF;
END $$;
