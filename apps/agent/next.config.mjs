import { portalApiUrl } from '../../tools/deployment/api-url.mjs'

// Vercel deployments must point the same-origin API proxy at a real API; local
// and CI builds fall back to the documented development port.
const apiInternalUrl = portalApiUrl()

/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    unoptimized: true,
  },
  transpilePackages: ['@bedbanks/ui', '@bedbanks/contracts'],
  async rewrites() {
    // The session cookie is host-only on the Agent origin, so browser API calls
    // stay same-origin and are proxied to the API (ADR 0010).
    return [{ source: '/api/v1/:path*', destination: `${apiInternalUrl}/:path*` }]
  },
}

export default nextConfig

