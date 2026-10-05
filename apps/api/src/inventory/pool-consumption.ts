import { POOL_HOLD_STATUS_COUNTER, type PoolConsumptionNight } from '@bedbanks/contracts'

/**
 * Pure per-plan attribution of a pool's counters (ADR 0036).
 *
 * The only evidence used is what each hold recorded when it reserved: the pool day it drew from (`poolDayId`, counter kind POOL_DAY),
 * the plan that holds it (`InventoryHold.ratePlanId`, fixed at creation) and the units. Current rate-plan membership is never consulted,
 * so a plan that has since left the pool keeps its history. A hold contributes to the counter its status currently occupies
 * (`POOL_HOLD_STATUS_COUNTER`): HELD / PROCESSING to held, CONFIRMED to sold, everything else to nothing.
 *
 * Reconciliation: for each night, counter = sum of attributed plans + unattributed. The unattributed part is derived, never fabricated; a
 * negative value means the holds claim more units than the counter holds and the night is reported inconsistent.
 */
export interface PoolDayCounters { capacity: number; sold: number; held: number }
export interface AttributedNight { poolDayId: string; ratePlanId: string; holdStatus: string; quantity: number }

export function attributeNight(date: string, day: (PoolDayCounters & { id: string }) | null, nights: readonly AttributedNight[]): PoolConsumptionNight {
  if (!day) return { date, exists: false, capacity: null, sold: null, held: null, available: null, plans: [], unattributedHeld: null, unattributedSold: null, consistent: null }
  const perPlan = new Map<string, { held: number; sold: number }>()
  let attributedHeld = 0; let attributedSold = 0
  for (const night of nights) {
    if (night.poolDayId !== day.id) continue
    const counter = POOL_HOLD_STATUS_COUNTER[night.holdStatus] ?? 'none'
    if (counter === 'none') continue
    const entry = perPlan.get(night.ratePlanId) ?? { held: 0, sold: 0 }
    entry[counter] += night.quantity
    perPlan.set(night.ratePlanId, entry)
    if (counter === 'held') attributedHeld += night.quantity; else attributedSold += night.quantity
  }
  const unattributedHeld = day.held - attributedHeld
  const unattributedSold = day.sold - attributedSold
  return {
    date, exists: true, capacity: day.capacity, sold: day.sold, held: day.held, available: day.capacity - day.sold - day.held,
    plans: [...perPlan.entries()].map(([ratePlanId, v]) => ({ ratePlanId, ...v })).sort((a, b) => a.ratePlanId.localeCompare(b.ratePlanId)),
    unattributedHeld, unattributedSold, consistent: unattributedHeld >= 0 && unattributedSold >= 0,
  }
}
