import path from 'node:path'
import type { NextConfig } from 'next'

// Container images (Dockerfile.web) build a self-contained server; Vercel and local builds are unchanged.
const standalone = process.env.NEXT_OUTPUT === 'standalone'

const nextConfig: NextConfig = {
  ...(standalone ? { output: 'standalone' as const, outputFileTracingRoot: path.join(process.cwd(), '../..') } : {}),
  // The demo form is the only Server Action; its payload is a few KB at most. Next's default is 1 MB.
  experimental: { serverActions: { bodySizeLimit: '32kb' } },
  // Routes retired in the fabbeds copy refresh; permanent so inbound links and search results keep working.
  async redirects() {
    return [
      { source: '/solutions/hotels', destination: '/hotels-suppliers', permanent: true },
      { source: '/solutions/dmcs', destination: '/hotels-suppliers', permanent: true },
      { source: '/solutions/travel-agencies', destination: '/travel-buyers', permanent: true },
      { source: '/solutions/tour-operators', destination: '/travel-buyers', permanent: true },
      { source: '/solutions/travel-technology', destination: '/connectivity', permanent: true },
      { source: '/solutions', destination: '/how-it-works', permanent: true },
      { source: '/platform', destination: '/how-it-works', permanent: true },
      { source: '/inventory', destination: '/how-it-works', permanent: true },
      { source: '/resources', destination: '/how-it-works', permanent: true },
    ]
  },
  async headers() {
    const headers = [{ key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' }, { key: 'X-Content-Type-Options', value: 'nosniff' }, { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' }, { key: 'X-Frame-Options', value: 'DENY' }]
    if (process.env.NODE_ENV === 'production') headers.push({ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' })
    return [{ source: '/(.*)', headers }]
  },
}

export default nextConfig
