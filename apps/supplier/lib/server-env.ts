import 'server-only'

function required(name: 'API_INTERNAL_URL' | 'SUPPLIER_ORIGIN', developmentDefault: string): string {
  const value = process.env[name]?.trim()
  if (value) return value.replace(/\/+$/, '')
  if (process.env.NODE_ENV === 'production') throw new Error(`${name} must be configured for the supplier extranet`)
  return developmentDefault
}

export function apiInternalUrl(): string {
  return required('API_INTERNAL_URL', 'http://localhost:3002/api/v1')
}

export function supplierOrigin(): string {
  return required('SUPPLIER_ORIGIN', 'http://localhost:3003')
}

/** Optional public site URL for the sign-in "Home" link. Only an absolute https URL is accepted; anything else hides the link. */
export function homeUrl(): string | null {
  const value = process.env.FABBEDS_HOME_URL?.trim()
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || (process.env.NODE_ENV !== 'production' && url.protocol === 'http:') ? url.toString() : null
  } catch {
    return null
  }
}

export const SESSION_COOKIE_NAME = process.env.AUTH_COOKIE_NAME ?? 'fbeds_session'
export const SUPPLIER_CONTEXT_COOKIE = 'fbeds_supplier_context'
