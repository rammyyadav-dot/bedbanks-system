import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { portalApiUrl } from '../../tools/deployment/api-url.mjs'

// Vercel deployments must point the same-origin API proxy at a real API; local
// and CI builds fall back to the documented development port.
const apiInternalUrl = portalApiUrl()

// Container images (Dockerfile.web) build a self-contained server; Vercel and local builds are unchanged.
const standalone = process.env.NEXT_OUTPUT === 'standalone'

/** @type {import('next').NextConfig} */
const nextConfig = {
  ...(standalone ? { output: 'standalone', outputFileTracingRoot: path.join(path.dirname(fileURLToPath(import.meta.url)), '../..') } : {}),
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

