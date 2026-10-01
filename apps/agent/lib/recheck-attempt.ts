export interface RecheckAttempt {
  generation: number
  offerId: string
}

/** An older recheck may update state only while that same offer is still the selected attempt. */
export function recheckResultApplies(attempt: RecheckAttempt, current: RecheckAttempt): boolean {
  return attempt.generation === current.generation && attempt.offerId === current.offerId
}
