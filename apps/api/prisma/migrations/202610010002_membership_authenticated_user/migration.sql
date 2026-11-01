-- Authenticated membership list before a tenant is selected (ADR 0008).
--
-- memberships already has FORCE ROW LEVEL SECURITY. The tenant policy returns
-- no rows when app.current_tenant_id is unset, so a non-bypass API role cannot
-- load the caller's workspaces during login or /auth/me. This adds a SELECT
-- policy for the transaction-local user id. An empty or missing setting matches
-- nothing. It does not grant access to another user's memberships, and it does
-- not replace the tenant policy used after a workspace is selected.
--
-- Tenant-index review: no table, column, or index is added. The predicate uses
-- memberships.user_id, which is already the leading column of the unique
-- (user_id, tenant_id) constraint.
--
-- Rollback (forward migration, reviewed before use):
--   DROP POLICY "memberships_authenticated_user" ON "memberships";
--   DROP FUNCTION "fbeds_current_user_id"();

CREATE OR REPLACE FUNCTION "fbeds_current_user_id"()
RETURNS TEXT AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')
$$ LANGUAGE SQL STABLE;

CREATE POLICY "memberships_authenticated_user" ON "memberships"
  FOR SELECT
  USING ("user_id" = "fbeds_current_user_id"());
