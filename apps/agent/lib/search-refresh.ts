const REQUEST_FAILURES = new Set(['provider_unavailable', 'auth_required', 'access_denied', 'agency_suspended', 'destination_unavailable'])

/** A supplier timeout can keep the previous successful list. Permission, session, and catalogue failures cannot. */
const RETAIN_PREVIOUS = new Set(['provider_unavailable'])

export function isSearchRequestFailure(status: string): boolean {
  return REQUEST_FAILURES.has(status)
}

/**
 * Replace the list when the new response is a completed search, or when keeping the previous hotels would
 * show inventory the caller is no longer allowed to see. Only a supplier timeout retains the previous list.
 * The first search has nothing to retain, so that failure is shown on its own.
 */
export function replaceSearchResult(previousExists: boolean, status: string): boolean {
  return !(previousExists && RETAIN_PREVIOUS.has(status))
}
