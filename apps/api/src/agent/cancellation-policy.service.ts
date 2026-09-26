import { Injectable } from '@nestjs/common'

export type CancellationRule = {
  daysBeforeCheckin: number
  penaltyPercent?: number
  penaltyMinor?: bigint
  currency?: string
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
}

const DAY_MS = 86_400_000

@Injectable()
export class CancellationPolicyService {
  quote(input: CancellationQuoteInput): CancellationQuote {
    const evaluatedAt = input.requestedAt
    if (input.cancellableAmountMinor < 0n) return { status: 'manual_review_required', reason: 'negative_cancellable_amount', evaluatedAt }
    const checkIn = Date.parse(`${input.checkIn}T00:00:00.000Z`)
    const requestedAt = Date.parse(input.requestedAt)
    if (!Number.isFinite(checkIn) || !Number.isFinite(requestedAt)) return { status: 'manual_review_required', reason: 'invalid_timestamp', evaluatedAt }
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
}
