import { NextResponse, type NextRequest } from 'next/server'
import { resolveApiDestination } from '../../tools/deployment/runtime-api-proxy.mjs'

// Same-origin API proxy (ADR 0010, ADR 0055). The destination is resolved from API_INTERNAL_URL on EVERY request, so one immutable image
// serves any environment; it is deliberately not a next.config rewrite, which Next.js freezes at build time. The session cookie stays host-only.
export function proxy(request: NextRequest): NextResponse {
  const result = resolveApiDestination(request.nextUrl.pathname, request.nextUrl.search)
  if (result.ok) return NextResponse.rewrite(result.url)
  // Fail closed and observable, with a fixed code (never the configured URL or request data).
  if (result.status === 503) console.error(JSON.stringify({ level: 'error', event: 'portal_api_proxy_unavailable', reason: result.reason }))
  return NextResponse.json({ error: result.reason }, { status: result.status, headers: { 'Cache-Control': 'no-store' } })
}

// Explicit entry so dotted API paths (for example exports) are never skipped.
export const config = { matcher: ['/api/v1', '/api/v1/:path*'] }
