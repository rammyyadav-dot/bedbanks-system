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

export const SESSION_COOKIE_NAME = process.env.AUTH_COOKIE_NAME ?? 'fbeds_session'
export const SUPPLIER_CONTEXT_COOKIE = 'fbeds_supplier_context'
