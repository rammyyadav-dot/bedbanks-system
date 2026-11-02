import {
  adminConsoleMemberships,
  adminConsoleRole,
  sessionMayUseAdminConsole,
  type AdminConsoleRole,
} from '@bedbanks/contracts'

export { adminConsoleMemberships, adminConsoleRole, sessionMayUseAdminConsole }
export type { AdminConsoleRole }

/** Highest console role across memberships, SUPER_ADMIN winning. Null means the session must not enter Admin. */
export function highestAdminConsoleRole(memberships: ReadonlyArray<{ role: string }>): AdminConsoleRole | null {
  const roles = new Set(memberships.map((membership) => adminConsoleRole(membership.role)).filter((role): role is AdminConsoleRole => role !== null))
  if (roles.has('SUPER_ADMIN')) return 'SUPER_ADMIN'
  if (roles.has('ADMIN')) return 'ADMIN'
  return null
}
