/**
 * Browser mutation gate (UX only; the API re-checks every permission and the tenant).
 *
 * An unsafe request is sent only after capabilities for the active tenant have loaded.
 * Loading, a failed load, a tenant switch, and a missing declared permission send nothing.
 */

export type BrowserAuthStatus = 'loading' | 'ready' | 'error'

export interface BrowserAuthGate {
  status: BrowserAuthStatus
  tenantId: string | null
  permissions: ReadonlySet<string>
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

const closed: BrowserAuthGate = { status: 'loading', tenantId: null, permissions: new Set() }
let gate: BrowserAuthGate = closed

export function publishBrowserAuthGate(next: BrowserAuthGate): void {
  gate = next
}

export function readBrowserAuthGate(): BrowserAuthGate {
  return gate
}

/** Null when the request may be sent. Otherwise a message that states nothing was changed. */
export function mutationBlockedReason(method: string | undefined, permission?: string): string | null {
  if (!UNSAFE.has((method ?? 'GET').toUpperCase())) return null
  if (gate.status !== 'ready' || gate.tenantId == null) {
    return 'Your permissions are not confirmed for this workspace. Nothing was changed.'
  }
  if (permission && !gate.permissions.has(permission)) {
    return 'You do not have permission to make this change. Nothing was changed.'
  }
  return null
}
