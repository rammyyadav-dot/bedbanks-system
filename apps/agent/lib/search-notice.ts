import type { HotelSearchResult } from '../types/hotel'

export const SEARCH_TEMPORARILY_UNAVAILABLE = 'Search is temporarily unavailable. Please try again.'

/** User-facing notice for one finished search attempt. Null means no provider-failure toast. */
export function searchAttemptNotice(outcome: { kind: 'resolved'; status: HotelSearchResult['status'] } | { kind: 'thrown' }): string | null {
  if (outcome.kind === 'thrown' || outcome.status === 'provider_unavailable') return SEARCH_TEMPORARILY_UNAVAILABLE
  return null
}
