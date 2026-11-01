-- Tenant integrity for the tables the strict runtime role writes (ADR 0032 amendment, evidence review of the Hotel Setup work).
--
-- Finding: row-level security checks only a row's own tenant_id, and a foreign key is validated with the owner's privileges, so as the
-- runtime role in tenant A an INSERT into "RoomAmenity" or "HotelAmenity" naming tenant B's room or hotel was accepted (tenant_id = A, hotel_id = B's).
-- The application always validates ownership first, but the database must refuse it too (defence in depth; same pattern as InventoryPool_tenant_guard, ADR 0030).
--
-- 1. One generic guard, "fbeds_enforce_tenant_references"(): for each (column, parent table) pair passed as trigger arguments, a non-null reference must name a parent
--    row of the SAME tenant. It runs as the invoker, so under row-level security a parent that is not visible in the transaction's tenant is also refused.
-- 2. Installed BEFORE INSERT OR UPDATE OF the tenant and reference columns on the hotel setup tables and the other tenant tables the runtime role writes:
--    HotelProfile, HotelExternalIdentifier, HotelAmenity, RoomAmenity (its room follows from the composite hotel/room foreign key), HotelImage,
--    CommercialMarkupRule, DistributionRestriction, AgencyMember, AgencyCreditLimit, ServiceCase, ServiceCaseNote.
--    ServiceCase.booking_id is not guarded here: the runtime role has no grant on Booking by design.
-- 3. Amenity rows become immutable in their ownership: UPDATE on HotelAmenity and RoomAmenity narrows to fee_type, updated_by_id, updated_at (the contract in
--    apps/api/src/database/runtime-role-contract.ts; a spec regenerates the statements below from it).
--
-- No table, column or data change; existing rows are not re-checked. Tenant-index review: each check is a primary-key lookup on the parent.
-- Rollback (later forward migration): DROP TRIGGER "<Table>_tenant_references" ON "<Table>" for each table below; DROP FUNCTION "fbeds_enforce_tenant_references"();
-- and re-grant UPDATE on the two amenity tables from 202610190001's contract state if the owner wants it back.

CREATE OR REPLACE FUNCTION "fbeds_enforce_tenant_references"() RETURNS trigger AS $$
DECLARE
  i integer := 0;
  reference text;
  parent_ok boolean;
BEGIN
  WHILE i < TG_NARGS LOOP
    EXECUTE format('SELECT ($1).%I::text', TG_ARGV[i]) INTO reference USING NEW;
    IF reference IS NOT NULL THEN
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I p WHERE p."id" = $1 AND p."tenant_id" = $2)', TG_ARGV[i + 1]) INTO parent_ok USING reference, NEW."tenant_id";
      IF NOT parent_ok THEN
        RAISE EXCEPTION '% % belongs to another tenant or does not exist', TG_TABLE_NAME, TG_ARGV[i] USING ERRCODE = '23514';
      END IF;
    END IF;
    i := i + 2;
  END LOOP;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER "HotelProfile_tenant_references" BEFORE INSERT OR UPDATE OF "tenant_id", "hotel_id" ON "HotelProfile"
  FOR EACH ROW EXECUTE FUNCTION "fbeds_enforce_tenant_references"('hotel_id', 'Hotel');

CREATE TRIGGER "HotelExternalIdentifier_tenant_references" BEFORE INSERT OR UPDATE OF "tenant_id", "hotel_id" ON "HotelExternalIdentifier"
  FOR EACH ROW EXECUTE FUNCTION "fbeds_enforce_tenant_references"('hotel_id', 'Hotel');

CREATE TRIGGER "HotelAmenity_tenant_references" BEFORE INSERT OR UPDATE OF "tenant_id", "hotel_id" ON "HotelAmenity"
  FOR EACH ROW EXECUTE FUNCTION "fbeds_enforce_tenant_references"('hotel_id', 'Hotel');

CREATE TRIGGER "RoomAmenity_tenant_references" BEFORE INSERT OR UPDATE OF "tenant_id", "hotel_id" ON "RoomAmenity"
  FOR EACH ROW EXECUTE FUNCTION "fbeds_enforce_tenant_references"('hotel_id', 'Hotel');

CREATE TRIGGER "HotelImage_tenant_references" BEFORE INSERT OR UPDATE OF "tenant_id", "hotel_id" ON "HotelImage"
  FOR EACH ROW EXECUTE FUNCTION "fbeds_enforce_tenant_references"('hotel_id', 'Hotel');

CREATE TRIGGER "CommercialMarkupRule_tenant_references" BEFORE INSERT OR UPDATE OF "tenant_id", "hotel_id", "supplier_id" ON "CommercialMarkupRule"
  FOR EACH ROW EXECUTE FUNCTION "fbeds_enforce_tenant_references"('hotel_id', 'Hotel', 'supplier_id', 'Supplier');

CREATE TRIGGER "DistributionRestriction_tenant_references" BEFORE INSERT OR UPDATE OF "tenant_id", "agency_id", "hotel_id", "supplier_id" ON "DistributionRestriction"
  FOR EACH ROW EXECUTE FUNCTION "fbeds_enforce_tenant_references"('agency_id', 'Agency', 'hotel_id', 'Hotel', 'supplier_id', 'Supplier');

CREATE TRIGGER "AgencyMember_tenant_references" BEFORE INSERT OR UPDATE OF "tenant_id", "agency_id" ON "AgencyMember"
  FOR EACH ROW EXECUTE FUNCTION "fbeds_enforce_tenant_references"('agency_id', 'Agency');

CREATE TRIGGER "AgencyCreditLimit_tenant_references" BEFORE INSERT OR UPDATE OF "tenant_id", "agency_id" ON "AgencyCreditLimit"
  FOR EACH ROW EXECUTE FUNCTION "fbeds_enforce_tenant_references"('agency_id', 'Agency');

CREATE TRIGGER "ServiceCase_tenant_references" BEFORE INSERT OR UPDATE OF "tenant_id", "agency_id", "hotel_id", "supplier_id" ON "ServiceCase"
  FOR EACH ROW EXECUTE FUNCTION "fbeds_enforce_tenant_references"('agency_id', 'Agency', 'hotel_id', 'Hotel', 'supplier_id', 'Supplier');

CREATE TRIGGER "ServiceCaseNote_tenant_references" BEFORE INSERT OR UPDATE OF "tenant_id", "case_id" ON "ServiceCaseNote"
  FOR EACH ROW EXECUTE FUNCTION "fbeds_enforce_tenant_references"('case_id', 'ServiceCase');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fbeds_api') THEN
    EXECUTE 'REVOKE ALL ON "HotelAmenity" FROM fbeds_api';
    EXECUTE 'GRANT SELECT, INSERT, DELETE ON "HotelAmenity" TO fbeds_api';
    EXECUTE 'GRANT UPDATE ("fee_type", "updated_by_id", "updated_at") ON "HotelAmenity" TO fbeds_api';
    EXECUTE 'REVOKE ALL ON "RoomAmenity" FROM fbeds_api';
    EXECUTE 'GRANT SELECT, INSERT, DELETE ON "RoomAmenity" TO fbeds_api';
    EXECUTE 'GRANT UPDATE ("fee_type", "updated_by_id", "updated_at") ON "RoomAmenity" TO fbeds_api';
  END IF;
END $$;
