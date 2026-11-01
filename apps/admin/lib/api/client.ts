import { ApiResponseError } from './errors'
import { activeTenantHeaders } from './tenant-context'

// Same-origin path proxied to the API by the portal proxy.ts at request time; the session cookie is host-only.
const API_BASE = '/api/v1'
const REQUEST_TIMEOUT_MS = 10_000

interface Envelope<T> { success?: unknown; data?: T; error?: unknown }
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

/** The API's failure envelope as an ApiResponseError. Missing or oddly shaped fields fall back to generic text; nothing from the body is trusted as markup. */
function failure(envelope: Envelope<unknown> | null, status: number, requestId: string | null, fallback: string): ApiResponseError {
  const error = isObject(envelope?.error) ? envelope.error : {}
  const details = Array.isArray(error.details) ? error.details : []
  return new ApiResponseError(
    typeof error.code === 'string' ? error.code : 'API_REQUEST_FAILED',
    typeof error.message === 'string' ? error.message : fallback,
    status, requestId,
    details.filter((d): d is string => typeof d === 'string'),
    details.filter((d) => d !== null && typeof d === 'object'),
  )
}

/** Reads the body as the API envelope. `envelope` is null, with a short fixed `reason`, when the body is empty or not a JSON object. */
async function readEnvelope<T>(response: Response): Promise<{ envelope: Envelope<T> | null; reason: string }> {
  const text = await response.text() // an abort or network failure here propagates to the caller's timeout / network handling
  if (text.trim() === '') return { envelope: null, reason: 'The response body was empty.' }
  let value: unknown
  try { value = JSON.parse(text) } catch { return { envelope: null, reason: 'The response was not valid JSON.' } }
  return isObject(value) ? { envelope: value as Envelope<T>, reason: '' } : { envelope: null, reason: 'The response was not a JSON object.' }
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  return (await apiRequestWithMeta<T>(path, init)).data
}

/** Like apiRequest, but also returns the server request id so mutation results can show it. */
export async function apiRequestWithMeta<T>(path: string, init: RequestInit = {}): Promise<{ data: T; requestId: string | null }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      ...init,
      credentials: 'include',
      headers: { Accept: 'application/json', ...activeTenantHeaders(), ...init.headers },
      signal: controller.signal,
    })
    const requestId = response.headers.get('x-request-id')
    const { envelope, reason } = await readEnvelope<T>(response)
    if (!response.ok) throw failure(envelope, response.status, requestId, 'The request failed.')
    // HTTP success is not mutation success: only the API's own { success: true, data } envelope counts. A { success: false } body, an empty or
    // truncated body, or a proxy's HTML page is raised as a failure that keeps the request id, so no caller reports a save the server did not confirm.
    if (envelope?.success === false) throw failure(envelope, response.status, requestId, 'The request failed.')
    if (!envelope || envelope.success !== true || !('data' in envelope)) {
      throw new ApiResponseError('API_MALFORMED_RESPONSE', 'The Admin API returned an unexpected response. The change may not have been applied; reload to check before retrying.', response.status, requestId, [reason || 'The response was not the API success envelope.'])
    }
    return { data: envelope.data as T, requestId }
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
      const body = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null
      throw new ApiResponseError(body?.error?.code ?? 'API_REQUEST_FAILED', body?.error?.message ?? 'The download failed.', response.status, requestId, [])
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
