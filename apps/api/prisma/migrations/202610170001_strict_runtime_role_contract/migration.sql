-- P0.5 (ADR 0031): align the API runtime group role `fbeds_api` with the strict runtime-role contract (ADR 0008, 0013).
--
-- Earlier migrations carry conditional GRANTs to fbeds_api that include writes on Admin authoring tables. Whether they took effect depended on
-- whether the role existed when each migration ran, so two databases at the same migration could hold different privileges, and
-- provisioning (REVOKE ALL, then the contract grants) silently reverted them. This forward migration makes the migration-time state equal
-- the provisioned state in either order:
--   * REVOKE every privilege on the Admin authoring tables and SupplierMutation from fbeds_api;
--   * GRANT SELECT back on the tables the runtime contract needs: the mandatory commercial controls (Agency, AgencyMember,
--     DistributionRestriction, CommercialMarkupRule) read by Agent search, recheck and the suspension guard, and the inventory pools.
-- Nothing is widened: every table here ends with fewer or equal privileges than before, except the four commercial-control tables which
-- gain SELECT only if the role already existed. If the role does not exist (a fresh replay), the migration does nothing and provisioning applies the same contract.
--
-- Who writes these tables is an open owner decision (docs/adr/0031). Until it is decided the API runtime role does not write them.
--
-- Rollback (owner only, per table, only if the owner decides fbeds_api is the Admin writer):
--   GRANT SELECT, INSERT, UPDATE ON "<table>" TO fbeds_api;   -- plus DELETE where the earlier migration granted it
-- The earlier grants are in migrations 202610060001 .. 202610160001. Tenant isolation is unchanged: RLS policies are not touched.
-- No schema change, no index change, no data change.
DO $$
DECLARE
  authoring_table text;
  read_table text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fbeds_api') THEN
    FOREACH authoring_table IN ARRAY ARRAY[
      'Agency', 'AgencyCreditLimit', 'AgencyMember', 'ApprovalRequest', 'CommercialMarkupRule', 'DistributionRestriction',
      'HotelAmenity', 'HotelExternalIdentifier', 'HotelImage', 'HotelProfile', 'InventoryPool', 'InventoryPoolDay',
      'RoomAmenity', 'ServiceCase', 'ServiceCaseNote', 'SupplierMutation'
    ] LOOP
      EXECUTE format('REVOKE ALL ON %I FROM fbeds_api', authoring_table);
    END LOOP;
    FOREACH read_table IN ARRAY ARRAY['Agency', 'AgencyMember', 'DistributionRestriction', 'CommercialMarkupRule', 'InventoryPool', 'InventoryPoolDay'] LOOP
      EXECUTE format('GRANT SELECT ON %I TO fbeds_api', read_table);
    END LOOP;
  END IF;
END $$;
