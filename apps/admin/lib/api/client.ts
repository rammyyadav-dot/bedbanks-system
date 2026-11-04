import { parseApiEnvelope } from '@bedbanks/contracts/envelope'
import { mutationBlockedReason } from '../auth/mutation-gate'
import { ApiResponseError } from './errors'
import { activeTenantHeaders } from './tenant-context'

// Same-origin path proxied to the API by the portal proxy.ts at request time; the session cookie is host-only.
const API_BASE = '/api/v1'
const REQUEST_TIMEOUT_MS = 10_000

export type ApiRequestInit = RequestInit & { /** When set, the browser sends the mutation only if this permission is loaded for the active tenant. */ permission?: string }

export async function apiRequest<T>(path: string, init: ApiRequestInit = {}): Promise<T> {
  return (await apiRequestWithMeta<T>(path, init)).data
}

/** Like apiRequest, but also returns the server request id so mutation results can show it. */
export async function apiRequestWithMeta<T>(path: string, init: ApiRequestInit = {}): Promise<{ data: T; requestId: string | null }> {
  const { permission, ...request } = init
  const blocked = mutationBlockedReason(request.method, permission)
  if (blocked) throw new ApiResponseError('FORBIDDEN', blocked, 403)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      ...request,
      credentials: 'include',
      headers: { Accept: 'application/json', ...activeTenantHeaders(), ...request.headers },
      signal: controller.signal,
    })
    const requestId = response.headers.get('x-request-id')
    const text = await response.text() // an abort or network failure here propagates to the caller's timeout / network handling
    const parsed = parseApiEnvelope(response.status, text)
    // HTTP success is not mutation success: only the API's own { success: true, data } envelope counts. A { success: false } body, an empty or
    // truncated body, or a proxy's HTML page is raised as a failure that keeps the request id, so no caller reports a save the server did not confirm.
    if (parsed.kind === 'malformed') {
      throw new ApiResponseError('API_MALFORMED_RESPONSE', 'The Admin API returned an unexpected response. The change may not have been applied; reload to check before retrying.', response.status, requestId, [parsed.reason])
    }
    if (parsed.kind === 'failure') {
      throw new ApiResponseError(parsed.code ?? 'API_REQUEST_FAILED', parsed.message ?? 'The request failed.', response.status, requestId, parsed.details, parsed.structuredDetails)
    }
    return { data: parsed.data as T, requestId }
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

/** Fetches a non-JSON download (CSV) through the same proxy, session and tenant headers. Errors use the normal JSON envelope. */
export async function apiDownload(path: string): Promise<{ blob: Blob; headers: Headers; requestId: string | null }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 60_000)
  try {
    const response = await fetch(`${API_BASE}${path}`, { credentials: 'include', headers: { ...activeTenantHeaders() }, signal: controller.signal })
    const requestId = response.headers.get('x-request-id')
    if (!response.ok) {
      const parsed = parseApiEnvelope(response.status, await response.text())
      const code = parsed.kind === 'failure' ? parsed.code ?? 'API_REQUEST_FAILED' : 'API_REQUEST_FAILED'
      const message = parsed.kind === 'failure' ? parsed.message ?? 'The download failed.' : 'The download failed.'
      throw new ApiResponseError(code, message, response.status, requestId, parsed.kind === 'failure' ? parsed.details : [])
    }
    return { blob: await response.blob(), headers: response.headers, requestId }
  } catch (error) {
    if (error instanceof ApiResponseError) throw error
    if (error instanceof DOMException && error.name === 'AbortError') throw new ApiResponseError('API_TIMEOUT', 'The Admin API request timed out.', 504)
    throw new ApiResponseError('NETWORK_ERROR', 'The Admin API could not be reached.', 0)
  } finally {
    clearTimeout(timeout)
  }
}
