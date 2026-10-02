// Vercel deployments must point the same-origin API proxy at a real API; local
// and CI builds fall back to the documented development port.
if (process.env.VERCEL === '1' && !process.env.API_INTERNAL_URL) {
  throw new Error('API_INTERNAL_URL is required for Vercel deployments of the Agent portal')
}
const apiInternalUrl = (process.env.API_INTERNAL_URL ?? 'http://localhost:3002/api/v1').replace(/\/+$/, '')

/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
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
