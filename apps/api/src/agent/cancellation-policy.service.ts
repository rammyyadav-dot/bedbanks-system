import { Injectable } from '@nestjs/common'

export type CancellationRule = {
  daysBeforeCheckin: number
  penaltyPercent?: number
  penaltyMinor?: bigint
  currency?: string
}

export type ChildPolicyRule = {
  minAge: number
  maxAge: number
  supplementMinor?: bigint
  currency?: string
}

export type MandatorySupplementRule = {
  id: string
  kind: 'gala' | 'meal' | 'mandatory'
  applicableDate: string
  basis: 'per_person' | 'per_adult' | 'per_child' | 'per_room' | 'once_per_stay'
  amountMinor: bigint
  currency: string
}

export type CancellationQuote =
  | { status: 'quotable'; currency: string; cancellableAmountMinor: bigint; penaltyMinor: bigint; refundMinor: bigint; effectiveRule: CancellationRule | null; evaluatedAt: string }
  | { status: 'manual_review_required' | 'policy_unavailable'; reason: string; evaluatedAt: string }

export type CancellationQuoteInput = {
  cancellableAmountMinor: bigint
  currency: string
  checkIn: string
  requestedAt: string
  rules: CancellationRule[]
  propertyTimeZone?: string
  checkInLocalTime?: string
}

export type CommercialRuleResult =
  | { status: 'evaluated'; currency: string; childSupplementMinor: bigint; mandatorySupplementMinor: bigint; totalSupplementMinor: bigint }
  | { status: 'manual_review_required' | 'policy_unavailable'; reason: string }

const DAY_MS = 86_400_000
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const LOCAL_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/

const partsAt = (instant: Date, timeZone: string) => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(instant)
  return Object.fromEntries(parts.map(part => [part.type, part.value]))
}

const zonedLocalToUtc = (date: string, time: string, timeZone: string): number | undefined => {
  if (!ISO_DATE.test(date) || !LOCAL_TIME.test(time)) return undefined
  try {
    new Intl.DateTimeFormat('en', { timeZone }).format()
    const [year, month, day] = date.split('-').map(Number)
    const [hour, minute] = time.split(':').map(Number)
    const desired = Date.UTC(year, month - 1, day, hour, minute, 0)
    let guess = desired
    for (let i = 0; i < 4; i++) {
      const p = partsAt(new Date(guess), timeZone)
      const represented = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second))
      const delta = desired - represented
      guess += delta
      if (delta === 0) break
    }
    const p = partsAt(new Date(guess), timeZone)
    if (Number(p.year) !== year || Number(p.month) !== month || Number(p.day) !== day || Number(p.hour) !== hour || Number(p.minute) !== minute) return undefined
    return guess
  } catch { return undefined }
}

@Injectable()
export class CancellationPolicyService {
  quote(input: CancellationQuoteInput): CancellationQuote {
    const evaluatedAt = input.requestedAt
    if (input.cancellableAmountMinor < 0n) return { status: 'manual_review_required', reason: 'negative_cancellable_amount', evaluatedAt }
    const checkIn = input.propertyTimeZone
      ? zonedLocalToUtc(input.checkIn, input.checkInLocalTime ?? '00:00', input.propertyTimeZone)
      : Date.parse(`${input.checkIn}T00:00:00.000Z`)
    const requestedAt = Date.parse(input.requestedAt)
    if (checkIn === undefined || !Number.isFinite(checkIn) || !Number.isFinite(requestedAt)) return { status: 'manual_review_required', reason: 'invalid_timestamp_or_timezone', evaluatedAt }
    if (!input.rules.length) return { status: 'policy_unavailable', reason: 'missing_cancellation_policy', evaluatedAt }

    const applicable = input.rules
      .filter(rule => Number.isInteger(rule.daysBeforeCheckin) && rule.daysBeforeCheckin >= 0 && requestedAt >= checkIn - rule.daysBeforeCheckin * DAY_MS)
      .sort((a, b) => a.daysBeforeCheckin - b.daysBeforeCheckin)
    const rule = applicable[0]
    if (!rule) return { status: 'quotable', currency: input.currency, cancellableAmountMinor: input.cancellableAmountMinor, penaltyMinor: 0n, refundMinor: input.cancellableAmountMinor, effectiveRule: null, evaluatedAt }

    const hasPercent = rule.penaltyPercent !== undefined
    const hasFixed = rule.penaltyMinor !== undefined
    if (hasPercent === hasFixed) return { status: 'manual_review_required', reason: 'ambiguous_penalty_rule', evaluatedAt }
    if (rule.currency && rule.currency !== input.currency) return { status: 'manual_review_required', reason: 'penalty_currency_mismatch', evaluatedAt }

    let penaltyMinor: bigint
    if (hasPercent) {
      if (!Number.isInteger(rule.penaltyPercent) || rule.penaltyPercent! < 0 || rule.penaltyPercent! > 100) {
        return { status: 'manual_review_required', reason: 'invalid_penalty_percent', evaluatedAt }
      }
      penaltyMinor = (input.cancellableAmountMinor * BigInt(rule.penaltyPercent!)) / 100n
    } else {
      if (rule.penaltyMinor! < 0n) return { status: 'manual_review_required', reason: 'negative_penalty', evaluatedAt }
      penaltyMinor = rule.penaltyMinor!
    }
    if (penaltyMinor > input.cancellableAmountMinor) penaltyMinor = input.cancellableAmountMinor
    return { status: 'quotable', currency: input.currency, cancellableAmountMinor: input.cancellableAmountMinor, penaltyMinor,
      refundMinor: input.cancellableAmountMinor - penaltyMinor, effectiveRule: rule, evaluatedAt }
  }

  evaluateCommercialRules(input: { currency: string; childAges: number[]; adults: number; rooms: number; checkIn: string; checkOut: string;
    childPolicies: ChildPolicyRule[]; supplements: MandatorySupplementRule[] }): CommercialRuleResult {
    if (!ISO_DATE.test(input.checkIn) || !ISO_DATE.test(input.checkOut) || input.checkOut <= input.checkIn ||
      !Number.isInteger(input.adults) || input.adults < 1 || !Number.isInteger(input.rooms) || input.rooms < 1 ||
      input.childAges.some(age => !Number.isInteger(age) || age < 0 || age > 17)) {
      return { status: 'manual_review_required', reason: 'invalid_occupancy_or_stay' }
    }

    let childSupplementMinor = 0n
    for (const age of input.childAges) {
      const matches = input.childPolicies.filter(policy => age >= policy.minAge && age <= policy.maxAge)
      if (matches.length !== 1) return { status: matches.length ? 'manual_review_required' : 'policy_unavailable', reason: matches.length ? 'overlapping_child_policy' : 'missing_child_policy' }
      const policy = matches[0]
      if (policy.minAge < 0 || policy.maxAge < policy.minAge || policy.maxAge > 17 || (policy.currency && policy.currency !== input.currency) || (policy.supplementMinor ?? 0n) < 0n) {
        return { status: 'manual_review_required', reason: 'invalid_child_policy' }
      }
      childSupplementMinor += policy.supplementMinor ?? 0n
    }

    let mandatorySupplementMinor = 0n
    const seen = new Set<string>()
    for (const supplement of input.supplements) {
      if (seen.has(supplement.id)) continue
      seen.add(supplement.id)
      if (!supplement.id.trim() || !ISO_DATE.test(supplement.applicableDate) || supplement.amountMinor < 0n || supplement.currency !== input.currency) {
        return { status: 'manual_review_required', reason: 'invalid_mandatory_supplement' }
      }
      if (supplement.applicableDate < input.checkIn || supplement.applicableDate >= input.checkOut) continue
      const units = supplement.basis === 'per_person' ? input.adults + input.childAges.length
        : supplement.basis === 'per_adult' ? input.adults
        : supplement.basis === 'per_child' ? input.childAges.length
        : supplement.basis === 'per_room' ? input.rooms : 1
      mandatorySupplementMinor += supplement.amountMinor * BigInt(units)
    }
    return { status: 'evaluated', currency: input.currency, childSupplementMinor, mandatorySupplementMinor,
      totalSupplementMinor: childSupplementMinor + mandatorySupplementMinor }
  }
}
