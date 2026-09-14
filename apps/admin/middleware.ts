import { NextResponse, type NextRequest } from 'next/server';

const COOKIE_NAME = process.env.AUTH_COOKIE_NAME ?? 'fbeds_session';

// Routes that don't require authentication
const PUBLIC_ROUTES = ['/login'];

export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  // Allow public routes through immediately
  if (PUBLIC_ROUTES.some((route) => pathname.startsWith(route))) {
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
  // Middleware can only check cookie *presence* — it cannot call the
  // API to validate the session (that would make every request wait
  // for a DB round-trip in the middleware layer, and Next.js edge
  // middleware has network restrictions anyway). The actual session
  // validity check happens in getSession()/requireSession() in each
  // Server Component or layout that needs the identity.
  //
  // This is a correct split: middleware handles routing (redirect if
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
