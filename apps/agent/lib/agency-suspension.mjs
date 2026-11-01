// The API answers new commercial activity from a suspended agency with HTTP 403 and this error code (ADR 0020). The constant lives in
// @bedbanks/contracts (AGENCY_SUSPENDED_CODE); it is repeated here because this module is loaded directly by the Node test runner,
// which cannot resolve the contracts source. The API e2e suite asserts the same literal.
const AGENCY_SUSPENDED_CODE = 'AGENCY_SUSPENDED'

/** True when an API error body is the agency-suspended refusal. Any other 403 stays a plain access denial. */
export function isAgencySuspended(body) {
  if (typeof body !== 'object' || body === null || !('error' in body)) return false
  const error = body.error
  return typeof error === 'object' && error !== null && error.code === AGENCY_SUSPENDED_CODE
}

export const agencySuspendedTitle = 'Your agency is suspended'
export const agencySuspendedMessage = 'Your agency is suspended. New searches and bookings are blocked. Contact your account manager.'
