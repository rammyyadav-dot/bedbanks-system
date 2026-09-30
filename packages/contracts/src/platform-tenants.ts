export type PlatformTenantStatus = 'ACTIVE' | 'SUSPENDED'

export interface PlatformTenantView {
  id: string
  name: string
  slug: string
  status: PlatformTenantStatus
  createdAt: string
}

export interface PlatformTenantSummaryView {
  tenant: PlatformTenantView
  counts: { memberships: number; bookings: number }
  platformContext: { permission: string; targetTenantId: string }
}
