-- ADR 0080 phase 2: cascading markup layers, fixed amounts, attribute targets, FX volatility margin and quote time, hotel chain code.
--
-- Expand-only and behaviour-preserving. Every new column is nullable or defaulted so each existing row keeps its meaning: a percent rule on the
-- layer it already occupied (rows naming an agency or market are backfilled to CLIENT, as `legacyCascadeLayers` maps them; all others stay
-- SUPPLIER_CONTRACT). Nothing in the API reads the new columns yet; the evaluator is unchanged until a later, flagged change adopts them.
-- Agency tier is NOT in this migration: no agency-tier table exists, and a bare column without a foreign key would be unverifiable. It follows
-- the tier model decision.
--
-- Fixed and set-sell amounts are integer minor units plus an ISO-4217 currency (never a float). SET_SELL is allowed only on GLOBAL_OVERRIDE.
-- Attribute targets (country, city, star rating, chain) narrow a rule that is not already pinned to one hotel.
--
-- FX: `volatility_bp` is added to `buffer_bp` against the buyer (total at most 2500 bp). `as_of` is when the mid rate was quoted. Legacy rows have
-- NULL `as_of`; the loader must treat NULL as EXPIRED (fail closed), never as fresh. Corridor ages (4h / 1h / 12h hard) live in code, not here.
--
-- Hotel.chain_code: canonical chain identifier, nullable; source hierarchy is in ADR 0080. Hotel keeps its forced RLS.
--
-- Isolation: CommercialMarkupRule, FxRate and Hotel keep their forced RLS and tenant policies; no new table, so no new GRANT. The runtime roles
-- already have their column-agnostic table privileges. Tenant-index review: rule resolution stays tenant_id-first via the existing
-- (tenant_id, status) index plus the new (tenant_id, layer, status); the rebuilt unique index is tenant_id-first. The chain index is tenant_id-first.
--
-- Rollback (forward migration; retire ACTIVE rows that use the new dimensions first, or the old unique index cannot be rebuilt):
--   DROP INDEX "CommercialMarkupRule_one_active_per_target";
--   CREATE UNIQUE INDEX "CommercialMarkupRule_one_active_per_target" ON "CommercialMarkupRule"("tenant_id", "scope", COALESCE("supplier_id", ''), COALESCE("hotel_id", ''), COALESCE("agency_id", ''), COALESCE("market", '')) WHERE "status" = 'ACTIVE';
--   DROP INDEX "CommercialMarkupRule_tenant_id_layer_status_idx"; DROP INDEX "Hotel_tenant_id_chain_code_idx";
--   ALTER TABLE "CommercialMarkupRule" DROP COLUMN "layer", DROP COLUMN "adjustment_kind", DROP COLUMN "base", DROP COLUMN "fixed_amount_minor",
--     DROP COLUMN "fixed_currency", DROP COLUMN "country_code", DROP COLUMN "city", DROP COLUMN "star_rating", DROP COLUMN "chain_code";
--   ALTER TABLE "FxRate" DROP COLUMN "volatility_bp", DROP COLUMN "as_of";
--   ALTER TABLE "Hotel" DROP COLUMN "chain_code";
--   DROP TYPE "MarkupLayer"; DROP TYPE "MarkupAdjustmentKind"; DROP TYPE "MarkupBase";

CREATE TYPE "MarkupLayer" AS ENUM ('SUPPLIER_CONTRACT', 'AGENCY_TIER', 'CLIENT', 'GLOBAL_OVERRIDE');
CREATE TYPE "MarkupAdjustmentKind" AS ENUM ('PERCENT', 'FIXED', 'SET_SELL');
CREATE TYPE "MarkupBase" AS ENUM ('RUNNING', 'NET');

ALTER TABLE "CommercialMarkupRule"
  ADD COLUMN "layer" "MarkupLayer" NOT NULL DEFAULT 'SUPPLIER_CONTRACT',
  ADD COLUMN "adjustment_kind" "MarkupAdjustmentKind" NOT NULL DEFAULT 'PERCENT',
  ADD COLUMN "base" "MarkupBase" NOT NULL DEFAULT 'RUNNING',
  ADD COLUMN "fixed_amount_minor" BIGINT,
  ADD COLUMN "fixed_currency" CHAR(3),
  ADD COLUMN "country_code" CHAR(2),
  ADD COLUMN "city" TEXT,
  ADD COLUMN "star_rating" INTEGER,
  ADD COLUMN "chain_code" TEXT;

-- Backfill: client and market tiers sit on the CLIENT layer, matching the adapter.
UPDATE "CommercialMarkupRule" SET "layer" = 'CLIENT' WHERE "agency_id" IS NOT NULL OR "market" IS NOT NULL;

ALTER TABLE "CommercialMarkupRule"
  ADD CONSTRAINT "CommercialMarkupRule_amount_shape" CHECK (
    ("adjustment_kind" = 'PERCENT' AND "fixed_amount_minor" IS NULL AND "fixed_currency" IS NULL)
    OR ("adjustment_kind" <> 'PERCENT' AND "fixed_amount_minor" IS NOT NULL AND "fixed_amount_minor" >= 0 AND "fixed_currency" IS NOT NULL AND "fixed_currency" ~ '^[A-Z]{3}$')
  ),
  ADD CONSTRAINT "CommercialMarkupRule_set_sell_layer" CHECK ("adjustment_kind" <> 'SET_SELL' OR "layer" = 'GLOBAL_OVERRIDE'),
  ADD CONSTRAINT "CommercialMarkupRule_flat_base_percent" CHECK ("base" = 'RUNNING' OR "adjustment_kind" = 'PERCENT'),
  ADD CONSTRAINT "CommercialMarkupRule_attribute_targets" CHECK (
    ("country_code" IS NULL OR "country_code" ~ '^[A-Z]{2}$')
    AND ("star_rating" IS NULL OR "star_rating" BETWEEN 1 AND 5)
    AND ("city" IS NULL OR char_length(btrim("city")) >= 1)
    AND ("chain_code" IS NULL OR "chain_code" ~ '^[A-Z0-9_-]{1,32}$')
    AND ("scope" <> 'HOTEL' OR ("country_code" IS NULL AND "city" IS NULL AND "star_rating" IS NULL AND "chain_code" IS NULL))
  );

CREATE INDEX "CommercialMarkupRule_tenant_id_layer_status_idx" ON "CommercialMarkupRule"("tenant_id", "layer", "status");

-- One ACTIVE rule per target, where the target now includes the layer and the attribute dimensions.
DROP INDEX "CommercialMarkupRule_one_active_per_target";
CREATE UNIQUE INDEX "CommercialMarkupRule_one_active_per_target" ON "CommercialMarkupRule"(
  "tenant_id", "layer", "scope", COALESCE("supplier_id", ''), COALESCE("hotel_id", ''), COALESCE("agency_id", ''), COALESCE("market", ''),
  COALESCE("country_code", ''), COALESCE("city", ''), COALESCE("star_rating", 0), COALESCE("chain_code", '')
) WHERE "status" = 'ACTIVE';

ALTER TABLE "FxRate"
  ADD COLUMN "volatility_bp" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "as_of" TIMESTAMP(3),
  ADD CONSTRAINT "FxRate_margin_check" CHECK ("volatility_bp" BETWEEN 0 AND 500 AND "buffer_bp" + "volatility_bp" <= 2500);

ALTER TABLE "Hotel" ADD COLUMN "chain_code" TEXT, ADD CONSTRAINT "Hotel_chain_code_check" CHECK ("chain_code" IS NULL OR "chain_code" ~ '^[A-Z0-9_-]{1,32}$');
CREATE INDEX "Hotel_tenant_id_chain_code_idx" ON "Hotel"("tenant_id", "chain_code");
