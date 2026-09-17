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
  const withProtocol = /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`
  const url = new URL(withProtocol)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`Unsupported URL protocol: ${url.protocol}`)
  url.pathname = url.pathname.replace(/\/+$/, '') || '/'
  return url.toString().replace(/\/$/, '')
}

function optionalUrl(value?: string): string | undefined {
  if (!value?.trim()) return undefined
  try { return normalizeUrl(value) } catch { return undefined }
}

export function resolveWebsiteConfig(env: WebsiteEnvironment) {
  const production = env.NODE_ENV === 'production'
  const vercelHost = env.VERCEL_PROJECT_PRODUCTION_URL ?? env.VERCEL_URL
  const siteUrl = optionalUrl(env.NEXT_PUBLIC_SITE_URL) ?? optionalUrl(vercelHost) ?? 'http://localhost:3000'

  return {
    production,
    siteUrl,
    contactEmail: env.NEXT_PUBLIC_CONTACT_EMAIL?.trim() || 'hello@fbeds.com',
    portals: {
      agent: optionalUrl(env.NEXT_PUBLIC_AGENT_URL) ?? (production ? undefined : 'http://localhost:3003'),
      supplier: optionalUrl(env.NEXT_PUBLIC_SUPPLIER_URL) ?? (production ? undefined : 'http://localhost:3004'),
      admin: optionalUrl(env.NEXT_PUBLIC_ADMIN_URL) ?? (production ? undefined : 'http://localhost:3001'),
    },
  }
}
