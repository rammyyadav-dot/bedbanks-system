import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  async headers() {
    const directives = ["default-src 'self'", "base-uri 'self'", "object-src 'none'", "frame-ancestors 'none'", "form-action 'self'", "img-src 'self' data: blob:", "font-src 'self' data:", "style-src 'self' 'unsafe-inline'", `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : ''} https://va.vercel-scripts.com`, "connect-src 'self' https://vitals.vercel-insights.com https://*.vercel-insights.com"]
    if (process.env.NODE_ENV === 'production') directives.push('upgrade-insecure-requests')
    const headers = [{ key: 'Content-Security-Policy', value: directives.join('; ') }, { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' }, { key: 'X-Content-Type-Options', value: 'nosniff' }, { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' }, { key: 'X-Frame-Options', value: 'DENY' }]
    if (process.env.NODE_ENV === 'production') headers.push({ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' })
    return [{ source: '/(.*)', headers }]
  },
}

export default nextConfig
