/** Platform permissions never follow from tenant ownership. */
export const tenantControlPermissions = ['platform.tenants.read', 'platform.tenants.access', 'platform.tenants.create', 'platform.tenants.manage', 'platform.tenants.memberships.manage', 'platform.tenants.lifecycle.request', 'platform.tenants.lifecycle.approve', 'platform.tenants.compliance.approve', 'platform.tenants.audit.read'] as const
export type TenantControlPermission = typeof tenantControlPermissions[number]
export interface TenantBusiness {
  name: string; tradingName?: string; classification: 'BUYER' | 'SUPPLIER' | 'HYBRID'; country: string
  address: string; city: string; province?: string; postalCode?: string; website?: string
  businessEmail: string; phone?: string; registrationNumber: string; taxNumber?: string
  currency: string; markets: string[]; channels: string[]; markupPolicyReference?: string
  financeReviewed: boolean
}
export interface TenantDirectoryRow {
  id: string; name: string; slug: string; status: 'ACTIVE' | 'SUSPENDED'; createdAt: string
  profile: { classification: string; country: string; stage: string } | null
  members: number | null; lastActivity: string | null
}
export interface TenantDirectory {
  items: TenantDirectoryRow[]; total: number; page: number; pageSize: number
  metrics: { total: number; active: number; pendingReview: number | null; suspended: number; newThisMonth: number; incomplete: number | null }
  permissions: TenantControlPermission[]; authoringConfigured: boolean
}
export interface TenantControlDetail {
  platformContext: { permission: 'platform.tenants.access'; targetTenantId: string }
  tenant: { id: string; name: string; slug: string; status: 'ACTIVE' | 'SUSPENDED'; createdAt: string }
  profile: { business: TenantBusiness; stage: string; complianceStatus: string; version: number } | null
  counts: Record<string, number | null>
  readiness: { key: string; label: string; ready: boolean; remediation: string }[]
  permissions: TenantControlPermission[]
  memberships: { id: string; role: string; revokedAt: string | null; user: { id: string; name: string | null; email: string; lastLoginAt: string | null }; permissions: string[] }[]
  approvals: { id: string; status: string; reason: string; requestedById: string; proposedState: unknown; createdAt: string }[]
  commercial: { contracts: number; restrictions: number; markupPolicies: number; supplierConnections: number }
  finance: { status: 'not_readable'; message: string }
  settings: { supportEmail: string | null; defaultLanguage: string; timeZone: string; defaultCurrency: string; lowBalanceThreshold: { amountMinor: string; currency: string } } | null
}
