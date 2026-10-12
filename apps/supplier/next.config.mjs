import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The /api/v1 proxy lives in proxy.ts and reads API_INTERNAL_URL per request (ADR 0055), so nothing about the API origin is baked at build time.

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
}

export default nextConfig

