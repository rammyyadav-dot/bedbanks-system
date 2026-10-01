import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // The demo form is the only Server Action; its payload is a few KB at most. Next's default is 1 MB.
  experimental: { serverActions: { bodySizeLimit: '32kb' } },
  async headers() {
    const headers = [{ key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' }, { key: 'X-Content-Type-Options', value: 'nosniff' }, { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' }, { key: 'X-Frame-Options', value: 'DENY' }]
    if (process.env.NODE_ENV === 'production') headers.push({ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' })
    return [{ source: '/(.*)', headers }]
  },
}

export default nextConfig
