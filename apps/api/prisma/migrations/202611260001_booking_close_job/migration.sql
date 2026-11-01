-- ADR 0039, Phase 6G: the scheduled close after the dispute window (spec workflow G, step 3: "after the dispute window the booking is Closed and locked for edits").
--
-- fbeds_booking_close_due_tenants(cutoff)  SECURITY DEFINER, STABLE. Returns ONLY tenant ids that have an open (not yet closed) booking in one of the five closable
--                           statuses that has not changed since `cutoff`, so the job can visit tenants without a cross-tenant table read (the same pattern as the other booking
--                           functions). No row, name or amount leaves the function. EXECUTE is granted to the booking group role by the owner-run provisioning script, not here.
-- Booking_close_due_idx     PARTIAL index on (updated_at) for open bookings in a closable status. Tenant-index review: it deliberately does NOT lead with tenant_id because its only
--                           reader is the cross-tenant ids-only function above; every tenant-scoped query keeps using the existing tenant-leading indexes. It is small and is dropped
--                           with the function on rollback.
-- No table, column, constraint, policy or grant changes. No data is rewritten.
--
-- Rollback (forward migration; reviewed before use; only while the lifecycle job is stopped):
--   DROP FUNCTION "fbeds_booking_close_due_tenants"(timestamp);
--   DROP INDEX "Booking_close_due_idx";
CREATE INDEX "Booking_close_due_idx" ON "Booking"("updated_at") WHERE "closed_at" IS NULL AND "status" IN ('CHECKED_OUT', 'NO_SHOW', 'CANCELLED', 'REJECTED', 'FAILED');

CREATE FUNCTION "fbeds_booking_close_due_tenants"(cutoff TIMESTAMP) RETURNS SETOF TEXT AS $$
  SELECT DISTINCT b."tenant_id" FROM "Booking" b
   WHERE b."closed_at" IS NULL AND b."status" IN ('CHECKED_OUT', 'NO_SHOW', 'CANCELLED', 'REJECTED', 'FAILED') AND b."updated_at" < cutoff
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION "fbeds_booking_close_due_tenants"(TIMESTAMP) FROM PUBLIC;
