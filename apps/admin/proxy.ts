import { NextResponse, type NextRequest } from 'next/server';
import { resolveApiDestination } from '../../tools/deployment/runtime-api-proxy.mjs';
import { decideAdminEdgeAccess } from './lib/auth/edge-guard';

const COOKIE_NAME = process.env.AUTH_COOKIE_NAME ?? 'fbeds_session';

export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  // Same-origin API proxy (ADR 0010, ADR 0055): resolved from API_INTERNAL_URL on every request so one immutable image serves any
  // environment. Authentication is enforced by the API itself; the cookie stays host-only on this origin.
  if (pathname === '/api/v1' || pathname.startsWith('/api/v1/')) {
    const result = resolveApiDestination(pathname, request.nextUrl.search);
    if (result.ok) return NextResponse.rewrite(result.url);
    if (result.status === 503) console.error(JSON.stringify({ level: 'error', event: 'portal_api_proxy_unavailable', reason: result.reason }));
    return NextResponse.json({ error: result.reason }, { status: result.status, headers: { 'Cache-Control': 'no-store' } });
  }

  // Edge gate (ADR 0108): require a well-formed opaque session token, not merely a cookie name.
  // The API validates the token on GET /auth/me; requireAdminSession() in the dashboard layout
  // refuses expired sessions and non-ADMIN / SUPER_ADMIN memberships.
  const decision = decideAdminEdgeAccess({ pathname, sessionCookie: request.cookies.get(COOKIE_NAME)?.value });
  if (decision === 'login') {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('from', pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // Explicit entry: the pattern below skips any path containing a dot, which would let dotted API paths (exports) bypass the proxy.
    '/api/v1',
    '/api/v1/:path*',
    /*
     * Match all paths except:
     * - _next/static (static assets)
     * - _next/image  (image optimisation)
     * - favicon.ico
     * - Any file with an extension (e.g. .svg, .png, .js)
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)',
  ],
};
