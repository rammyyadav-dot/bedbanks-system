-- ADR 0062: the Admin connector API (create a DRAFT connector, edit its name/version/non-secret transport metadata, attach credential REFERENCES)
-- runs on the strict API runtime role, so two tables join the explicit write set.
--
--   ConnectorDefinition          SELECT, INSERT, UPDATE on 4 columns (name, version, transport_metadata, updated_at).
--                                status, capabilities and health_state are NOT writable: the API cannot activate or certify a supplier.
--   ConnectorCredentialReference SELECT, INSERT, DELETE, UPDATE on 2 columns (secret_ref, updated_at). Connector and purpose are immutable.
--
-- Same convergence rule as 202610180001: revoke everything on each table, then grant exactly what
-- apps/api/src/database/runtime-role-contract.ts grants; a spec regenerates these statements and fails on any difference.
-- Row-level security is untouched (both tables stay FORCE RLS by tenant). No-op when the role does not exist.
-- Rollback (owner only): REVOKE ALL ON "ConnectorDefinition", "ConnectorCredentialReference" FROM fbeds_api. No data change; the admin routes then answer a typed 403.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fbeds_api') THEN
    EXECUTE 'REVOKE ALL ON "ConnectorDefinition" FROM fbeds_api';
    EXECUTE 'GRANT SELECT, INSERT ON "ConnectorDefinition" TO fbeds_api';
    EXECUTE 'GRANT UPDATE ("name", "version", "transport_metadata", "updated_at") ON "ConnectorDefinition" TO fbeds_api';
    EXECUTE 'REVOKE ALL ON "ConnectorCredentialReference" FROM fbeds_api';
    EXECUTE 'GRANT SELECT, INSERT, DELETE ON "ConnectorCredentialReference" TO fbeds_api';
    EXECUTE 'GRANT UPDATE ("secret_ref", "updated_at") ON "ConnectorCredentialReference" TO fbeds_api';
  END IF;
END $$;
