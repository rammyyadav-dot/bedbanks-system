import 'server-only'

import { cache } from 'react'
import { cookies } from 'next/headers'
import { SupplierApiError, listOrganizations, loadContext, loadIdentity, type PortalUser, type SupplierOrganization } from './supplier-api'
import { SUPPLIER_CONTEXT_COOKIE } from './server-env'

export type PortalState =
  | { kind: 'anonymous' }
  | { kind: 'unavailable'; user: PortalUser; message: string }
  | { kind: 'ambiguous-tenant'; user: PortalUser }
  | { kind: 'choose-organization'; user: PortalUser; organizations: SupplierOrganization[] }
  | { kind: 'ready'; user: PortalUser; organizations: SupplierOrganization[]; organization: SupplierOrganization | null; permissions: string[] }

export const loadPortal = cache(async (): Promise<PortalState> => {
  try {
    const identity = await loadIdentity()
    if (!identity) return { kind: 'anonymous' }
    if ('ambiguous' in identity) return { kind: 'ambiguous-tenant', user: identity.user }
    const organizations = await listOrganizations()
    if (organizations.length === 0) {
      return { kind: 'ready', user: identity.user, organizations, organization: null, permissions: [] }
    }
    const cookieStore = await cookies()
    const selected = organizations.length === 1 ? organizations[0].supplierId : cookieStore.get(SUPPLIER_CONTEXT_COOKIE)?.value
    if (!selected) return { kind: 'choose-organization', user: identity.user, organizations }
    try {
      const context = await loadContext(selected)
      return { kind: 'ready', user: identity.user, organizations, organization: context.organization, permissions: context.permissions }
    } catch (error) {
      if (error instanceof SupplierApiError && error.status === 403) {
        return { kind: 'choose-organization', user: identity.user, organizations }
      }
      throw error
    }
  } catch (error) {
    if (error instanceof SupplierApiError && error.status === 401) return { kind: 'anonymous' }
    return {
      kind: 'unavailable',
      user: { id: '', email: '', name: null },
      message: 'The supplier workspace cannot be loaded because the API request failed. No preview data is shown.',
    }
  }
})
