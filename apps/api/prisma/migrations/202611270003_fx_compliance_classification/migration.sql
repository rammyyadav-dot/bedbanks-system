-- ADR 0067 F-12: classify commercial.fx.activated and commercial.fx.retired (controlled FX rates) as FINANCIAL_CONTROL evidence.
--
-- Replaces the classifier only. GENERATED from apps/api/src/compliance/compliance-classification.ts; a spec compares the latest migration that
-- defines "fbeds_compliance_category" with the generated text. No table, column, index, policy, grant or data change; existing records are not
-- reclassified (records are immutable and only actions written after this migration are affected).
-- Tenant-index review: no index involved.
--
-- Rollback (forward migration, reviewed before use): re-create the function from 202611210001_compliance_report_classification.
CREATE OR REPLACE FUNCTION "fbeds_compliance_category"(action TEXT) RETURNS "ComplianceCategory" AS $$
  SELECT CASE
    WHEN action IN ('platform.role.created', 'platform.role.updated', 'platform.role.permissions.updated', 'platform.role.assigned', 'platform.role.revoked', 'tenant.membership.changed', 'agency.member.added', 'agency.member.removed') THEN 'RBAC_CHANGE'::"ComplianceCategory"
    WHEN action IN ('platform.tenant.context.entered', 'bootstrap.platform_owner.provisioned', 'bootstrap.tenant_owner.provisioned') THEN 'PRIVILEGED_ACCESS'::"ComplianceCategory"
    WHEN action IN ('permission.denied', 'tenant.access.denied', 'platform.access.denied', 'runtime_role.operation_prohibited') THEN 'ACCESS_DENIAL'::"ComplianceCategory"
    WHEN action IN ('tenant.created', 'tenant.lifecycle.changed', 'tenant.compliance.decided', 'tenant.profile.updated', 'settings.updated', 'agency.suspended', 'agency.reinstated', 'approval.approved', 'approval.rejected', 'approval.executed', 'approval.execution_failed') THEN 'TENANT_GOVERNANCE'::"ComplianceCategory"
    WHEN action IN ('hotel.exported', 'hotel.report.exported', 'platform.tenants.directory.read', 'compliance.report.exported') THEN 'DATA_EXPORT'::"ComplianceCategory"
    WHEN action IN ('agency.credit_limit.changed', 'funding.declared', 'funding.verified', 'funding.compliance_cleared', 'funding.posted', 'funding.rejected', 'booking.finance.authorized', 'booking.finance.released', 'commercial.markup.activated', 'commercial.markup.retired', 'commercial.fx.activated', 'commercial.fx.retired') THEN 'FINANCIAL_CONTROL'::"ComplianceCategory"
    WHEN action IN ('booking.confirmed', 'booking.cancelled', 'booking.manual.created') THEN 'BOOKING_JURISDICTION'::"ComplianceCategory"
    ELSE NULL
  END
$$ LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp;
