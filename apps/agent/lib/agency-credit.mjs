// The API refuses a new hold that would take an agency over its credit limit with these error codes (ADR 0024). The constants live in
// @bedbanks/contracts (AGENCY_CREDIT_*_CODE); they are repeated here because this module is loaded directly by the Node test runner,
// which cannot resolve the contracts source. The API e2e suite asserts the same literals.
const LIMIT_EXCEEDED = 'AGENCY_CREDIT_LIMIT_EXCEEDED'
const CURRENCY_MISMATCH = 'AGENCY_CREDIT_CURRENCY_MISMATCH'
const UNAVAILABLE = 'AGENCY_CREDIT_UNAVAILABLE'

const MESSAGES = {
  [LIMIT_EXCEEDED]: 'This hold would take your agency over its credit limit, so it was not placed. Contact your account manager.',
  [CURRENCY_MISMATCH]: 'Your agency has a credit limit in a different currency, so this hold cannot be placed. Contact your account manager.',
  [UNAVAILABLE]: 'Your agency credit limit could not be checked, so the hold was not placed. Nothing was changed. Try again shortly.',
}

/** Returns { code, message, retryable } for a credit refusal in an API error body, or null for any other error. */
export function creditRefusal(body) {
  if (typeof body !== 'object' || body === null || !('error' in body)) return null
  const error = body.error
  if (typeof error !== 'object' || error === null || typeof error.code !== 'string') return null
  const message = MESSAGES[error.code]
  return message ? { code: error.code, message, retryable: error.code === UNAVAILABLE } : null
}
