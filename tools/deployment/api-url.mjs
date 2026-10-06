/** Resolve only the API prefix used by the portal same-origin rewrites. */
export function portalApiUrl(env = process.env) {
  // Hosted means any real deployment: Vercel (VERCEL=1) or the container images (PORTAL_HOSTED=1, set by Dockerfile.web).
  const hosted = env.VERCEL === '1' || env.PORTAL_HOSTED === '1'
  const value = env.API_INTERNAL_URL?.trim()
  if (hosted && !value) throw new Error('API_INTERNAL_URL is required for hosted portal deployments')
  const candidate = value || 'http://localhost:3002/api/v1'
  let url
  try { url = new URL(candidate) } catch { throw new Error('API_INTERNAL_URL must be a valid absolute URL') }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  const local = hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '::1' || hostname === '0.0.0.0' || hostname.startsWith('127.') || hostname.startsWith('::ffff:127.') || hostname.startsWith('::ffff:7f')
  if (!['http:', 'https:'].includes(url.protocol) || (hosted && (url.protocol !== 'https:' || local))) {
    throw new Error('API_INTERNAL_URL must use HTTPS and a non-loopback host on hosted portals')
  }
  if (url.username || url.password || url.search || url.hash) throw new Error('API_INTERNAL_URL must not contain credentials, query parameters or fragments')
  if (url.pathname.replace(/\/+$/, '') !== '/api/v1') throw new Error('API_INTERNAL_URL must end in exactly /api/v1')
  return `${url.origin}/api/v1`
}
