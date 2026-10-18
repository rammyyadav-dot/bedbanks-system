import { parseFrozenRules } from '@bedbanks/contracts'
import { buyerRules, type CancellationRule, type NoShowPenalty } from './cancellation-policy.service'

/**
 * Cancellation terms frozen onto an Agent booking when it is created (finding F13).
 *
 * What the buyer was shown at booking is what governs the cancellation and the voucher, whatever the contract says later. The terms are stored on the
 * booking in the same shape manual bookings use (`Booking.cancellationPolicy`, read by Admin finance), with the set they came from and the instant they were frozen.
 * A booking with no frozen terms predates this rule; those keep reading the plan's live rules and are the only ones that can drift.
 *
 * ADR 0067 F-10: the frozen tiers are the buyer's (the hotel's moved earlier by the contract's client buffer), a tier may charge nights, and the
 * contract's no-show rule is frozen alongside with the stay length that nights are counted against.
 */
export const FROZEN_SOURCE = 'CONTRACT_AT_BOOKING'

interface LiveRule { kind?: string; daysBeforeCheckin: number; penaltyPercent: number | null; penaltyMinor: bigint | null; penaltyNights?: number | null; currency: string | null }
export interface FreezeContext { bufferDays: number; stayNights: number }

type Frozen = Record<string, unknown>
/** One rule as stored, or null when it cannot be stored faithfully (two forms, or a fixed penalty in another currency). */
function freezeRule(rule: LiveRule, bookingCurrency: string): Frozen | null {
  const forms = [rule.penaltyPercent, rule.penaltyMinor, rule.penaltyNights ?? null].filter((v) => v !== null).length
  if (forms !== 1) return null
  if (rule.penaltyNights != null) return { penaltyNights: rule.penaltyNights }
  if (rule.penaltyPercent !== null) return { penaltyPercent: rule.penaltyPercent }
  if (rule.currency !== null && rule.currency !== bookingCurrency) return null
  return { penaltyMinor: rule.penaltyMinor!.toString() }
}

/** The JSON to store, or null when the live rules cannot be frozen faithfully. Never stores an ambiguous rule, and never more than one no-show rule. */
export function freezeCancellationTerms(rules: readonly LiveRule[], bookingCurrency: string, setName: string | null, now: Date, context: FreezeContext): Record<string, unknown> | null {
  const tiers = buyerRules(rules.filter((rule) => rule.kind !== 'NO_SHOW'), context.bufferDays)
  const noShows = rules.filter((rule) => rule.kind === 'NO_SHOW')
  if (noShows.length > 1) return null
  const frozen: Frozen[] = []
  for (const rule of tiers) {
    const penalty = freezeRule(rule, bookingCurrency)
    if (penalty === null) return null
    frozen.push({ daysBeforeCheckin: rule.daysBeforeCheckin, ...penalty })
  }
  if (frozen.length > 0 && parseFrozenRules(frozen) === null) return null
  const noShow = noShows[0] ? freezeRule(noShows[0], bookingCurrency) : undefined
  if (noShow === null) return null
  return { rules: frozen, setName, frozenAt: now.toISOString(), source: FROZEN_SOURCE, stayNights: context.stayNights, bufferDays: context.bufferDays, ...(noShow ? { noShow } : {}) }
}

export type FrozenTerms = { kind: 'none' } | { kind: 'invalid' } | { kind: 'frozen'; rules: CancellationRule[]; setName: string | null; stayNights: number | null; noShow: NoShowPenalty | null }

const toRule = (rule: { daysBeforeCheckin: number; penaltyPercent?: number; penaltyMinor?: string; penaltyNights?: number }): CancellationRule =>
  rule.penaltyNights !== undefined ? { daysBeforeCheckin: rule.daysBeforeCheckin, penaltyNights: rule.penaltyNights }
    : rule.penaltyPercent !== undefined ? { daysBeforeCheckin: rule.daysBeforeCheckin, penaltyPercent: rule.penaltyPercent }
      : { daysBeforeCheckin: rule.daysBeforeCheckin, penaltyMinor: BigInt(rule.penaltyMinor ?? '0') }

/** `none`: the booking has no frozen terms (legacy). `invalid`: terms are there but unreadable, which must never be treated as free. */
export function readFrozenTerms(value: unknown): FrozenTerms {
  if (value === null || value === undefined) return { kind: 'none' }
  if (typeof value !== 'object' || Array.isArray(value)) return { kind: 'invalid' }
  const stored = value as { rules?: unknown; setName?: unknown; frozenAt?: unknown; stayNights?: unknown; noShow?: unknown }
  if (typeof stored.frozenAt !== 'string' || !Array.isArray(stored.rules)) return { kind: 'invalid' }
  const parsed = stored.rules.length === 0 ? [] : parseFrozenRules(stored.rules)
  if (parsed === null) return { kind: 'invalid' }
  let noShow: NoShowPenalty | null = null
  if (stored.noShow !== undefined) {
    const one = parseFrozenRules([{ daysBeforeCheckin: 0, ...(stored.noShow as object) }])
    if (one === null) return { kind: 'invalid' }
    const { daysBeforeCheckin: _days, ...penalty } = toRule(one[0]!)
    noShow = penalty as NoShowPenalty
  }
  const stayNights = typeof stored.stayNights === 'number' && Number.isInteger(stored.stayNights) && stored.stayNights > 0 ? stored.stayNights : null
  return { kind: 'frozen', setName: typeof stored.setName === 'string' ? stored.setName : null, rules: parsed.map(toRule), stayNights, noShow }
}
