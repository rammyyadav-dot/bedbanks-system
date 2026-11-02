import { TENANT_MEMBERSHIP_ACTIONS, type TenantControlPermission, type TenantDirectory } from '@bedbanks/contracts'

export type TenantLifecycleFilter = '' | 'ACTIVE' | 'SUSPENDED' | 'REVIEW'

export const TENANT_LIFECYCLE_FILTERS: Array<{ value: TenantLifecycleFilter; label: string }> = [
  { value: '', label: 'All statuses' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'SUSPENDED', label: 'Suspended' },
  { value: 'REVIEW', label: 'Pending approval' },
]

export const MEMBERSHIP_ROLE_LABEL: Record<(typeof TENANT_MEMBERSHIP_ACTIONS)[number], string> = {
  owner: 'Tenant administrator',
  member: 'Tenant member',
  revoke: 'Revoke membership',
}

export function tenantPath(id: string): string {
  return `/tenants/${encodeURIComponent(id)}`
}

export function tenantUsersPath(id: string): string {
  return `${tenantPath(id)}/users`
}

export function tenantApiPath(route: string, tenantId: string, extra: Record<string, string> = {}): string {
  let path = route.replace(':tenantId', encodeURIComponent(tenantId))
  for (const [key, value] of Object.entries(extra)) path = path.replace(`:${key}`, encodeURIComponent(value))
  return path
}

export function tenantDirectoryQuery(filters: {
  search: string
  lifecycle: TenantLifecycleFilter
  classification: string
  country: string
  createdFrom: string
  createdTo: string
  sort: string
  order: string
  page: number
}): URLSearchParams {
  const query = new URLSearchParams()
  if (filters.search.trim()) query.set('search', filters.search.trim())
  if (filters.lifecycle === 'REVIEW') query.set('stage', 'REVIEW')
  else if (filters.lifecycle === 'ACTIVE' || filters.lifecycle === 'SUSPENDED') query.set('status', filters.lifecycle)
  if (filters.classification) query.set('classification', filters.classification)
  if (filters.country) query.set('country', filters.country)
  if (filters.createdFrom) query.set('createdFrom', filters.createdFrom)
  if (filters.createdTo) query.set('createdTo', filters.createdTo)
  if (filters.sort) query.set('sort', filters.sort)
  if (filters.order) query.set('order', filters.order)
  query.set('page', String(filters.page))
  return query
}

export function tenantLifecycleLabel(status: 'ACTIVE' | 'SUSPENDED', stage: string | null | undefined): string {
  if (stage === 'REVIEW') return 'Pending approval'
  return status === 'ACTIVE' ? 'Active' : 'Suspended'
}

export function tenantLifecycleClass(status: 'ACTIVE' | 'SUSPENDED', stage: string | null | undefined): string {
  if (stage === 'REVIEW') return 'review'
  return status.toLowerCase()
}

export function membershipRoleLabel(role: string): string {
  if (role === 'owner' || role === 'member' || role === 'revoke') return MEMBERSHIP_ROLE_LABEL[role]
  return role
}

/**
 * Display-only access summary from canonical membership + formal permission keys.
 * This is not an assignable AGENCY_* enum; agent-portal authority is the intersection of
 * an active membership and formal UserRole keys.
 */
export function agencyAccessLabels(role: string, revokedAt: string | null, permissions: readonly string[]): string[] {
  if (revokedAt) return ['Revoked']
  const labels: string[] = []
  if (role === 'owner') labels.push('Agency administration')
  if (permissions.some((key) => key === 'booking.read' || key.startsWith('booking.'))) labels.push('Booking')
  if (permissions.some((key) => key === 'finance.read' || key.startsWith('finance.') || key === 'funding.manage')) labels.push('Finance')
  return labels.length ? labels : ['Membership only']
}

export function canCreateTenant(directory: Pick<TenantDirectory, 'authoringConfigured' | 'permissions'>): boolean {
  const required: TenantControlPermission[] = ['platform.tenants.create', 'platform.tenants.memberships.manage']
  return directory.authoringConfigured && required.every((permission) => directory.permissions.includes(permission))
}
