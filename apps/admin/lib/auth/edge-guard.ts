/**
 * Edge / proxy decisions for the Admin console (ADR 0108).
 *
 * Cookie *presence* is not authentication. The opaque session token is 32 CSPRNG bytes,
 * hex-encoded (ADR 0001). A missing or malformed cookie is sent to /login. Validity and
 * ADMIN / SUPER_ADMIN membership are checked in requireAdminSession() against GET /auth/me.
 */
export const ADMIN_PUBLIC_PATHS = ['/login'] as const
export const OPAQUE_SESSION_TOKEN = /^[a-f0-9]{64}$/

export function isAdminPublicPath(pathname: string): boolean {
  return ADMIN_PUBLIC_PATHS.some((route) => pathname === route || pathname.startsWith(`${route}/`))
}

export function isStaticOrFrameworkPath(pathname: string): boolean {
  return pathname.startsWith('/_next') || pathname.startsWith('/favicon') || pathname.startsWith('/api')
}

export function isWellFormedSessionToken(value: string | undefined | null): boolean {
  return typeof value === 'string' && OPAQUE_SESSION_TOKEN.test(value)
}

export type AdminEdgeDecision = 'public' | 'static' | 'allow' | 'login'

export function decideAdminEdgeAccess(input: { pathname: string; sessionCookie: string | undefined }): AdminEdgeDecision {
  if (isAdminPublicPath(input.pathname)) return 'public'
  if (isStaticOrFrameworkPath(input.pathname)) return 'static'
  return isWellFormedSessionToken(input.sessionCookie) ? 'allow' : 'login'
}
