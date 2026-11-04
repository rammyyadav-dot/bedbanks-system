/**
 * A search, recheck or context response belongs to the tenant that was selected when the request started.
 * The offer payload is never a source of tenant identity.
 */
export function shouldApplyTenantResponse(requestedTenant: string, activeTenant: string): boolean {
  return requestedTenant.length > 0 && requestedTenant === activeTenant
}
