-- Ledger integrity guards (ADR 0069, audit finding F4). The ledger's own rules, enforced by the database for every role, the owner included.
--
--   1. "LedgerEntry_sign_by_type": CREDIT, RELEASE and REFUND are positive; DEBIT and HOLD are negative; nothing is zero. The same rule
--      `assertLedgerSign` applies at every append (ADR 0062). Added NOT VALID, then validated: if any stored row breaks it the migration
--      fails and nothing is applied. Run the ledger integrity report first (ENTRY_SIGN_INVALID must be 0).
--   2. "LedgerEntry_account_guard" (BEFORE INSERT): the entry's wallet exists in the entry's tenant and has the entry's currency. Row-level
--      security checks only the entry's own tenant_id and a foreign key is validated without a tenant comparison, so without this an entry
--      could reference another tenant's wallet or carry a currency the wallet does not hold.
--   3. "LedgerEntry_append_only" (BEFORE UPDATE OR DELETE): no row is ever changed. A DELETE is allowed only inside a transaction that set
--      `fbeds.ledger_erasure = 'on'` (SET LOCAL), the owner-governed retention or disposable-database erasure; the application never sets it.
--      There is no cascade into this table (every foreign key to it is RESTRICT), so no cascade exception is needed.
--
-- Runtime roles: no GRANT or REVOKE. Tenant-index review: no new index; the guard is a primary-key lookup on "Wallet".
--
-- Rollback (later forward migration):
--   DROP TRIGGER "LedgerEntry_append_only" ON "LedgerEntry"; DROP TRIGGER "LedgerEntry_account_guard" ON "LedgerEntry";
--   DROP FUNCTION "fbeds_ledger_entry_append_only"(); DROP FUNCTION "fbeds_ledger_entry_account_guard"();
--   ALTER TABLE "LedgerEntry" DROP CONSTRAINT "LedgerEntry_sign_by_type";

ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_sign_by_type" CHECK (
  ("type" IN ('CREDIT', 'RELEASE', 'REFUND') AND "amount_minor" > 0) OR ("type" IN ('DEBIT', 'HOLD') AND "amount_minor" < 0)
) NOT VALID;
ALTER TABLE "LedgerEntry" VALIDATE CONSTRAINT "LedgerEntry_sign_by_type";

CREATE OR REPLACE FUNCTION "fbeds_ledger_entry_account_guard"() RETURNS trigger AS $$
DECLARE
  wallet_currency text;
BEGIN
  SELECT w."currency" INTO wallet_currency FROM "Wallet" w WHERE w."id" = NEW."wallet_id" AND w."tenant_id" = NEW."tenant_id";
  IF wallet_currency IS NULL THEN
    RAISE EXCEPTION 'LedgerEntry wallet_id belongs to another tenant or does not exist' USING ERRCODE = '23514';
  END IF;
  IF wallet_currency <> NEW."currency" THEN
    RAISE EXCEPTION 'LedgerEntry currency differs from its wallet currency' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER "LedgerEntry_account_guard" BEFORE INSERT ON "LedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION "fbeds_ledger_entry_account_guard"();

CREATE OR REPLACE FUNCTION "fbeds_ledger_entry_append_only"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('fbeds.ledger_erasure', true) = 'on' THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'LedgerEntry is append-only; correct it with a new entry' USING ERRCODE = '42501';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER "LedgerEntry_append_only" BEFORE UPDATE OR DELETE ON "LedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION "fbeds_ledger_entry_append_only"();
