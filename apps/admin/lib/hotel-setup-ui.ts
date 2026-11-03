import { HOTEL_PROFILE_STATUSES, type HotelProfileStatus } from '@bedbanks/contracts'
import { mergeDraft } from '@bedbanks/ui/merge-draft'
import { ApiResponseError } from './api/errors'

export { mergeDraft }

/** Splits an API failure into the parts the Setup screens show: a message, field-level details, the code and the server request id. */
export function apiErrorParts(error: unknown, action: string): { message: string; details: string[]; code: string | null; requestId: string | null } {
  if (!(error instanceof ApiResponseError)) return { message: `Could not ${action}.`, details: [], code: null, requestId: null }
  if (error.status === 0) return { message: 'The Admin API could not be reached. Nothing was saved.', details: [], code: error.code, requestId: null }
  if (error.status === 401) return { message: 'Your session has expired. Sign in again; nothing was saved.', details: [], code: error.code, requestId: error.requestId }
  if (error.status === 403) return { message: `You do not have permission to ${action}.`, details: [], code: error.code, requestId: error.requestId }
  if (error.status >= 500) return { message: `The Admin API failed to ${action}. Nothing was saved.`, details: [], code: error.code, requestId: error.requestId }
  return { message: error.message, details: error.details, code: error.code, requestId: error.requestId }
}

/**
 * The lifecycle statuses an operator can move a hotel to by hand. One list drives both the options shown and the value submitted.
 * COMPLETE is reached only through the two-person publication flow, never by this control; an ARCHIVED hotel can only be restored to DRAFT.
 */
export function allowedStatusTargets(current: HotelProfileStatus): HotelProfileStatus[] {
  return HOTEL_PROFILE_STATUSES.filter((s) => s !== current && s !== 'COMPLETE' && (current !== 'ARCHIVED' || s === 'DRAFT'))
}

