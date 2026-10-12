/**
 * When a rate plan has expired (ADR 0057, S9). Pure: no I/O, no clock.
 *
 * A plan expires when its effective end date, the earlier of its own sale window end and its contract term end, is before today in the hotel's
 * calendar. Only live plans (ACTIVE, SUSPENDED) expire: a DRAFT was never offered and stays a DRAFT. EXPIRED is final, as ADR 0041 states; the
 * way back is a clone. A plan with no end date never expires.
 */
export type ExpiryReason = 'SALE_WINDOW_ENDED' | 'CONTRACT_TERM_ENDED'

export function expiryReason(input: { status: string; today: string; planValidTo: string | null; contractValidTo: string }): ExpiryReason | null {
  if (input.status !== 'ACTIVE' && input.status !== 'SUSPENDED') return null
  if (input.planValidTo !== null && input.planValidTo < input.today) return 'SALE_WINDOW_ENDED'
  if (input.contractValidTo < input.today) return 'CONTRACT_TERM_ENDED'
  return null
}

/** The hotel's calendar day at `now`, YYYY-MM-DD, or null when the zone is missing or not an IANA zone (the plan is then left alone, never guessed). */
export function hotelToday(now: Date, timeZone: string | null | undefined): string | null {
  if (!timeZone) return null
  try { return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now) } catch { return null }
}

/** UTC date one day ahead of `now`: any hotel's local date is at most this, so it bounds the candidate query without knowing the zone. */
export const candidateHorizon = (now: Date): string => new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10)
