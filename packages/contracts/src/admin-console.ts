/**
 * Admin console access roles (ADR 0108).
 *
 * The Admin UI is not the Agent portal. A valid session is not enough: the caller must hold
 * ADMIN or SUPER_ADMIN on at least one tenant. Tenant `owner` is the existing seed/ops alias for ADMIN.
 * The API remains the authorizer for every permission; these roles only decide who may enter the console.
 */
export const ADMIN_CONSOLE_ROLES = ['ADMIN', 'SUPER_ADMIN'] as const
export type AdminConsoleRole = (typeof ADMIN_CONSOLE_ROLES)[number]

/** Membership.role values that grant ADMIN (tenant operator). */
const ADMIN_ALIASES = new Set(['ADMIN', 'OWNER'])
/** Membership.role values that grant SUPER_ADMIN (platform operator). */
const SUPER_ADMIN_ALIASES = new Set(['SUPER_ADMIN', 'PLATFORM_ADMIN'])

function normalizeMembershipRole(role: string): string {
  return role.trim().toUpperCase().replace(/[\s-]+/g, '_')
}

/** Maps a stored membership role onto the console role, or null when the account must not use Admin. */
export function adminConsoleRole(role: string | null | undefined): AdminConsoleRole | null {
  if (typeof role !== 'string' || role.length === 0) return null
  const normalized = normalizeMembershipRole(role)
  if (SUPER_ADMIN_ALIASES.has(normalized)) return 'SUPER_ADMIN'
  if (ADMIN_ALIASES.has(normalized)) return 'ADMIN'
  return null
}

export function sessionMayUseAdminConsole(memberships: ReadonlyArray<{ role: string }>): boolean {
  return memberships.some((membership) => adminConsoleRole(membership.role) !== null)
}

export function adminConsoleMemberships<M extends { role: string }>(memberships: ReadonlyArray<M>): M[] {
  return memberships.filter((membership) => adminConsoleRole(membership.role) !== null)
}
