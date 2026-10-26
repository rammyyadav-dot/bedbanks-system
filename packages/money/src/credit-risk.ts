/**
 * Dynamic credit risk (ADR 0095): the state of one agency's credit line from its live exposure and payment aging.
 *
 * Pure: integer minor units as bigint, thresholds in integer basis points (10,000 = 100%), no I/O, no clock, no framework. Nothing is converted between
 * currencies; an account is evaluated in its own currency only. It decides and explains; the caller enforces. Unknown never passes: a negative amount is an error.
 *
 *   drawn        = what is owed against the line  = max(0, -balance) + pending holds
 *   utilisation  = drawn / credit line            (only for an agency WITH a credit line; a prepaid agency has no utilisation)
 *   projected    = (drawn + the new amount) / credit line
 *
 * States, worst first: PAUSED (new holds refused) > MARGIN_CALL (finance must collect; holds still allowed) > WATCH > OK.
 */
export interface CreditRiskPolicy {
  /** Utilisation at or above this is WATCH. */
  watchBp: number
  /** At or above this is a MARGIN_CALL: finance is asked to collect enough to return to the watch level. */
  marginCallBp: number
  /** A new hold that would take utilisation to this level or beyond is refused (PAUSED). */
  pauseBp: number
  /** Charges unpaid for at least this many days are "overdue" for the amount rule. */
  overdueAfterDays: number
  /** Overdue (aged) unpaid charges at or above this share of the credit line pause the agency. */
  overdueShareOfLineBp: number
  /** Charges unpaid for at least this many days pause the agency whatever the amounts (ADR 0028 slice 4). */
  refuseAfterDays: number
}

export type CreditRiskState = 'OK' | 'WATCH' | 'MARGIN_CALL' | 'PAUSED'
export type CreditPauseReason = 'UTILISATION' | 'OVERDUE_DAYS' | 'OVERDUE_AMOUNT'

export interface CreditRiskInput {
  balanceMinor: bigint
  creditLineMinor: bigint
  pendingMinor: bigint
  /** All settled charges not yet paid (FIFO aging). */
  unpaidMinor: bigint
  /** The part of those charges that is at least `overdueAfterDays` old. */
  overdueUnpaidMinor: bigint
  /** Age in days of the oldest unpaid charge; 0 when none. */
  daysOverdue: number
}

export interface CreditRiskResult {
  state: CreditRiskState
  /** Why the agency is paused. Empty unless `state` is PAUSED. */
  reasons: CreditPauseReason[]
  drawnMinor: bigint
  /** Null for a prepaid agency (no credit line). */
  utilisationBp: bigint | null
  projectedUtilisationBp: bigint | null
  /** MARGIN_CALL and PAUSED by utilisation: the payment that brings utilisation back below the watch level. Zero otherwise. */
  paymentToRestoreMinor: bigint
}

export const BP = 10_000n

function assertPolicy(p: CreditRiskPolicy): void {
  const ok = Number.isInteger(p.watchBp) && Number.isInteger(p.marginCallBp) && Number.isInteger(p.pauseBp) && p.watchBp > 0 && p.watchBp <= p.marginCallBp && p.marginCallBp <= p.pauseBp && p.pauseBp <= 10_000
    && Number.isInteger(p.overdueAfterDays) && p.overdueAfterDays >= 0 && Number.isInteger(p.refuseAfterDays) && p.refuseAfterDays >= p.overdueAfterDays
    && Number.isInteger(p.overdueShareOfLineBp) && p.overdueShareOfLineBp > 0 && p.overdueShareOfLineBp <= 10_000
  if (!ok) throw new Error('Invalid credit risk policy')
}

/** Basis points of `part` in `whole`, rounded down. `whole` must be positive. */
const bpOf = (part: bigint, whole: bigint): bigint => (part * BP) / whole
const atLeast = (part: bigint, whole: bigint, bp: number): boolean => part * BP >= whole * BigInt(bp)

export function evaluateCreditRisk(input: CreditRiskInput, policy: CreditRiskPolicy, newAmountMinor: bigint = 0n): CreditRiskResult {
  assertPolicy(policy)
  if (newAmountMinor < 0n || input.pendingMinor < 0n || input.unpaidMinor < 0n || input.overdueUnpaidMinor < 0n || input.creditLineMinor < 0n || input.daysOverdue < 0) throw new Error('Credit risk inputs must not be negative')
  const owed = input.balanceMinor < 0n ? -input.balanceMinor : 0n
  const drawn = owed + input.pendingMinor
  const line = input.creditLineMinor
  const reasons: CreditPauseReason[] = []
  // The overdue-days rule applies to every agency, prepaid or on account: unpaid charges are unpaid charges.
  if (input.daysOverdue >= policy.refuseAfterDays && input.unpaidMinor > 0n) reasons.push('OVERDUE_DAYS')

  if (line === 0n) {
    return { state: reasons.length ? 'PAUSED' : 'OK', reasons, drawnMinor: drawn, utilisationBp: null, projectedUtilisationBp: null, paymentToRestoreMinor: 0n }
  }
  if (input.overdueUnpaidMinor > 0n && atLeast(input.overdueUnpaidMinor, line, policy.overdueShareOfLineBp)) reasons.push('OVERDUE_AMOUNT')
  const projected = drawn + newAmountMinor
  if (newAmountMinor > 0n && atLeast(projected, line, policy.pauseBp)) reasons.push('UTILISATION')

  const utilisation = bpOf(drawn, line)
  const projectedBp = bpOf(projected, line)
  // The largest drawn amount still strictly below the watch level; the payment is what takes the agency back down to it.
  const belowWatch = (line * BigInt(policy.watchBp) + BP - 1n) / BP - 1n
  const restore = atLeast(drawn, line, policy.marginCallBp) && drawn > belowWatch ? drawn - belowWatch : 0n
  const state: CreditRiskState = reasons.length ? 'PAUSED' : atLeast(drawn, line, policy.marginCallBp) ? 'MARGIN_CALL' : atLeast(drawn, line, policy.watchBp) ? 'WATCH' : 'OK'
  return { state, reasons, drawnMinor: drawn, utilisationBp: utilisation, projectedUtilisationBp: projectedBp, paymentToRestoreMinor: restore }
}
