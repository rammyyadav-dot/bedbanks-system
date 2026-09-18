import { NextRequest, NextResponse } from 'next/server'
import { portalForHost, portalRedirectUrl } from './lib/portal-routing'
import { siteConfig } from './lib/site-config'

export function proxy(request: NextRequest) {
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? ''
  const rootDomain = new URL(siteConfig.siteUrl).hostname
  const portal = portalForHost(host, rootDomain)
  if (!portal) return NextResponse.next()

  const target = siteConfig.portals[portal]
  const destination = portalRedirectUrl(target, request.nextUrl.pathname, request.nextUrl.search)
  if (!destination || new URL(destination).origin === request.nextUrl.origin) return NextResponse.next()
  return NextResponse.redirect(destination, 307)
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)'] }
