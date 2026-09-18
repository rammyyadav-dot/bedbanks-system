-- P0/P1 hardening: tenant-scoped authorization, financial minor units,
-- multi-currency wallets and PostgreSQL RLS. This is forward-only.
--
-- Deployment preflight: before applying to a non-disposable database, the
-- database owner must confirm every UserRole has a matching membership and
-- every currency is a three-letter uppercase ISO 4217 code. The guarded
-- validation blocks below deliberately fail rather than silently repairing
-- inconsistent data.

-- Make formal role assignments explicitly tenant-scoped. The trigger below
-- proves that the assigned user belongs to the role tenant.
ALTER TABLE "UserRole" ADD COLUMN "tenant_id" TEXT;

UPDATE "UserRole" AS assignment
SET "tenant_id" = role."tenant_id"
FROM "Role" AS role
WHERE assignment."role_id" = role."id";

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "UserRole" AS assignment
    LEFT JOIN "memberships" AS membership
      ON membership."user_id" = assignment."user_id"
     AND membership."tenant_id" = assignment."tenant_id"
    WHERE assignment."tenant_id" IS NULL OR membership."id" IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot harden UserRole: an assignment does not have a matching membership';
  END IF;
END $$;

ALTER TABLE "UserRole" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "UserRole_tenant_id_idx" ON "UserRole"("tenant_id");

CREATE OR REPLACE FUNCTION "fbeds_enforce_user_role_tenant"()
RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "Role" WHERE "id" = NEW."role_id" AND "tenant_id" = NEW."tenant_id"
  ) THEN
    RAISE EXCEPTION 'UserRole tenant must match Role tenant';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "memberships" WHERE "user_id" = NEW."user_id" AND "tenant_id" = NEW."tenant_id"
  ) THEN
    RAISE EXCEPTION 'UserRole requires a matching membership';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "UserRole_tenant_integrity"
BEFORE INSERT OR UPDATE OF "user_id", "role_id", "tenant_id" ON "UserRole"
FOR EACH ROW EXECUTE FUNCTION "fbeds_enforce_user_role_tenant"();

-- Financial amounts are always minor units. PostgreSQL BIGINT avoids the
-- INTEGER ceiling while API serialization is handled as strings.
ALTER TABLE "Booking" ALTER COLUMN "total_minor" TYPE BIGINT USING "total_minor"::BIGINT;
ALTER TABLE "Cancellation" ALTER COLUMN "refund_minor" TYPE BIGINT USING "refund_minor"::BIGINT;
ALTER TABLE "Wallet" ALTER COLUMN "credit_limit" TYPE BIGINT USING "credit_limit"::BIGINT;
ALTER TABLE "Wallet" RENAME COLUMN "balance" TO "cached_balance";
ALTER TABLE "Wallet" ALTER COLUMN "cached_balance" TYPE BIGINT USING "cached_balance"::BIGINT;
ALTER TABLE "LedgerEntry" ALTER COLUMN "amount_minor" TYPE BIGINT USING "amount_minor"::BIGINT;

-- A cached balance is not the financial source of truth. Ledger entries are
-- append-only and uniquely idempotent per wallet.
ALTER TABLE "LedgerEntry" ADD COLUMN "idempotency_key" TEXT;
UPDATE "LedgerEntry" SET "idempotency_key" = CONCAT('legacy:', "id") WHERE "idempotency_key" IS NULL;
ALTER TABLE "LedgerEntry" ALTER COLUMN "idempotency_key" SET NOT NULL;
CREATE UNIQUE INDEX "LedgerEntry_wallet_id_idempotency_key_key"
  ON "LedgerEntry"("wallet_id", "idempotency_key");

-- A tenant may hold one wallet per currency. Preserve existing wallet rows.
DROP INDEX "Wallet_tenant_id_key";
ALTER TABLE "Wallet" ALTER COLUMN "currency" TYPE CHAR(3) USING UPPER("currency")::CHAR(3);
ALTER TABLE "LedgerEntry" ALTER COLUMN "currency" TYPE CHAR(3) USING UPPER("currency")::CHAR(3);
CREATE UNIQUE INDEX "Wallet_tenant_id_currency_key" ON "Wallet"("tenant_id", "currency");
CREATE INDEX "Wallet_tenant_id_idx" ON "Wallet"("tenant_id");
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_currency_format_check" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_currency_format_check" CHECK ("currency" ~ '^[A-Z]{3}$');

-- Idempotency belongs to the tenant boundary, not the whole platform.
DROP INDEX "Booking_idempotency_key_key";
CREATE UNIQUE INDEX "Booking_tenant_id_idempotency_key_key"
  ON "Booking"("tenant_id", "idempotency_key");

-- RLS uses a transaction-local setting. Application code must call
-- PrismaService.withTenant() only after authenticated membership validation.
CREATE OR REPLACE FUNCTION "fbeds_current_tenant_id"()
RETURNS TEXT AS $$
  SELECT NULLIF(current_setting('app.current_tenant_id', true), '')
$$ LANGUAGE SQL STABLE;

ALTER TABLE "memberships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Role" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "UserRole" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Booking" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Cancellation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Wallet" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LedgerEntry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditEvent" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "memberships" FORCE ROW LEVEL SECURITY;
ALTER TABLE "Role" FORCE ROW LEVEL SECURITY;
ALTER TABLE "UserRole" FORCE ROW LEVEL SECURITY;
ALTER TABLE "Booking" FORCE ROW LEVEL SECURITY;
ALTER TABLE "Cancellation" FORCE ROW LEVEL SECURITY;
ALTER TABLE "Wallet" FORCE ROW LEVEL SECURITY;
ALTER TABLE "LedgerEntry" FORCE ROW LEVEL SECURITY;
ALTER TABLE "AuditEvent" FORCE ROW LEVEL SECURITY;

CREATE POLICY "memberships_tenant_isolation" ON "memberships"
  USING ("tenant_id" = "fbeds_current_tenant_id"())
  WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());
CREATE POLICY "Role_tenant_isolation" ON "Role"
  USING ("tenant_id" = "fbeds_current_tenant_id"())
  WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());
CREATE POLICY "UserRole_tenant_isolation" ON "UserRole"
  USING ("tenant_id" = "fbeds_current_tenant_id"())
  WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());
CREATE POLICY "Booking_tenant_isolation" ON "Booking"
  USING ("tenant_id" = "fbeds_current_tenant_id"())
  WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());
CREATE POLICY "Cancellation_tenant_isolation" ON "Cancellation"
  USING (EXISTS (SELECT 1 FROM "Booking" WHERE "Booking"."id" = "Cancellation"."booking_id" AND "Booking"."tenant_id" = "fbeds_current_tenant_id"()))
  WITH CHECK (EXISTS (SELECT 1 FROM "Booking" WHERE "Booking"."id" = "Cancellation"."booking_id" AND "Booking"."tenant_id" = "fbeds_current_tenant_id"()));
CREATE POLICY "Wallet_tenant_isolation" ON "Wallet"
  USING ("tenant_id" = "fbeds_current_tenant_id"())
  WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());
CREATE POLICY "LedgerEntry_tenant_isolation" ON "LedgerEntry"
  USING ("tenant_id" = "fbeds_current_tenant_id"())
  WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());
CREATE POLICY "AuditEvent_tenant_isolation" ON "AuditEvent"
  USING ("tenant_id" = "fbeds_current_tenant_id"())
  WITH CHECK ("tenant_id" = "fbeds_current_tenant_id"());
