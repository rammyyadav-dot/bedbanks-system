/** @type {import('next').NextConfig} */
const nextConfig = {
  async redirects() {
    return [
      ['/profile', '/settings'], ['/rooms', '/rooms-content'], ['/rate-plans', '/contracts-rate-plans'], ['/rates', '/contracts-rate-plans'], ['/contracts', '/contracts-rate-plans'], ['/promotions', '/contracts-rate-plans'], ['/availability', '/availability-inventory'], ['/restrictions', '/availability-inventory'], ['/cancellations', '/bookings'], ['/payments', '/finance'], ['/reports', '/finance'], ['/users', '/team'],
    ].map(([source, destination]) => ({ source, destination, permanent: false }))
  },
}

export default nextConfig
