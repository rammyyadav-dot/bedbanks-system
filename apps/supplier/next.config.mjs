/** @type {import('next').NextConfig} */
const nextConfig = {
  async redirects() {
    return [
      ['/properties', '/hotels'], ['/properties/:path*', '/hotels/:path*'],
      ['/rooms-content', '/rooms'], ['/contracts-rate-plans', '/contracts'],
      ['/availability-inventory', '/availability'], ['/finance', '/invoices'],
      ['/connectivity', '/reports'], ['/team', '/reports'], ['/support', '/reports'], ['/settings', '/reports'],
      ['/profile', '/reports'], ['/rate-plans', '/rates'], ['/cancellations', '/bookings'],
      ['/payments', '/invoices'], ['/users', '/reports'],
    ].map(([source, destination]) => ({ source, destination, permanent: false }))
  },
}

export default nextConfig
