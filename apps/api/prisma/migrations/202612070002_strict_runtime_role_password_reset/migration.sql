-- ADR 0091: runtime privileges for password reset, mirroring runtime-role-contract.ts (the drift spec enforces equality).
--   password_reset_tokens: SELECT, INSERT, and UPDATE of used_at only (consume or supersede a token). No DELETE.
--   users: UPDATE gains password_hash, set only after a verified single-use reset.
-- No-op if the group role is absent; provisioning applies the same contract later.
-- Rollback: REVOKE ALL ON "password_reset_tokens" FROM fbeds_api; REVOKE UPDATE ("password_hash") ON "users" FROM fbeds_api;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fbeds_api') THEN
    EXECUTE 'REVOKE ALL ON "password_reset_tokens" FROM fbeds_api';
    EXECUTE 'GRANT SELECT, INSERT ON "password_reset_tokens" TO fbeds_api';
    EXECUTE 'GRANT UPDATE ("used_at") ON "password_reset_tokens" TO fbeds_api';
    EXECUTE 'REVOKE ALL ON "users" FROM fbeds_api';
    EXECUTE 'GRANT SELECT ON "users" TO fbeds_api';
    EXECUTE 'GRANT UPDATE ("last_login_at", "password_hash", "updated_at") ON "users" TO fbeds_api';
  END IF;
END $$;
