import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { portalApiUrl } from '../../tools/deployment/api-url.mjs'

const apiInternalUrl = portalApiUrl()

// Container images (Dockerfile.web) build a self-contained server; Vercel and local builds are unchanged.
const standalone = process.env.NEXT_OUTPUT === 'standalone'

/** @type {import('next').NextConfig} */
const nextConfig = {
  ...(standalone ? { output: 'standalone', outputFileTracingRoot: path.join(path.dirname(fileURLToPath(import.meta.url)), '../..') } : {}),
  async redirects() {
    return [
      ['/properties', '/hotels'],
      ['/properties/:path*', '/hotels/:path*'],
      ['/rooms-content', '/rooms'],
      ['/contracts-rate-plans', '/contracts'],
      ['/availability-inventory', '/availability'],
      ['/rate-plans', '/rates'],
      ['/cancellations', '/bookings'],
      ['/payments', '/invoices'],
      ['/users', '/team'],
      ['/profile', '/supplier-profile'],
    ].map(([source, destination]) => ({ source, destination, permanent: false }))
  },
  async rewrites() {
    return [{ source: '/api/v1/:path*', destination: `${apiInternalUrl}/:path*` }]
  },
}

export default nextConfig

