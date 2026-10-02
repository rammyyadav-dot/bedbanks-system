export type WebsiteEnvironment = {
  NODE_ENV?: string
  NEXT_PUBLIC_SITE_URL?: string
  NEXT_PUBLIC_AGENT_URL?: string
  NEXT_PUBLIC_SUPPLIER_URL?: string
  NEXT_PUBLIC_ADMIN_URL?: string
  NEXT_PUBLIC_CONTACT_EMAIL?: string
  VERCEL_PROJECT_PRODUCTION_URL?: string
  VERCEL_URL?: string
}

export function normalizeUrl(value: string): string {
  const candidate = value.trim()
  const hasProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)
  const withProtocol = hasProtocol ? candidate : `https://${candidate}`
  const url = new URL(withProtocol)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`Unsupported URL protocol: ${url.protocol}`)
  url.pathname = url.pathname.replace(/\/+$/, '') || '/'
  return url.toString().replace(/\/$/, '')
}

function optionalUrl(value?: string, hosted = false): string | undefined {
  if (!value?.trim()) return undefined
  try {
    const normalized = normalizeUrl(value)
    const url = new URL(normalized)
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
    const local = host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0.0.0.0' || host.startsWith('127.') || host.startsWith('::ffff:127.') || host.startsWith('::ffff:7f')
    if (hosted && (url.protocol !== 'https:' || local || url.username || url.password)) {
      throw new Error('Hosted website URLs require HTTPS, a non-loopback host and no credentials')
    }
    return normalized
  } catch {
    if (hosted) throw new Error('Invalid hosted website URL configuration')
    return undefined
  }
}

export function resolveWebsiteConfig(env: WebsiteEnvironment) {
  const production = env.NODE_ENV === 'production'
  const vercelHost = env.VERCEL_PROJECT_PRODUCTION_URL ?? env.VERCEL_URL
  const siteUrl = optionalUrl(env.NEXT_PUBLIC_SITE_URL, production) ?? (production ? 'https://www.fbeds.com' : optionalUrl(vercelHost) ?? 'http://localhost:3000')

  return {
    production,
    siteUrl,
    contactEmail: env.NEXT_PUBLIC_CONTACT_EMAIL?.trim() || 'hello@fbeds.com',
    portals: {
      agent: optionalUrl(env.NEXT_PUBLIC_AGENT_URL, production) ?? (production ? undefined : 'http://localhost:3003'),
      supplier: optionalUrl(env.NEXT_PUBLIC_SUPPLIER_URL, production) ?? (production ? undefined : 'http://localhost:3004'),
      admin: optionalUrl(env.NEXT_PUBLIC_ADMIN_URL, production) ?? (production ? undefined : 'http://localhost:3001'),
    },
  }
}

