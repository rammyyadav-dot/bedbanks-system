-- ADR 0039, Phase 6E: the scheduled Checked-out job (spec workflow G, step 1: "the day after check-out, Confirmed bookings auto-move to Checked out").
--
-- fbeds_booking_checkout_due_tenants(today)  SECURITY DEFINER, STABLE. Returns ONLY tenant ids that have a Confirmed, unlocked booking whose check-out date is before
--                           `today`, so the job can visit tenants without a cross-tenant table read (the same pattern as fbeds_booking_due_tenants). No row, name or
--                           amount leaves the function. EXECUTE is granted to the booking group role by the owner-run provisioning script, not here.
-- Booking_checkout_due_idx  PARTIAL index on (check_out) WHERE status = 'CONFIRMED' AND closed_at IS NULL. Tenant-index review: it deliberately does NOT lead with
--                           tenant_id, because its only reader is the cross-tenant ids-only function above; every tenant-scoped query keeps using the existing
--                           tenant-leading indexes. It is small (only Confirmed, open bookings) and it is dropped with the function on rollback.
-- No table, column, constraint, policy or grant changes. No data is rewritten.
--
-- Rollback (forward migration; reviewed before use; only while the lifecycle job is stopped):
--   DROP FUNCTION "fbeds_booking_checkout_due_tenants"(date);
--   DROP INDEX "Booking_checkout_due_idx";
CREATE INDEX "Booking_checkout_due_idx" ON "Booking"("check_out") WHERE "status" = 'CONFIRMED' AND "closed_at" IS NULL;

CREATE FUNCTION "fbeds_booking_checkout_due_tenants"(today DATE) RETURNS SETOF TEXT AS $$
  SELECT DISTINCT b."tenant_id" FROM "Booking" b
   WHERE b."status" = 'CONFIRMED' AND b."closed_at" IS NULL AND b."check_out" IS NOT NULL AND b."check_out" < today
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION "fbeds_booking_checkout_due_tenants"(DATE) FROM PUBLIC;
