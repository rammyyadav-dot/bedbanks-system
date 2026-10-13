import { parseFrozenRules } from '@bedbanks/contracts'
import type { CancellationRule } from './cancellation-policy.service'

/**
 * Cancellation terms frozen onto an Agent booking when it is created (finding F13).
 *
 * What the buyer was shown at booking is what governs the cancellation and the voucher, whatever the contract says later. The terms are stored on the
 * booking in the same shape manual bookings use (`Booking.cancellationPolicy`, read by Admin finance), with the set they came from and the instant they were frozen.
 * A booking with no frozen terms predates this rule; those keep reading the plan's live rules and are the only ones that can drift.
 */
export const FROZEN_SOURCE = 'CONTRACT_AT_BOOKING'

interface LiveRule { daysBeforeCheckin: number; penaltyPercent: number | null; penaltyMinor: bigint | null; currency: string | null }

/** The JSON to store, or null when the live rules cannot be frozen faithfully (a fixed penalty in another currency). Never stores an ambiguous rule. */
export function freezeCancellationTerms(rules: readonly LiveRule[], bookingCurrency: string, setName: string | null, now: Date): Record<string, unknown> | null {
  const frozen: Array<Record<string, unknown>> = []
  for (const rule of rules) {
    if (rule.penaltyPercent !== null && rule.penaltyMinor === null) frozen.push({ daysBeforeCheckin: rule.daysBeforeCheckin, penaltyPercent: rule.penaltyPercent })
    else if (rule.penaltyMinor !== null && rule.penaltyPercent === null && (rule.currency === null || rule.currency === bookingCurrency)) frozen.push({ daysBeforeCheckin: rule.daysBeforeCheckin, penaltyMinor: rule.penaltyMinor.toString() })
    else return null
  }
  if (frozen.length > 0 && parseFrozenRules(frozen) === null) return null
  return { rules: frozen, setName, frozenAt: now.toISOString(), source: FROZEN_SOURCE }
}

export type FrozenTerms = { kind: 'none' } | { kind: 'invalid' } | { kind: 'frozen'; rules: CancellationRule[]; setName: string | null }

/** `none`: the booking has no frozen terms (legacy). `invalid`: terms are there but unreadable, which must never be treated as free. */
export function readFrozenTerms(value: unknown): FrozenTerms {
  if (value === null || value === undefined) return { kind: 'none' }
  if (typeof value !== 'object' || Array.isArray(value)) return { kind: 'invalid' }
  const stored = value as { rules?: unknown; setName?: unknown; frozenAt?: unknown }
  if (typeof stored.frozenAt !== 'string' || !Array.isArray(stored.rules)) return { kind: 'invalid' }
  const parsed = stored.rules.length === 0 ? [] : parseFrozenRules(stored.rules)
  if (parsed === null) return { kind: 'invalid' }
  return {
    kind: 'frozen', setName: typeof stored.setName === 'string' ? stored.setName : null,
    rules: parsed.map((rule): CancellationRule => ('penaltyPercent' in rule ? { daysBeforeCheckin: rule.daysBeforeCheckin, penaltyPercent: rule.penaltyPercent } : { daysBeforeCheckin: rule.daysBeforeCheckin, penaltyMinor: BigInt(rule.penaltyMinor ?? '0') } as CancellationRule)),
  }
}
