import type { PortalKey } from './site-config'

const subdomainPortals: Record<string, PortalKey> = {
  portal: 'agent', agent: 'agent', suppliers: 'supplier', supplier: 'supplier', ops: 'admin', admin: 'admin',
}

export function requestHost(value: string | null): string {
  return (value ?? '').split(',')[0].trim().split(':')[0].toLowerCase()
}

export function portalForHost(host: string, rootDomain: string): PortalKey | undefined {
  const normalizedHost = requestHost(host)
  const normalizedRoot = requestHost(rootDomain)
  const local = normalizedHost.match(/^([a-z0-9-]+)\.(?:localhost|127\.0\.0\.1)$/)?.[1]
  const deployed = normalizedRoot && normalizedHost.endsWith(`.${normalizedRoot}`)
    ? normalizedHost.slice(0, -(normalizedRoot.length + 1)).split('.').pop()
    : undefined
  return subdomainPortals[local ?? deployed ?? '']
}

export function portalRedirectUrl(target: string | undefined, pathname: string, search: string): string | undefined {
  if (!target) return undefined
  const url = new URL(target)
  const safePath = pathname.startsWith('/') ? pathname : `/${pathname}`
  if (safePath !== '/') url.pathname = `${url.pathname.replace(/\/$/, '')}${safePath}`
  url.search = search
  return url.toString()
}
