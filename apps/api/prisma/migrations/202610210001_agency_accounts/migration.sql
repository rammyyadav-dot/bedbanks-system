-- Agency accounts, slice 1 of ADR 0028 (read-only; no posting change).
--
-- Owner decisions (2026-10-04): one account per agency; one credit concept (merged later, slice 3); bank transfer only at launch.
--
-- A "Wallet" row becomes an ACCOUNT. "agency_id" NULL is the tenant HOUSE account: every existing row is a house account, so this is
-- the migration of the tenant wallet to the house account with no data change. A non-null "agency_id" is that agency's account.
-- Nothing in this slice creates agency accounts or posts to them; holds, confirmation and cancellation keep using the house account.
--
-- Uniqueness:
--   * one house account per tenant and currency: partial unique index "Wallet_house_tenant_id_currency_key" (agency_id IS NULL);
--     PostgreSQL treats NULLs as distinct, so the full index below alone would allow two house accounts.
--   * one account per agency and currency: "Wallet_tenant_id_agency_id_currency_key" (the index Prisma declares).
-- Tenant integrity: an account may only name an agency of its own tenant (same guard as ADR 0032's amendment, migration 202610200001).
-- The agency foreign key is RESTRICT: an agency with an account (and so with ledger history) cannot be deleted.
--
-- Runtime role: "Wallet" and "LedgerEntry" stay finance-gated (privileged path, ADR 0032). No GRANT here.
-- Tenant indexes: both new indexes lead with "tenant_id"; the trigger check is a primary-key lookup on "Agency".
--
-- Rollback is a later forward migration, and only while no agency account exists:
--   DROP TRIGGER "Wallet_tenant_references" ON "Wallet";
--   DROP INDEX "Wallet_tenant_id_agency_id_currency_key"; DROP INDEX "Wallet_house_tenant_id_currency_key";
--   ALTER TABLE "Wallet" DROP COLUMN "agency_id";
--   CREATE UNIQUE INDEX "Wallet_tenant_id_currency_key" ON "Wallet"("tenant_id", "currency");

ALTER TABLE "Wallet" ADD COLUMN "agency_id" TEXT;

ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_agency_id_fkey" FOREIGN KEY ("agency_id") REFERENCES "Agency"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

DROP INDEX "Wallet_tenant_id_currency_key";

CREATE UNIQUE INDEX "Wallet_tenant_id_agency_id_currency_key" ON "Wallet"("tenant_id", "agency_id", "currency");

CREATE UNIQUE INDEX "Wallet_house_tenant_id_currency_key" ON "Wallet"("tenant_id", "currency") WHERE "agency_id" IS NULL;

CREATE TRIGGER "Wallet_tenant_references" BEFORE INSERT OR UPDATE OF "tenant_id", "agency_id" ON "Wallet"
  FOR EACH ROW EXECUTE FUNCTION "fbeds_enforce_tenant_references"('agency_id', 'Agency');
