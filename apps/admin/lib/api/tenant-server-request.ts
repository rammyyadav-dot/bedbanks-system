import 'server-only'
import { getSession } from '../auth/session'
import { adminConsoleMemberships } from '../auth/admin-access'
import { readSelectedTenantId } from '../auth/active-tenant'
import { ApiResponseError } from './errors'
import { serverApiRequest } from './server-request'
import { pinActiveTenantHeader, resolveActiveTenantId } from './tenant-context'

function existingHeaders(headers?: HeadersInit): Record<string, string> {
  if (!headers) return {}
  if (headers instanceof Headers) return Object.fromEntries(headers.entries())
  if (Array.isArray(headers)) return Object.fromEntries(headers)
  return { ...headers }
}

/** Tenant id taken only from authenticated ADMIN / SUPER_ADMIN memberships plus the stored selection. */
export async function resolveServerTenantId(): Promise<string> {
  const session = await getSession()
  if (!session) throw new ApiResponseError('UNAUTHENTICATED', 'No session.', 401)
  const allowed = adminConsoleMemberships(session.memberships)
  if (!allowed.length) throw new ApiResponseError('FORBIDDEN', 'Admin console role required.', 403)
  const tenantId = resolveActiveTenantId(allowed, await readSelectedTenantId())
  if (!tenantId) throw new ApiResponseError('FORBIDDEN', 'No active tenant membership.', 403)
  return tenantId
}

/**
 * Server Component fetch for tenant-scoped Admin API routes.
 * Always sends `x-fbeds-tenant-id` from the session-resolved membership; a header on `init` cannot replace it.
 * Platform directory routes must keep using `serverApiRequest` (no tenant header).
 */
export async function tenantScopedServerRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const tenantId = await resolveServerTenantId()
  return serverApiRequest<T>(path, { ...init, headers: pinActiveTenantHeader(existingHeaders(init.headers), tenantId) })
}
