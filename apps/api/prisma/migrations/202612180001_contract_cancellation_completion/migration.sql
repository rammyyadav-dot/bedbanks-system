-- No-show money facts use the existing immutable finance outbox and posting worker.
-- No table or policy changes. Tenant indexes: Booking(tenant_id,id), InventoryHold(tenant_id,id),
-- InventoryHoldNight(hold_id,availability_id) and counter primary keys bound every lookup.
-- Rollback: revert app, revoke execution and DROP FUNCTION. PostgreSQL enum values cannot
-- be removed in place; leave NO_SHOW unused. Never remove existing audit/financial evidence.
ALTER TYPE "BookingFinanceEventType" ADD VALUE IF NOT EXISTS 'NO_SHOW';

-- The booking role gets one tenant-bound operation, never direct inventory privileges.
-- Called ONLY after a booking moves to CANCELLED, inside that same write transaction.
CREATE FUNCTION public.fbeds_booking_release_cancelled_inventory(p_booking_id text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_tenant text := public.fbeds_current_tenant_id();
  v_booking public."Booking"%ROWTYPE;
  v_hold public."InventoryHold"%ROWTYPE;
  v_night record;
  v_changed integer;
BEGIN
  IF v_tenant IS NULL OR v_tenant = '' THEN RAISE EXCEPTION 'Tenant required'; END IF;
  SELECT * INTO v_booking FROM public."Booking"
    WHERE "id" = p_booking_id AND "tenant_id" = v_tenant FOR UPDATE;
  IF NOT FOUND OR v_booking."status" <> 'CANCELLED' THEN RAISE EXCEPTION 'Cancelled booking required'; END IF;
  IF v_booking."search_snapshot"->>'inventoryHoldId' IS NULL THEN RETURN; END IF;
  SELECT * INTO v_hold FROM public."InventoryHold"
    WHERE "id" = v_booking."search_snapshot"->>'inventoryHoldId' AND "tenant_id" = v_tenant FOR UPDATE;
  IF NOT FOUND OR v_hold."canonical_hotel_id" <> v_booking."hotel_id"
    OR v_hold."rate_plan_id" IS DISTINCT FROM v_booking."search_snapshot"->>'ratePlanId'
    THEN RAISE EXCEPTION 'Inventory hold is inconsistent'; END IF;
  IF v_hold."status" = 'RELEASED' THEN RETURN; END IF;
  IF v_hold."status" <> 'CONFIRMED' THEN RAISE EXCEPTION 'Confirmed inventory required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public."InventoryHoldNight" WHERE "hold_id" = v_hold."id" AND "tenant_id" = v_tenant)
    THEN RAISE EXCEPTION 'Inventory nights missing'; END IF;
  FOR v_night IN SELECT * FROM public."InventoryHoldNight"
      WHERE "hold_id" = v_hold."id" AND "tenant_id" = v_tenant ORDER BY "stay_date", "availability_id"
  LOOP
    IF v_night."quantity" < 1 THEN RAISE EXCEPTION 'Invalid inventory quantity'; END IF;
    IF v_night."counter_kind" = 'NONE' THEN CONTINUE; END IF;
    -- Same lock order as reserveNight: plan row before its pool day.
    PERFORM 1 FROM public."DailyAvailability" WHERE "id" = v_night."availability_id" AND "tenant_id" = v_tenant FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Inventory row missing'; END IF;
    IF v_night."counter_kind" = 'POOL_DAY' THEN
      UPDATE public."InventoryPoolDay" SET "sold" = "sold" - v_night."quantity", "updated_at" = CURRENT_TIMESTAMP
        WHERE "id" = v_night."pool_day_id" AND "tenant_id" = v_tenant AND "sold" >= v_night."quantity";
    ELSE
      UPDATE public."DailyAvailability" SET "sold" = "sold" - v_night."quantity", "updated_at" = CURRENT_TIMESTAMP
        WHERE "id" = v_night."availability_id" AND "tenant_id" = v_tenant AND "sold" >= v_night."quantity";
    END IF;
    GET DIAGNOSTICS v_changed = ROW_COUNT;
    IF v_changed <> 1 THEN RAISE EXCEPTION 'Inventory counter inconsistent'; END IF;
  END LOOP;
  UPDATE public."InventoryHold" SET "status" = 'RELEASED', "released_at" = CURRENT_TIMESTAMP, "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = v_hold."id" AND "tenant_id" = v_tenant;
END;
$$;
REVOKE ALL ON FUNCTION public.fbeds_booking_release_cancelled_inventory(text) FROM PUBLIC;
-- Existing installations receive the narrow grant; new installations use bookingOpsGrantStatements.
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fbeds_booking') THEN
  GRANT EXECUTE ON FUNCTION public.fbeds_booking_release_cancelled_inventory(text) TO fbeds_booking;
END IF; END $$;
