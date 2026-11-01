import { NextResponse, type NextRequest } from 'next/server';
import { resolveApiDestination } from '../../tools/deployment/runtime-api-proxy.mjs';

const COOKIE_NAME = process.env.AUTH_COOKIE_NAME ?? 'fbeds_session';

// Routes that don't require authentication
const PUBLIC_ROUTES = ['/login'];

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

  // Allow public routes through immediately
  if (PUBLIC_ROUTES.some((route) => pathname === route || pathname.startsWith(`${route}/`))) {
    return NextResponse.next();
  }

  // Static files and Next.js internals — never needs auth
  if (
    pathname.startsWith('/_next') ||
    pathname.startsWith('/favicon') ||
    pathname.startsWith('/api')
  ) {
    return NextResponse.next();
  }

  // All other routes require a session cookie.
  // Proxy can only check cookie *presence* — it cannot call the
  // API to validate the session (that would make every request wait
  // for a DB round-trip in the proxy layer). The actual session
  // validity check happens in getSession()/requireSession() in each
  // Server Component or layout that needs the identity.
  //
  // This is a correct split: proxy handles routing (redirect if
  // obviously not authed), server components handle identity (validate
  // and get the actual user). An expired/invalid cookie will reach the
  // page, getSession() will return null, and the page will redirect.
  const hasSessionCookie = request.cookies.has(COOKIE_NAME);

  if (!hasSessionCookie) {
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
