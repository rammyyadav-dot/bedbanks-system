-- Rate plan clone writer guard (ADR 0057, S8, decision D5).
--
-- ADR 0032 keeps RatePlan INSERT away from the strict API runtime role, so cloning a plan was impossible in a strict deployment. Cloning gets its own
-- narrow login ("fbeds_rateplan_cloner", member of the group "fbeds_rateplan_clone", created out-of-band by the database owner; this migration creates
-- no role and stores no secret). A role that can INSERT a RatePlan could insert an ACTIVE one and bypass the activation approval, so the database
-- itself, not the application, refuses that:
--   * a member of "fbeds_rateplan_clone" may INSERT a RatePlan only with status = 'DRAFT' and no inventory pool; any other row is refused (42501);
--   * every other role, including the owner and any superuser (an implicit member of every role), is unaffected: the trigger returns NEW untouched,
--     so nothing that worked changes.
-- The membership test reads pg_roles, so the migration is valid even when the role does not exist; the trigger then never constrains anyone.
--
-- Tenant-index review: no table, column or index is added or changed.
--
-- Rollback (forward migration, reviewed before use):
--   DROP TRIGGER "RatePlan_clone_guard" ON "RatePlan";
--   DROP FUNCTION "fbeds_rate_plan_clone_guard"();

CREATE FUNCTION "fbeds_rate_plan_clone_guard"()
RETURNS TRIGGER AS $$
BEGIN
  -- A superuser is an implicit member of every role in PostgreSQL, so it is excluded explicitly: the guard binds the clone login, never the owner or tooling.
  IF EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = 'fbeds_rateplan_clone' AND pg_has_role(current_user, r.oid, 'MEMBER'))
     AND NOT (SELECT u.rolsuper FROM pg_roles u WHERE u.rolname = current_user) THEN
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'the rate plan clone role may only insert DRAFT plans' USING ERRCODE = '42501';
    END IF;
    IF NEW."inventory_pool_id" IS NOT NULL THEN
      RAISE EXCEPTION 'the rate plan clone role may not attach an inventory pool' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER "RatePlan_clone_guard"
  BEFORE INSERT ON "RatePlan"
  FOR EACH ROW EXECUTE FUNCTION "fbeds_rate_plan_clone_guard"();
