-- ADR 0107: Market Validity, Source Market Profiling & Grouping.
--
-- `SourceMarketGroup` defines tenant-scoped geo-bundles of ISO 3166-1 alpha-2 country codes (e.g. GCC, CIS, DOMESTIC_IN, EU_SCHENGEN).
-- `MarketValidityRule` binds INCLUDE / EXCLUDE source market rules to a `Contract` (contract-wide when `rate_plan_id` is null) or to a
-- specific `RatePlan` (which overrides contract-level rules during evaluation, with EXCLUDE rules taking fail-safe precedence over INCLUDE).
--
-- Isolation: forced RLS on `tenant_id` for both `SourceMarketGroup` and `MarketValidityRule`.
--
-- Tenant-index and FK review:
--   - `SourceMarketGroup`: unique `(tenant_id, code)` and index `(tenant_id)` cover tenant lookups and the `tenant_id` FK.
--   - `MarketValidityRule`: `(tenant_id, contract_id)` covers tenant-scoped contract lookups; `(contract_id)`, `(rate_plan_id)`, and
--     `(market_group_id)` index each referencing foreign key column so parent deletes/updates never seq-scan on pooled Neon endpoints.
--
-- Rollback (forward migration; reviewed before use):
--   DROP TABLE "MarketValidityRule";
--   DROP TABLE "SourceMarketGroup";
--   DROP TYPE "MarketMatchType";
--   DROP TYPE "MarketInclusion";

-- CreateEnum
CREATE TYPE "MarketInclusion" AS ENUM ('INCLUDE', 'EXCLUDE');

-- CreateEnum
CREATE TYPE "MarketMatchType" AS ENUM ('COUNTRY_CODE', 'MARKET_GROUP', 'WORLDWIDE');

-- CreateTable
CREATE TABLE "SourceMarketGroup" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "country_codes" TEXT[],
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SourceMarketGroup_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SourceMarketGroup_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MarketValidityRule" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "contract_id" TEXT NOT NULL,
    "rate_plan_id" TEXT,
    "inclusion_type" "MarketInclusion" NOT NULL DEFAULT 'INCLUDE',
    "match_type" "MarketMatchType" NOT NULL DEFAULT 'COUNTRY_CODE',
    "country_codes" TEXT[],
    "market_group_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketValidityRule_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MarketValidityRule_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MarketValidityRule_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "Contract"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MarketValidityRule_rate_plan_id_fkey" FOREIGN KEY ("rate_plan_id") REFERENCES "RatePlan"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MarketValidityRule_market_group_id_fkey" FOREIGN KEY ("market_group_id") REFERENCES "SourceMarketGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "SourceMarketGroup_tenant_id_code_key" ON "SourceMarketGroup"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "SourceMarketGroup_tenant_id_idx" ON "SourceMarketGroup"("tenant_id");

-- CreateIndex
CREATE INDEX "MarketValidityRule_tenant_id_contract_id_idx" ON "MarketValidityRule"("tenant_id", "contract_id");

-- CreateIndex
CREATE INDEX "MarketValidityRule_contract_id_idx" ON "MarketValidityRule"("contract_id");

-- CreateIndex
CREATE INDEX "MarketValidityRule_rate_plan_id_idx" ON "MarketValidityRule"("rate_plan_id");

-- CreateIndex
CREATE INDEX "MarketValidityRule_market_group_id_idx" ON "MarketValidityRule"("market_group_id");

-- Row-level security
ALTER TABLE "SourceMarketGroup" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SourceMarketGroup" FORCE ROW LEVEL SECURITY;
CREATE POLICY "SourceMarketGroup_tenant_isolation" ON "SourceMarketGroup"
  USING ("tenant_id" = "fbeds_current_tenant_id"())
  WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());

ALTER TABLE "MarketValidityRule" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MarketValidityRule" FORCE ROW LEVEL SECURITY;
CREATE POLICY "MarketValidityRule_tenant_isolation" ON "MarketValidityRule"
  USING ("tenant_id" = "fbeds_current_tenant_id"())
  WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());

-- SELECT (and only SELECT) on these tables is part of the runtime-role contract.
-- Provisioning applies it. This migration does not grant the runtime role.
