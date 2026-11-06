-- ADR 0113: guards for the Agent booking transaction role.
--
-- fbeds_is_booking_transaction_role()   true when the session user is a member of the NOLOGIN group fbeds_booktx.
--                                       The group is created by ops:provision-booking-transaction-role, not by this migration (SR-07).
-- fbeds_booktx_wallet_guard()           a member may insert only an agency wallet whose credit line and cached balance are zero.
--                                       It cannot open the house account or set a limit. Other roles are unchanged.
-- fbeds_booktx_ledger_guard()           a member may append only the Agent booking keys (authorize, its release, the settle pair, cancel-refund)
--                                       and only with the matching entry type and sign. A credit, an adjustment or a foreign key is refused.
--                                       The finance posting role is not a member, so its own booking-shaped keys are unaffected.
--
-- Rollback (forward migration, reviewed before use):
--   DROP TRIGGER "Wallet_booktx_guard" ON "Wallet";
--   DROP TRIGGER "LedgerEntry_booktx_guard" ON "LedgerEntry";
--   DROP FUNCTION "fbeds_booktx_wallet_guard"();
--   DROP FUNCTION "fbeds_booktx_ledger_guard"();
--   DROP FUNCTION "fbeds_is_booking_transaction_role"();

CREATE FUNCTION "fbeds_is_booking_transaction_role"()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM pg_roles r
     WHERE r.rolname = 'fbeds_booktx'
       AND pg_has_role(current_user, r.oid, 'MEMBER')
  )
$$ LANGUAGE SQL STABLE;
REVOKE ALL ON FUNCTION "fbeds_is_booking_transaction_role"() FROM PUBLIC;

CREATE FUNCTION "fbeds_booktx_wallet_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF "fbeds_is_booking_transaction_role"() AND TG_OP = 'INSERT' THEN
    IF NEW."agency_id" IS NULL THEN
      RAISE EXCEPTION 'booking transaction role cannot open a house account' USING ERRCODE = '42501';
    END IF;
    IF NEW."credit_limit" IS DISTINCT FROM 0 OR NEW."cached_balance" IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION 'booking transaction role cannot set a credit limit or a balance' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION "fbeds_booktx_wallet_guard"() FROM PUBLIC;
CREATE TRIGGER "Wallet_booktx_guard" BEFORE INSERT ON "Wallet" FOR EACH ROW EXECUTE FUNCTION "fbeds_booktx_wallet_guard"();

CREATE FUNCTION "fbeds_booktx_ledger_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ref text := NEW."reference";
BEGIN
  IF NOT "fbeds_is_booking_transaction_role"() THEN RETURN NEW; END IF;
  IF ref IS NULL OR ref !~ '^booking:[A-Za-z0-9_-]+$' THEN
    RAISE EXCEPTION 'booking transaction role cannot append this ledger entry' USING ERRCODE = '42501';
  END IF;
  IF NEW."idempotency_key" = ref || ':authorize' THEN
    IF NEW."type"::text <> 'HOLD' OR NEW."amount_minor" >= 0 THEN
      RAISE EXCEPTION 'booking transaction role cannot append this ledger entry' USING ERRCODE = '42501';
    END IF;
  ELSIF NEW."idempotency_key" IN (ref || ':authorize:release', ref || ':authorize:settle-release') THEN
    IF NEW."type"::text <> 'RELEASE' OR NEW."amount_minor" <= 0 THEN
      RAISE EXCEPTION 'booking transaction role cannot append this ledger entry' USING ERRCODE = '42501';
    END IF;
  ELSIF NEW."idempotency_key" = ref || ':authorize:settle-debit' THEN
    IF NEW."type"::text <> 'DEBIT' OR NEW."amount_minor" >= 0 THEN
      RAISE EXCEPTION 'booking transaction role cannot append this ledger entry' USING ERRCODE = '42501';
    END IF;
  ELSIF NEW."idempotency_key" = ref || ':cancel-refund' THEN
    IF NEW."type"::text <> 'REFUND' OR NEW."amount_minor" <= 0 THEN
      RAISE EXCEPTION 'booking transaction role cannot append this ledger entry' USING ERRCODE = '42501';
    END IF;
  ELSE
    RAISE EXCEPTION 'booking transaction role cannot append this ledger entry' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION "fbeds_booktx_ledger_guard"() FROM PUBLIC;
CREATE TRIGGER "LedgerEntry_booktx_guard" BEFORE INSERT ON "LedgerEntry" FOR EACH ROW EXECUTE FUNCTION "fbeds_booktx_ledger_guard"();
