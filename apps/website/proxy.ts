import { NextRequest, NextResponse } from 'next/server'
import { buildContentSecurityPolicy, generateNonce } from './lib/csp'
import { portalForHost, portalRedirectUrl } from './lib/portal-routing'
import { siteConfig } from './lib/site-config'

export function proxy(request: NextRequest) {
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? ''
  const rootDomain = new URL(siteConfig.siteUrl).hostname
  const portal = portalForHost(host, rootDomain)
  if (portal) {
    const target = siteConfig.portals[portal]
    const destination = portalRedirectUrl(target, request.nextUrl.pathname, request.nextUrl.search)
    if (destination && new URL(destination).origin !== request.nextUrl.origin) return NextResponse.redirect(destination, 307)
  }

  // Per-request nonce: Next.js reads it from the request CSP header while rendering and applies it
  // to framework scripts and inline styles. Pages must render dynamically (see app/layout.tsx).
  const nonce = generateNonce()
  const policy = buildContentSecurityPolicy({ nonce, development: process.env.NODE_ENV === 'development' })
  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('x-nonce', nonce)
  requestHeaders.set('Content-Security-Policy', policy)
  const response = NextResponse.next({ request: { headers: requestHeaders } })
  response.headers.set('Content-Security-Policy', policy)
  // The HTML now embeds a per-request nonce, so no shared cache may store it.
  response.headers.set('Cache-Control', 'private, no-store, max-age=0, must-revalidate')
  return response
}

// HTML documents only: skip build assets and metadata routes that never carry a nonce.
export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|manifest.webmanifest|icon|apple-icon|opengraph-image).*)'] }
