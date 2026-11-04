export type CheckoutPhase = 'idle' | 'holding' | 'held' | 'booking' | 'done' | 'failed' | 'uncertain'

/** A transactional write whose result did not come back must not be replaced by a new booking attempt. */
export function blocksNewBookingAttempt(phase: CheckoutPhase): boolean {
  return phase === 'uncertain' || phase === 'booking' || phase === 'holding'
}

export function holdStillConfirmable(expiresAt: string, now: number): boolean {
  const expiry = Date.parse(expiresAt)
  return Number.isFinite(expiry) && expiry > now
}

/** The same hold key is reused for a safe retry. A new key is only issued after a definite rejection. */
export function nextHoldKey(current: string, outcome: 'rejected' | 'uncertain' | 'held' | 'retry'): string | null {
  if (outcome === 'uncertain' || outcome === 'retry' || outcome === 'held') return current
  return null
}

export function shouldWarnBeforeLeave(phase: CheckoutPhase): boolean {
  return phase === 'holding' || phase === 'held' || phase === 'booking' || phase === 'uncertain'
}

export const CANCELLATION_QUOTE_MAX_AGE_MS = 120_000

export function cancellationQuoteFresh(evaluatedAt: string, now: number): boolean {
  const time = Date.parse(evaluatedAt)
  return Number.isFinite(time) && now >= time && now - time <= CANCELLATION_QUOTE_MAX_AGE_MS
}
