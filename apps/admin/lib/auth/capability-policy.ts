/**
 * Pure capability-gating policy for the admin shell (UX only; the API re-checks every permission).
 *
 * Fail-closed: a control is shown only once the caller's permissions for the *active tenant* have loaded.
 * Loading, failed, or tenant-mismatched state grants nothing, so no privileged control renders before the
 * session/tenant is synchronised and a failed fetch never widens what the UI offers.
 */
export type CapabilityStatus = 'loading' | 'ready' | 'error'
export interface CapabilityState { status: CapabilityStatus; tenantId: string | null; permissions: ReadonlySet<string> }

export const loadingCapabilities = (tenantId: string | null): CapabilityState => ({ status: 'loading', tenantId, permissions: new Set() })

export function isAllowed(state: CapabilityState, activeTenantId: string | null, permission: string): boolean {
  return state.status === 'ready' && state.tenantId === activeTenantId && state.permissions.has(permission)
}
