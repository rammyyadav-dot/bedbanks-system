import { portalApiUrl } from '../../tools/deployment/api-url.mjs'

const apiInternalUrl = portalApiUrl()

/** @type {import('next').NextConfig} */
const nextConfig = {
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

