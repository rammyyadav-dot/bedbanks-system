if (process.env.VERCEL === '1' && !process.env.API_INTERNAL_URL) {
  throw new Error('API_INTERNAL_URL is required for Vercel deployments of the supplier extranet')
}
const apiInternalUrl = (process.env.API_INTERNAL_URL ?? 'http://localhost:3002/api/v1').replace(/\/+$/, '')

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
