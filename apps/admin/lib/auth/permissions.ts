export type AdminPermission =
  | 'dashboard.read' | 'bookings.read' | 'bookings.manage' | 'hotels.read' | 'hotels.manage'
  | 'suppliers.read' | 'suppliers.manage' | 'contracts.read' | 'contracts.manage'
  | 'inventory.read' | 'inventory.manage' | 'rates.read' | 'rates.manage'
  | 'pricing.read' | 'pricing.manage' | 'finance.read' | 'finance.manage'
  | 'users.read' | 'users.manage' | 'roles.read' | 'roles.manage' | 'audit.read' | 'settings.manage'

export interface PermissionAwareIdentity { permissions?: readonly string[] }

/** UX hint only. NestJS guards remain the real authorization boundary. */
export function can(identity: PermissionAwareIdentity | null | undefined, permission: AdminPermission): boolean {
  return Boolean(identity?.permissions?.includes(permission))
}
