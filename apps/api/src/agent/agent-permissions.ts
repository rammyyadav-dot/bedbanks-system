import { PERMISSIONS, type AgentPermission } from './supplier.port'

/** Agent permissions this portal is allowed to introspect. Not an authorization decision by itself. */
export const AGENT_PERMISSION_KEYS: readonly AgentPermission[] = Object.values(PERMISSIONS)

/**
 * Canonical grant rule shared with AgentRbacGuard.
 * Formal role permissions win. The legacy owner membership grants every Agent permission.
 * A finance membership grants only finance.read unless a formal role adds more.
 */
export function membershipGrantsPermission(membershipRole: string, formalKeys: readonly string[], required: AgentPermission): boolean {
  if (formalKeys.includes(required)) return true
  if (membershipRole === 'owner') return true
  return required === PERMISSIONS.viewFinance && membershipRole === 'finance'
}

/** Effective Agent grants for one membership. Platform roles are not consulted. */
export function effectiveAgentPermissions(membershipRole: string, formalKeys: readonly string[]): AgentPermission[] {
  return AGENT_PERMISSION_KEYS.filter((permission) => membershipGrantsPermission(membershipRole, formalKeys, permission))
}
