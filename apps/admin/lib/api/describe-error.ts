import { ApiResponseError } from './errors'

/** Operator-facing text for an API failure. The server's own message is shown for 4xx so validation reasons stay visible. */
export function describeApiError(error: unknown, action = 'complete the request'): string {
  if (!(error instanceof ApiResponseError)) return `Could not ${action}.`
  if (error.status === 401) return 'Your session has expired. Sign in again to continue.'
  if (error.status === 403) return `You do not have permission to ${action}.`
  if (error.status === 404) return 'The record was not found for this tenant.'
  if (error.status >= 400 && error.status < 500) return error.message || `Could not ${action}.`
  if (error.status === 0) return 'The Admin API could not be reached. Nothing was saved.'
  return `The Admin API failed to ${action}. Nothing was saved.`
}
