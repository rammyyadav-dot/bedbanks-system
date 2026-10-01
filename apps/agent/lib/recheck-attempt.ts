export interface RecheckAttempt {
  generation: number
  offerId: string
}

/** An older recheck may update state only while that same offer is still the selected attempt. */
export function recheckResultApplies(attempt: RecheckAttempt, current: RecheckAttempt): boolean {
  return attempt.generation === current.generation && attempt.offerId === current.offerId
}

/** The comparison baseline is the latest accepted price, or the original search quote before any acceptance. */
export function recheckBaselineMinor(searchQuoteMinor: number, acceptedMinor: number | null): number {
  return acceptedMinor ?? searchQuoteMinor
}

export function priceChangeDisplay(input: {
  searchQuoteMinor: number
  baselineMinor: number
  currentMinor: number
}): { previousMinor: number; currentMinor: number; searchQuoteMinor: number | null } {
  return {
    previousMinor: input.baselineMinor,
    currentMinor: input.currentMinor,
    searchQuoteMinor: input.baselineMinor === input.searchQuoteMinor ? null : input.searchQuoteMinor,
  }
}
