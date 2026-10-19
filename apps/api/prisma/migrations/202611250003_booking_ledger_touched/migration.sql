-- ADR 0072: does the agency ledger hold anything for this booking? A price-changing amendment must not be approved on a booking that was held or charged on the ledger
-- (changing the total under a ledger charge would make a later cancellation settlement refund the wrong amount), and the booking module's role must not be able to read the ledger.
--
-- fbeds_booking_has_ledger_entries(booking_id)  SECURITY DEFINER, STABLE. Returns ONE boolean: whether any LedgerEntry of the CURRENT tenant has an idempotency key that starts with
--                           'booking:<booking_id>:'. It takes no tenant argument (it uses fbeds_current_tenant_id(), the same setting row-level security uses), so it cannot be pointed at
--                           another tenant, and it returns no amount, wallet or entry. EXECUTE is granted to the booking group role by the owner-run provisioning script, not here.
-- No table, column, index, policy or grant changes. No data is read or written by the migration.
--
-- Rollback (forward migration; reviewed before use; only while amendments are switched off):
--   DROP FUNCTION "fbeds_booking_has_ledger_entries"(text);
CREATE FUNCTION "fbeds_booking_has_ledger_entries"(p_booking_id TEXT) RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM "LedgerEntry" e
     WHERE e."tenant_id" = "fbeds_current_tenant_id"()
       AND left(e."idempotency_key", length('booking:' || p_booking_id || ':')) = 'booking:' || p_booking_id || ':'
  )
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION "fbeds_booking_has_ledger_entries"(TEXT) FROM PUBLIC;
