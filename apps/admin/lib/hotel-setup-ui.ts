import { ApiResponseError } from './api/errors'

/** Splits an API failure into the parts the Setup screens show: a message, field-level details, the code and the server request id. */
export function apiErrorParts(error: unknown, action: string): { message: string; details: string[]; code: string | null; requestId: string | null } {
  if (!(error instanceof ApiResponseError)) return { message: `Could not ${action}.`, details: [], code: null, requestId: null }
  if (error.status === 0) return { message: 'The Admin API could not be reached. Nothing was saved.', details: [], code: error.code, requestId: null }
  if (error.status === 401) return { message: 'Your session has expired. Sign in again; nothing was saved.', details: [], code: error.code, requestId: error.requestId }
  if (error.status === 403) return { message: `You do not have permission to ${action}.`, details: [], code: error.code, requestId: error.requestId }
  if (error.status >= 500) return { message: `The Admin API failed to ${action}. Nothing was saved.`, details: [], code: error.code, requestId: error.requestId }
  return { message: error.message, details: error.details, code: error.code, requestId: error.requestId }
}
