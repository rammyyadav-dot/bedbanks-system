import type { MembershipSummary } from './auth-client'

/**
 * Active-tenant selection for browser API calls.
 *
 * The supply API requires `x-fbeds-tenant-id` (same contract as the Agent portal). The value is only a *request*:
 * the API's TenantContextGuard re-validates it against the authenticated user's membership and RLS on every call,
 * so a forged value gains nothing. The default mirrors the API's own admin choice: owner membership, else the first.
 */
export function pickActiveTenantId(memberships: ReadonlyArray<Pick<MembershipSummary, 'tenantId' | 'role'>>): string | null {
  return (memberships.find((membership) => membership.role === 'owner') ?? memberships[0])?.tenantId ?? null
}

let activeTenantId: string | null = null
export function setActiveTenantId(tenantId: string | null) { activeTenantId = tenantId }
export function activeTenantHeaders(): Record<string, string> { return activeTenantId ? { 'x-fbeds-tenant-id': activeTenantId } : {} }

/**
 * The tenant the shell should use: the caller's stored selection when it is still one of their memberships,
 * otherwise the default. A stale, tampered or foreign value is never honoured, it just falls back.
 */
export function resolveActiveTenantId(memberships: ReadonlyArray<Pick<MembershipSummary, 'tenantId' | 'role'>>, selected?: string | null): string | null {
  if (selected && memberships.some((membership) => membership.tenantId === selected)) return selected
  return pickActiveTenantId(memberships)
}

/** The membership whose tenant is active for API calls, so every label in the shell matches the tenant actually in use. */
export function activeMembership<M extends Pick<MembershipSummary, 'tenantId' | 'role'>>(memberships: ReadonlyArray<M>, selected?: string | null): M | null {
  const tenantId = resolveActiveTenantId(memberships, selected)
  return memberships.find((membership) => membership.tenantId === tenantId) ?? null
}
