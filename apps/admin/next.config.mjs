import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { portalApiUrl } from '../../tools/deployment/api-url.mjs'

const isDev = process.env.NODE_ENV !== 'production'

// Vercel deployments must point the same-origin API proxy at a real API; local
// and CI builds fall back to the documented development port.
const apiInternalUrl = portalApiUrl()

const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self'${isDev ? ' ws: wss:' : ''}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  ...(isDev ? [] : ['upgrade-insecure-requests']),
].join('; ')

const securityHeaders = [
  { key: 'Content-Security-Policy', value: contentSecurityPolicy },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  ...(isDev ? [] : [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' }]),
]

// Container images (Dockerfile.web) build a self-contained server; Vercel and local builds are unchanged.
const standalone = process.env.NEXT_OUTPUT === 'standalone'

/** @type {import('next').NextConfig} */
const nextConfig = {
  ...(standalone ? { output: 'standalone', outputFileTracingRoot: path.join(path.dirname(fileURLToPath(import.meta.url)), '../..') } : {}),
  images: {
    unoptimized: true,
  },
  transpilePackages: ['@bedbanks/ui', '@bedbanks/contracts'],
  poweredByHeader: false,
  async rewrites() {
    // The session cookie is host-only on the Admin origin, so browser API calls
    // must stay same-origin and be proxied to the API.
    return [{ source: '/api/v1/:path*', destination: `${apiInternalUrl}/:path*` }]
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }]
  },
}

export default nextConfig

