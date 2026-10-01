import { ApiResponseError } from './errors'
import { activeTenantHeaders } from './tenant-context'

// Same-origin path proxied to the API by next.config rewrites; the session cookie is host-only.
const API_BASE = '/api/v1'
const REQUEST_TIMEOUT_MS = 10_000

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      ...init,
      credentials: 'include',
      headers: { Accept: 'application/json', ...activeTenantHeaders(), ...init.headers },
      signal: controller.signal,
    })
    const body = await response.json().catch(() => null) as { success?: boolean; data?: T; error?: { code?: string; message?: string } } | null
    if (!response.ok) throw new ApiResponseError(body?.error?.code ?? 'API_REQUEST_FAILED', body?.error?.message ?? 'The request failed.', response.status)
    return (body?.data ?? body) as T
  } catch (error) {
    if (error instanceof ApiResponseError) throw error
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new ApiResponseError('API_TIMEOUT', 'The Admin API request timed out.', 504)
    }
    throw new ApiResponseError('NETWORK_ERROR', 'The Admin API could not be reached.', 0)
  } finally {
    clearTimeout(timeout)
  }
}
