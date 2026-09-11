import { NextRequest, NextResponse } from 'next/server'

const portalRoutes: Record<string, string> = { portal: '/agent', suppliers: '/supplier', ops: '/admin' }

function getHost(request: NextRequest) {
  return (request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? '').split(',')[0].trim().split(':')[0].toLowerCase()
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  if (pathname.startsWith('/_next') || pathname.startsWith('/api') || pathname === '/favicon.ico' || pathname === '/robots.txt' || pathname === '/sitemap.xml' || pathname.startsWith('/agent') || pathname.startsWith('/supplier') || pathname.startsWith('/admin')) return NextResponse.next()
  const host = getHost(request)
  const rootDomain = (process.env.FBEDS_ROOT_DOMAIN ?? 'fbeds-website.vercel.app').toLowerCase()
  const localMatch = host.match(/^([a-z0-9-]+)\.(?:localhost|127\.0\.0\.1)$/)
  const deployedMatch = host.endsWith(`.${rootDomain}`) ? host.slice(0, -(`.${rootDomain}`).length).split('.').pop() : undefined
  const subdomain = localMatch?.[1] ?? deployedMatch
  const destination = subdomain ? portalRoutes[subdomain] : undefined
  if (!destination) return NextResponse.next()
  const url = request.nextUrl.clone()
  url.pathname = destination
  return NextResponse.rewrite(url)
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] }
