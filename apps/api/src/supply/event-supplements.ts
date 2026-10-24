import { markupMinor } from '@bedbanks/pricing'
import { supplementUnits, type SupplementBasis, type SupplementFrequency } from './supplements'

/**
 * Event and exhibition supplements on a contract (ADR 0089, Phase 3). An EVENT supplement overlays the contracted DailyRate exactly like a
 * ContractSupplement (ADR 0067): added per room after the promotion and before the markup, in the plan's basis, never written back to
 * DailyRate. Two differences from a board/compulsory supplement:
 *  - It may be a FIXED amount (same basis/frequency/amountMinor shape as ContractSupplement) or a PERCENTAGE of the night's own contracted
 *    base tariff (never of another supplement, never of the promoted or marked-up amount — the spec's explicit calculation-base rule).
 *  - Overlapping event supplements may be `stackable` (always combine) or not: among non-stackable eligible rules for a given night, the
 *    highest `priority` wins; an eligible tie at the top priority is an ambiguous configuration and must fail closed (`EVENT_SUPPLEMENT_CONFLICT`
 *    in the evaluator), never pick arbitrarily — the same rule `selectCascadeLayers` applies to markup layers.
 */
export const EVENT_SUPPLEMENT_AMOUNT_KINDS = ['FIXED', 'PERCENTAGE'] as const
export type EventSupplementAmountKind = (typeof EVENT_SUPPLEMENT_AMOUNT_KINDS)[number]

/** A supplement that applies to one plan, as the evaluator reads it. `id` is the EventSupplement row id, used for conflict resolution. */
export interface EventSupplementRule {
  id: string
  roomEventId: string
  roomEventName: string
  amountKind: EventSupplementAmountKind
  /** Required (and only meaningful) for FIXED; null for PERCENTAGE. */
  basis: SupplementBasis | null
  frequency: SupplementFrequency | null
  amountMinor: bigint | null
  /** Basis points of the night's contracted base; required (and only meaningful) for PERCENTAGE. */
  percentBp: number | null
  currency: string
  /** The supplement's own application window (stay nights, inclusive) — distinct from the event's own dates. */
  validFrom: string
  validTo: string
  stackable: boolean
  priority: number
}

/** The event supplements of a contract that apply to this plan: every row not limited to another plan. The loader joins `roomEvent` for its
 * name (EventSupplement itself has none) and must already scope `rows` to ACTIVE status, an APPROVED RoomEvent, and a window overlapping
 * the query range (see `assessPlanSelect`); this function only re-scopes by rate plan. */
export function eventSupplementsForPlan(plan: { id: string }, rows: ReadonlyArray<{ id: string; roomEventId: string; roomEvent: { name: string }; ratePlanId: string | null; amountKind: string; basis: string | null; frequency: string | null; amountMinor: bigint | null; percentBp: number | null; currency: string; validFrom: Date; validTo: Date; stackable: boolean; priority: number }>): EventSupplementRule[] {
  const day = (d: Date) => d.toISOString().slice(0, 10)
  return rows
    .filter((row) => row.ratePlanId === null || row.ratePlanId === plan.id)
    .map((row): EventSupplementRule => ({
      id: row.id, roomEventId: row.roomEventId, roomEventName: row.roomEvent.name,
      amountKind: row.amountKind as EventSupplementAmountKind,
      basis: row.basis as SupplementBasis | null, frequency: row.frequency as SupplementFrequency | null,
      amountMinor: row.amountMinor, percentBp: row.percentBp, currency: row.currency,
      validFrom: day(row.validFrom), validTo: day(row.validTo),
      stackable: row.stackable, priority: row.priority,
    }))
}

export interface EventSupplementNightsResult {
  perNight: bigint[]
  applied: Array<{ roomEventId: string; roomEventName: string; amountMinor: bigint }>
  /** True when, on at least one night, two or more non-stackable eligible rules tied at the top priority. Fail closed: the evaluator must
   * refuse the stay rather than pick one arbitrarily (never apply an event supplement amount from a catch-style guess). */
  ambiguous: boolean
}

/**
 * Per room, the amount each night carries and the supplements that applied, resolving overlap/priority first. `nightBaseMinor[i]` is the
 * night's own contracted DailyRate (before guest lines, promotion or any supplement) — the eligible base a PERCENTAGE rule prices, per the
 * spec's explicit calculation-base rule. Mirrors `supplementNights`'s PER_STAY/PER_NIGHT handling for FIXED rules.
 */
export function eventSupplementNights(
  rules: readonly EventSupplementRule[],
  nights: readonly string[],
  party: { adults: number; children: number },
  nightBaseMinor: readonly bigint[],
): EventSupplementNightsResult {
  const perNight = nights.map(() => 0n)
  const applied: Array<{ roomEventId: string; roomEventName: string; amountMinor: bigint }> = []
  let ambiguous = false
  const inWindow = (rule: EventSupplementRule, date: string) => date >= rule.validFrom && date <= rule.validTo

  // The non-stackable winner for each night, decided before any rule is priced, so a tie is caught once per night rather than per rule.
  const nightWinnerId: Array<string | null> = nights.map((date) => {
    const eligible = rules.filter((rule) => !rule.stackable && inWindow(rule, date))
    if (eligible.length === 0) return null
    const top = Math.max(...eligible.map((rule) => rule.priority))
    const best = eligible.filter((rule) => rule.priority === top)
    if (best.length > 1) { ambiguous = true; return null }
    return best[0]!.id
  })

  for (const rule of rules) {
    const indices = nights.reduce<number[]>((acc, date, i) => {
      if (!inWindow(rule, date)) return acc
      if (!rule.stackable && nightWinnerId[i] !== rule.id) return acc
      return [...acc, i]
    }, [])
    if (indices.length === 0) continue
    if (rule.amountKind === 'FIXED') {
      const count = supplementUnits(rule.basis!, party)
      if (count === 0n) continue
      const charged = rule.frequency === 'PER_STAY' ? [indices[0]!] : indices
      for (const i of charged) perNight[i] = perNight[i]! + rule.amountMinor! * count
      applied.push({ roomEventId: rule.roomEventId, roomEventName: rule.roomEventName, amountMinor: rule.amountMinor! * count * BigInt(charged.length) })
    } else {
      let total = 0n
      for (const i of indices) {
        const amount = markupMinor(nightBaseMinor[i]!, rule.percentBp!)
        perNight[i] = perNight[i]! + amount
        total += amount
      }
      applied.push({ roomEventId: rule.roomEventId, roomEventName: rule.roomEventName, amountMinor: total })
    }
  }
  return { perNight, applied, ambiguous }
}
