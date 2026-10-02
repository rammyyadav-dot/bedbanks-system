const REQUEST_FAILURES = new Set(['provider_unavailable', 'auth_required', 'access_denied', 'destination_unavailable'])

export function isSearchRequestFailure(status: string): boolean {
  return REQUEST_FAILURES.has(status)
}

/**
 * Replace the list only when the new response is a completed search.
 * A failed refresh keeps the previous successful result and its criteria.
 * The first search has nothing to retain, so the failure is shown on its own.
 */
export function replaceSearchResult(previousExists: boolean, status: string): boolean {
  return !(previousExists && isSearchRequestFailure(status))
}
