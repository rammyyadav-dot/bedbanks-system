-- ADR 0067 (F-12): controlled FX for selling a contract in another currency.
--
-- An FxRate converts a base (contract settlement) currency into a quote (selling) currency: `rate_scaled` is quote major units per base major
-- unit times 10^8, an integer, and `buffer_bp` (0..2000) is added on top to cover movement until settlement. A rate is drafted, then activated
-- only through an approved maker-checker request decided by a second person; activating a pair retires the pair's previous ACTIVE rate. At most one
-- ACTIVE rate per tenant and pair (partial unique index). Without an ACTIVE rate a contract is never sold in another currency.
--
-- Isolation: forced tenant RLS. Tenant-index review: (tenant_id, status) for the per-search load; the unique index covers the pair lookup.
--
-- Rollback (forward migration; reviewed before use; bookings keep the rate frozen on them):
--   DROP TABLE "FxRate"; DROP TYPE "FxRateStatus";

CREATE TYPE "FxRateStatus" AS ENUM ('DRAFT', 'ACTIVE', 'RETIRED');

CREATE TABLE "FxRate" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "base_currency" CHAR(3) NOT NULL,
  "quote_currency" CHAR(3) NOT NULL,
  "rate_scaled" BIGINT NOT NULL,
  "buffer_bp" INTEGER NOT NULL DEFAULT 0,
  "status" "FxRateStatus" NOT NULL DEFAULT 'DRAFT',
  "reason" TEXT NOT NULL,
  "created_by_id" TEXT NOT NULL,
  "activated_at" TIMESTAMP(3),
  "retired_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FxRate_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FxRate_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "FxRate_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "FxRate_values_check" CHECK (
    "base_currency" ~ '^[A-Z]{3}$' AND "quote_currency" ~ '^[A-Z]{3}$' AND "base_currency" <> "quote_currency"
    AND "rate_scaled" > 0 AND "buffer_bp" BETWEEN 0 AND 2000 AND char_length(btrim("reason")) >= 3
  )
);
CREATE INDEX "FxRate_tenant_id_status_idx" ON "FxRate"("tenant_id", "status");
CREATE UNIQUE INDEX "FxRate_one_active_per_pair" ON "FxRate"("tenant_id", "base_currency", "quote_currency") WHERE "status" = 'ACTIVE';

ALTER TABLE "FxRate" ENABLE ROW LEVEL SECURITY; ALTER TABLE "FxRate" FORCE ROW LEVEL SECURITY;
CREATE POLICY "FxRate_tenant_isolation" ON "FxRate" USING ("tenant_id" = "fbeds_current_tenant_id"()) WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());
