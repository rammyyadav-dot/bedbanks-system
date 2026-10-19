-- ADR 0067 (F-11): client and market markup tiers with exclusion lists.
--
-- A markup rule may name one agency (client tier) and/or one buyer market (the agency's ISO-3166 alpha-2 country). Such a rule applies only to that
-- buyer and outranks a generic rule; a rule with neither is generic, as every existing rule is. `excluded_hotel_ids` and `excluded_supplier_ids`
-- carve hotels or suppliers out of a broad rule (for example a market rule for every hotel except two), so the next rule in precedence applies there.
--
-- Isolation: CommercialMarkupRule keeps its forced RLS. The agency foreign key is restrict, so an agency with rules cannot be deleted silently.
-- Tenant-index review: rules are loaded per tenant and status (existing index); the new columns are read with the row.
--
-- One ACTIVE rule per target still holds, where the target now includes the client and market tiers: the unique index is rebuilt over them.
--
-- Rollback (forward migration; reviewed before use; retire tiered ACTIVE rules first, or the old index cannot be rebuilt):
--   DROP INDEX "CommercialMarkupRule_one_active_per_target";
--   CREATE UNIQUE INDEX "CommercialMarkupRule_one_active_per_target" ON "CommercialMarkupRule"("tenant_id", "scope", COALESCE("supplier_id", ''), COALESCE("hotel_id", '')) WHERE "status" = 'ACTIVE';
--   ALTER TABLE "CommercialMarkupRule" DROP CONSTRAINT "CommercialMarkupRule_agency_id_fkey", DROP CONSTRAINT "CommercialMarkupRule_market_check",
--     DROP COLUMN "agency_id", DROP COLUMN "market", DROP COLUMN "excluded_hotel_ids", DROP COLUMN "excluded_supplier_ids";

ALTER TABLE "CommercialMarkupRule"
  ADD COLUMN "agency_id" TEXT,
  ADD COLUMN "market" CHAR(2),
  ADD COLUMN "excluded_hotel_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "excluded_supplier_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD CONSTRAINT "CommercialMarkupRule_agency_id_fkey" FOREIGN KEY ("agency_id") REFERENCES "Agency"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "CommercialMarkupRule_market_check" CHECK ("market" IS NULL OR "market" ~ '^[A-Z]{2}$');

DROP INDEX "CommercialMarkupRule_one_active_per_target";
CREATE UNIQUE INDEX "CommercialMarkupRule_one_active_per_target" ON "CommercialMarkupRule"("tenant_id", "scope", COALESCE("supplier_id", ''), COALESCE("hotel_id", ''), COALESCE("agency_id", ''), COALESCE("market", '')) WHERE "status" = 'ACTIVE';
