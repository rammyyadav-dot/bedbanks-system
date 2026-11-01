-- Rate plan expiry sweeper: SYSTEM audit policy (ADR 0057, S9; pattern of ADR 0005).
--
-- AuditEvent inserts with actor_type = 'SYSTEM' are rejected by every ordinary policy. Marking a live rate plan EXPIRED once its sale window or
-- contract term has ended is a SYSTEM action, so the lifecycle role needs one narrowly scoped exception. The role keeps using the general insert
-- policy for USER events (activate and suspend); this only ADDS a permissive policy, so nothing that was allowed changes and nothing is removed.
--
-- Members of the group role "fbeds_rateplan_status" (created out-of-band by the database owner; this migration creates no role and stores no secret):
--   * MAY additionally insert only: tenant = current tenant, actor_type SYSTEM, no user, action 'supply.rate_plan.status_changed', entity_type 'rate_plan'.
-- The membership test reads pg_roles, so the migration is valid even when the role does not exist; the policy then never matches.
--
-- Tenant-index review: no table, column or index is added or changed. Predicates use tenant_id, already covered by AuditEvent(tenant_id, created_at).
--
-- Rollback (forward migration, reviewed before use):
--   DROP POLICY "AuditEvent_rate_plan_expiry_system_insert" ON "AuditEvent";
--   DROP FUNCTION "fbeds_is_rate_plan_ops_role"();

CREATE FUNCTION "fbeds_is_rate_plan_ops_role"()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM pg_roles r
     WHERE r.rolname = 'fbeds_rateplan_status'
       AND pg_has_role(current_user, r.oid, 'MEMBER')
  )
$$ LANGUAGE SQL STABLE;

CREATE POLICY "AuditEvent_rate_plan_expiry_system_insert" ON "AuditEvent"
  FOR INSERT WITH CHECK (
    "fbeds_is_rate_plan_ops_role"()
    AND "tenant_id" = "fbeds_current_tenant_id"()
    AND "actor_type" = 'SYSTEM'
    AND "user_id" IS NULL
    AND "action" = 'supply.rate_plan.status_changed'
    AND "entity_type" = 'rate_plan'
  );
