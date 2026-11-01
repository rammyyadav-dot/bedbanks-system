import { ApiResponseError } from './errors'

const MAKER_CHECKER_MESSAGES: Record<string, string> = {
  STEP_UP_REQUIRED: 'Enter your password to confirm this decision.',
  STEP_UP_FAILED: 'That password is not correct. Nothing was approved.',
  STEP_UP_THROTTLED: 'Too many wrong passwords. Wait a few minutes before trying again.',
  APPROVAL_EXPIRED: 'This approval request expired before it was completed. Ask for a new one.',
  DUAL_APPROVAL_REQUIRED: 'This step needs a second person to approve first. It cannot be done directly.',
}

/** Operator-facing text for an API failure. The server's own message is shown for 4xx so validation reasons stay visible. */
export function describeApiError(error: unknown, action = 'complete the request'): string {
  if (!(error instanceof ApiResponseError)) return `Could not ${action}.`
  // Maker-checker preconditions (ADR 0095) are specific enough to name, and must not be read as a generic permission failure.
  const makerChecker = MAKER_CHECKER_MESSAGES[error.code]
  if (makerChecker) return makerChecker
  if (error.code === 'API_TIMEOUT') return `The request timed out, so it may not have been applied. Reload the current status before trying to ${action} again.`
  if (error.status === 401) return 'Your session has expired. Sign in again to continue.'
  if (error.status === 403) return `You do not have permission to ${action}.`
  if (error.status === 404) return 'The record was not found for this tenant.'
  if (error.status >= 400 && error.status < 500) return error.details.length ? `${error.message}: ${error.details.join('; ')}` : error.message || `Could not ${action}.`
  if (error.status === 0) return 'The Admin API could not be reached. Nothing was saved.'
  return `The Admin API failed to ${action}. Nothing was saved.`
}
