import { OPERATIONS_READ_DENIED } from '@bedbanks/contracts'
import { ApiResponseError } from './api/errors'

/**
 * Every failed operations request maps to exactly one of these. None of them is ever rendered as an empty list:
 * "empty" is reserved for a successful response with zero rows.
 */
export type OpsFailure = 'unauthenticated' | 'forbidden' | 'denied' | 'not-found' | 'unreachable' | 'error'

export function classifyOpsFailure(error: unknown): OpsFailure {
  if (!(error instanceof ApiResponseError)) return 'error'
  if (error.status === 401) return 'unauthenticated'
  if (error.status === 403) return 'forbidden'
  if (error.status === 404) return 'not-found'
  if (error.code === OPERATIONS_READ_DENIED) return 'denied'
  if (error.status === 0 || error.status === 504) return 'unreachable'
  return 'error'
}

export const OPS_FAILURE_COPY: Record<OpsFailure, { title: string; body: string }> = {
  unauthenticated: { title: 'Sign in required', body: 'Your session has expired. Sign in again to continue. No data is shown.' },
  forbidden: { title: 'Not permitted', body: 'Your role does not include the permission for this view. Ask a tenant owner to grant it.' },
  denied: { title: 'Data source not readable by the API', body: 'The API database role is not granted read access to this data (a deliberate privilege boundary). A human must review the grant before this view can show records. This is not an empty result.' },
  'not-found': { title: 'Record not found', body: 'The record does not exist for this tenant.' },
  unreachable: { title: 'Admin API unreachable', body: 'The Admin API did not respond. Nothing is shown and nothing was changed.' },
  error: { title: 'Could not load this view', body: 'The Admin API returned an error. No fallback data is shown.' },
}

/** Short, non-sensitive request reference for support. Only the code and HTTP status are shown, never a payload. */
export function failureReference(error: unknown): string | null {
  return error instanceof ApiResponseError ? `${error.code} (HTTP ${error.status})${error.requestId ? ` · request ${error.requestId}` : ''}` : null
}

/** Build a query string from defined, non-empty values only. */
export function opsQuery(params: Record<string, string | number | boolean | undefined | null>): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== '') query.set(key, String(value))
  const text = query.toString()
  return text ? `?${text}` : ''
}
