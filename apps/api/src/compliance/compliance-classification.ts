/**
 * The one definition of which audit actions are compliance-relevant, and in which category (ADR 0067).
 *
 * Capture happens in the database: an AFTER INSERT trigger on "AuditEvent" calls `fbeds_compliance_category(action)` and, for a classified action,
 * appends an immutable "ComplianceRecord" in the SAME transaction as the audit event. The SQL function is generated from this module
 * (`complianceCategoryFunctionSql`) and a spec fails when the latest migration that defines it differs. To classify a new action, add it here and
 * ship a forward migration with the regenerated function. Every listed action must have a writer in the API source tree (also checked by the spec).
 *
 * Authentication events (login success/failure, logout) are deliberately not classified: they are high volume, carry no tenant and belong to the
 * edge/SIEM pipeline (ADR 0062), not to the per-tenant compliance archive.
 */
export const COMPLIANCE_CATEGORIES = ['RBAC_CHANGE', 'PRIVILEGED_ACCESS', 'ACCESS_DENIAL', 'TENANT_GOVERNANCE', 'DATA_EXPORT', 'FINANCIAL_CONTROL', 'BOOKING_JURISDICTION'] as const
export type ComplianceCategory = (typeof COMPLIANCE_CATEGORIES)[number]

export const COMPLIANCE_CLASSIFICATION: Readonly<Record<ComplianceCategory, readonly string[]>> = {
  /** Who may do what changed: platform roles, their permissions and assignments, tenant memberships, agency membership. */
  RBAC_CHANGE: ['platform.role.created', 'platform.role.updated', 'platform.role.permissions.updated', 'platform.role.assigned', 'platform.role.revoked', 'tenant.membership.changed', 'agency.member.added', 'agency.member.removed'],
  /** Elevated access was used or created: a platform operator entering a tenant, first-owner bootstrap. */
  PRIVILEGED_ACCESS: ['platform.tenant.context.entered', 'bootstrap.platform_owner.provisioned', 'bootstrap.tenant_owner.provisioned'],
  /** An authenticated caller was refused by RBAC, tenant scoping or the database role contract. */
  ACCESS_DENIAL: ['permission.denied', 'tenant.access.denied', 'platform.access.denied', 'runtime_role.operation_prohibited'],
  /** Tenant lifecycle, settings and maker-checker decisions. */
  TENANT_GOVERNANCE: ['tenant.created', 'tenant.lifecycle.changed', 'tenant.compliance.decided', 'tenant.profile.updated', 'settings.updated', 'agency.suspended', 'agency.reinstated', 'approval.approved', 'approval.rejected', 'approval.executed', 'approval.execution_failed'],
  /** Data left the system in bulk: exports and cross-tenant directory reads. */
  DATA_EXPORT: ['hotel.exported', 'hotel.report.exported', 'platform.tenants.directory.read', 'compliance.report.exported'],
  /** Credit, funding, booking money release and pricing controls. */
  FINANCIAL_CONTROL: ['agency.credit_limit.changed', 'funding.declared', 'funding.verified', 'funding.compliance_cleared', 'funding.posted', 'funding.rejected', 'booking.finance.authorized', 'booking.finance.released', 'commercial.markup.activated', 'commercial.markup.retired', 'commercial.fx.activated', 'commercial.fx.retired'],
  /** Booking lifecycle facts; the trigger records the buyer (agency) and destination (hotel) countries and whether they differ. */
  BOOKING_JURISDICTION: ['booking.confirmed', 'booking.cancelled', 'booking.manual.created'],
}

/** Actions whose literal never appears in the source because the writer builds them (`approval.${decision}`); the spec allows them by this list. */
export const TEMPLATED_COMPLIANCE_ACTIONS: readonly string[] = ['approval.approved', 'approval.rejected']

export function complianceCategoryOf(action: string): ComplianceCategory | null {
  for (const category of COMPLIANCE_CATEGORIES) if (COMPLIANCE_CLASSIFICATION[category].includes(action)) return category
  return null
}

/** The SQL classifier the capture trigger calls. Generated: never edit the migration copy by hand. */
export function complianceCategoryFunctionSql(): string {
  const arms = COMPLIANCE_CATEGORIES.map((category) => `    WHEN action IN (${COMPLIANCE_CLASSIFICATION[category].map((a) => `'${a}'`).join(', ')}) THEN '${category}'::"ComplianceCategory"`)
  return [
    'CREATE OR REPLACE FUNCTION "fbeds_compliance_category"(action TEXT) RETURNS "ComplianceCategory" AS $$',
    '  SELECT CASE',
    ...arms,
    '    ELSE NULL',
    '  END',
    '$$ LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp;',
  ].join('\n')
}
