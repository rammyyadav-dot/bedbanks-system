import { AGENCY_CREDIT_TERMS, type AgencyOverdueState } from '@bedbanks/contracts'

export interface AgingEntry { type: string; amountMinor: bigint; reference: string | null; at: Date }
export interface Aging {
  state: AgencyOverdueState
  unpaidMinor: bigint
  /** The part of `unpaidMinor` in charges at least `AGENCY_CREDIT_TERMS.overdueNoticeDays` old (the amount rule of the credit risk policy, ADR 0095). */
  overdueUnpaidMinor: bigint
  oldestUnpaidAt: Date | null
  daysOverdue: number
}

const DAY_MS = 86_400_000

/**
 * FIFO aging of one agency account (ADR 0028 slice 4). Only settled money is aged:
 *   DEBIT  (negative) is a charge, dated when it was posted;
 *   REFUND (positive) first pays charges with the same reference (its own booking), then the oldest;
 *   CREDIT (positive, a posted payment) pays the oldest charges; what is left is prepaid money that pays later charges;
 *   ADJUSTMENT pays like a CREDIT when positive and is a new charge, dated when posted, when negative (ADR 0100);
 *   REVERSAL (negative) is a payment taken back, so the money is owed again: a new charge, dated when posted.
 * HOLD and RELEASE are pending authorizations, not charges, so they are ignored. Entries must be in posting order.
 */
export function ageAccount(entries: readonly AgingEntry[], now: Date = new Date()): Aging {
  const charges: Array<{ amount: bigint; at: Date; reference: string | null }> = []
  let prepaid = 0n
  const pay = (amount: bigint, reference: string | null) => {
    let left = amount
    if (reference) for (const c of charges) { if (left === 0n) break; if (c.reference === reference && c.amount > 0n) { const p = c.amount < left ? c.amount : left; c.amount -= p; left -= p } }
    for (const c of charges) { if (left === 0n) break; if (c.amount > 0n) { const p = c.amount < left ? c.amount : left; c.amount -= p; left -= p } }
    prepaid += left
  }
  for (const e of entries) {
    if ((e.type === 'DEBIT' || e.type === 'REVERSAL' || e.type === 'ADJUSTMENT') && e.amountMinor < 0n) {
      let charge = -e.amountMinor
      const fromPrepaid = prepaid < charge ? prepaid : charge
      prepaid -= fromPrepaid; charge -= fromPrepaid
      if (charge > 0n) charges.push({ amount: charge, at: e.at, reference: e.reference })
    } else if ((e.type === 'CREDIT' || e.type === 'REFUND' || e.type === 'ADJUSTMENT') && e.amountMinor > 0n) {
      pay(e.amountMinor, e.type === 'REFUND' ? e.reference : null)
    }
  }
  const open = charges.filter(c => c.amount > 0n)
  const unpaid = open.reduce((sum, c) => sum + c.amount, 0n)
  const oldest = open.length ? open.reduce((a, c) => (c.at < a ? c.at : a), open[0].at) : null
  const overdueBefore = now.getTime() - AGENCY_CREDIT_TERMS.overdueNoticeDays * DAY_MS
  const overdueUnpaid = open.filter(c => c.at.getTime() <= overdueBefore).reduce((sum, c) => sum + c.amount, 0n)
  const days = oldest ? Math.max(0, Math.floor((now.getTime() - oldest.getTime()) / DAY_MS)) : 0
  const state: AgencyOverdueState = !oldest ? 'CURRENT' : days >= AGENCY_CREDIT_TERMS.refuseHoldsAfterDays ? 'HOLDS_REFUSED' : days >= AGENCY_CREDIT_TERMS.overdueNoticeDays ? 'NOTICE' : 'CURRENT'
  return { state, unpaidMinor: unpaid, overdueUnpaidMinor: overdueUnpaid, oldestUnpaidAt: oldest, daysOverdue: days }
}
