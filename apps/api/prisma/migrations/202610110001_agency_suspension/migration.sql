-- Agency suspension (ADR 0020). Adds the SUSPENDED agency status. No table, column, index or grant changes.
-- Reaching or leaving SUSPENDED is done only by the API after an approved maker-checker request (action agency.suspend).
--
-- Rollback notes: PostgreSQL cannot drop an enum value. Before reverting the API, reinstate every suspended agency
-- (UPDATE "Agency" SET "status" = 'INACTIVE' WHERE "status" = 'SUSPENDED'); the unused value is then harmless and may stay.
-- Tenant-index review: no new query path; "Agency_tenant_id_status_idx" already covers status filters.
ALTER TYPE "AgencyStatus" ADD VALUE IF NOT EXISTS 'SUSPENDED';
