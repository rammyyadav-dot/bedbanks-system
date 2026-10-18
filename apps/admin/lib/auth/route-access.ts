import { flatNav } from '@/components/layout/nav-config'
import type { CapabilityStatus } from './capability-policy'

/**
 * Central route guard decision (UX only; the API remains the authorizer).
 * The required permission for a route comes from the single department catalogue in `@bedbanks/contracts`
 * (via the navigation), so a page cannot be reachable by URL that the sidebar hides for the same caller.
 * Routes with no declared permission are not gated here; their API calls enforce access.
 */
export type RouteAccess = 'allow' | 'checking' | 'unavailable' | 'denied'

export function requiredPermissionFor(pathname: string | null): string | null {
  if (!pathname) return null
  const match = flatNav
    .filter((item) => pathname === item.href || pathname.startsWith(`${item.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0]
  return match?.requires ?? null
}

export function resolveRouteAccess(pathname: string | null, status: CapabilityStatus, can: (permission: never) => boolean): RouteAccess {
  const required = requiredPermissionFor(pathname)
  if (!required) return 'allow'
  if (status === 'loading') return 'checking'
  if (status === 'error') return 'unavailable'
  return can(required as never) ? 'allow' : 'denied'
}
