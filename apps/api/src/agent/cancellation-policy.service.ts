import { Injectable } from '@nestjs/common'

export type CancellationRule = {
  daysBeforeCheckin: number
  penaltyPercent?: number
  penaltyMinor?: bigint
  /** ADR 0067 F-10: a number of the stay's nights, charged pro rata of the cancellable amount. Exactly one of percent, amount or nights. */
  penaltyNights?: number
  currency?: string
}

/** A no-show penalty: what is charged when the guest does not arrive (ADR 0067, F-10). Exactly one form. */
export type NoShowPenalty = { penaltyPercent: number } | { penaltyMinor: bigint } | { penaltyNights: number }

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
  /** Nights in the stay. Required for a nights penalty; without it such a rule is manual review, never free. */
  stayNights?: number
}

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

const MAX_PENALTY_NIGHTS = 30
const penaltyForms = (rule: { penaltyPercent?: unknown; penaltyMinor?: unknown; penaltyNights?: unknown }) => [rule.penaltyPercent, rule.penaltyMinor, rule.penaltyNights].filter((v) => v !== undefined).length

/**
 * The one deadline instant (ADR 0067, F-10): a tier of `days` starts at 00:00 hotel-local time on the day `days` before check-in. The offer's free
 * cancellation deadline, the cancellation quote and the "stay has started" cut-off all use it, so they cannot disagree. Undefined fails closed.
 */
export function penaltyStartsAt(checkIn: string, days: number, timeZone: string): number | undefined {
  if (!ISO_DATE.test(checkIn) || !Number.isInteger(days) || days < 0) return undefined
  const [year, month, day] = checkIn.split('-').map(Number)
  const start = new Date(Date.UTC(year, month - 1, day))
  if (Number.isNaN(start.getTime())) return undefined
  start.setUTCDate(start.getUTCDate() - days)
  return zonedLocalToUtc(start.toISOString().slice(0, 10), '00:00', timeZone)
}

/** The tiers a buyer is sold: the hotel's, each starting `bufferDays` earlier (ADR 0067, F-10). A buffer of 0 returns the rules unchanged. */
export function buyerRules<T extends { daysBeforeCheckin: number }>(rules: readonly T[], bufferDays: number): T[] {
  return bufferDays > 0 ? rules.map((rule) => ({ ...rule, daysBeforeCheckin: rule.daysBeforeCheckin + bufferDays })) : [...rules]
}

/** Penalty in minor units for `nights` of a stay of `stayNights`, pro rata of `amount`, rounded down; capped at the whole stay. */
export function nightsPenalty(amount: bigint, nights: number, stayNights: number): bigint {
  return (amount * BigInt(Math.min(nights, stayNights))) / BigInt(stayNights)
}

/** "1 night", "50% of the booking total", "AED 120.00": how a penalty reads to a buyer. */
export function describePenalty(rule: { penaltyPercent?: number | null; penaltyMinor?: bigint | string | null; penaltyNights?: number | null }, money: (minor: string) => string): string {
  if (rule.penaltyNights != null) return `${rule.penaltyNights} night${rule.penaltyNights === 1 ? '' : 's'} (pro rata of the booking total)`
  if (rule.penaltyPercent != null) return `${rule.penaltyPercent}% of the booking total`
  return money(String(rule.penaltyMinor ?? '0'))
}

@Injectable()
export class CancellationPolicyService {
  /**
   * Instant when a positive penalty first applies, in the property timezone.
   * Returns undefined when the rate is not refundable or the rules do not define one unambiguous deadline.
   */
  freeCancellationDeadline(input: { refundable: boolean; checkIn: string; timeZone: string; rules: CancellationRule[] }): string | undefined {
    if (!input.refundable || !ISO_DATE.test(input.checkIn) || input.rules.length === 0) return undefined
    let earliestDays: number | undefined
    for (const rule of input.rules) {
      if (!Number.isInteger(rule.daysBeforeCheckin) || rule.daysBeforeCheckin < 0) return undefined
      const hasPercent = rule.penaltyPercent !== undefined
      const hasFixed = rule.penaltyMinor !== undefined
      const hasNights = rule.penaltyNights !== undefined
      if (penaltyForms(rule) !== 1) return undefined
      if (hasPercent && (!Number.isInteger(rule.penaltyPercent) || rule.penaltyPercent! < 0 || rule.penaltyPercent! > 100)) return undefined
      if (hasFixed && rule.penaltyMinor! < 0n) return undefined
      if (hasNights && (!Number.isInteger(rule.penaltyNights) || rule.penaltyNights! < 1 || rule.penaltyNights! > MAX_PENALTY_NIGHTS)) return undefined
      const penalises = (hasPercent && rule.penaltyPercent! > 0) || (hasFixed && rule.penaltyMinor! > 0n) || hasNights
      if (!penalises) continue
      if (earliestDays === undefined || rule.daysBeforeCheckin > earliestDays) earliestDays = rule.daysBeforeCheckin
    }
    if (earliestDays === undefined) return undefined
    const instant = penaltyStartsAt(input.checkIn, earliestDays, input.timeZone)
    return instant === undefined ? undefined : new Date(instant).toISOString()
  }

  /**
   * The whole penalty timeline of a booking, earliest tier first: free until the first penalising tier starts, then each tier's start instant, penalty and refund.
   * Every tier is priced by `quote` at its own start instant, so the schedule cannot disagree with a quote taken at that moment. Fails closed (undefined) on any rule or
   * input `quote` would send to manual review, so a partial schedule is never shown as complete.
   */
  penaltySchedule(input: Omit<CancellationQuoteInput, 'requestedAt'>): Array<{ startsAt: string | null; penaltyMinor: bigint; refundMinor: bigint }> | undefined {
    const timeZone = input.propertyTimeZone ?? 'UTC'
    if (!input.rules.length) return undefined
    const starts = [...new Set(input.rules.map((rule) => rule.daysBeforeCheckin))].sort((a, b) => b - a)
    const tiers: Array<{ startsAt: string | null; penaltyMinor: bigint; refundMinor: bigint }> = []
    for (const days of starts) {
      const instant = penaltyStartsAt(input.checkIn, days, timeZone)
      if (instant === undefined) return undefined
      const quote = this.quote({ ...input, requestedAt: new Date(instant).toISOString() })
      if (quote.status !== 'quotable') return undefined
      tiers.push({ startsAt: new Date(instant).toISOString(), penaltyMinor: quote.penaltyMinor, refundMinor: quote.refundMinor })
    }
    // Before the earliest tier starts the booking is free to cancel, unless that tier is itself free (then it is the free tier and needs no lead-in).
    if (tiers[0].penaltyMinor !== 0n) tiers.unshift({ startsAt: null, penaltyMinor: 0n, refundMinor: input.cancellableAmountMinor })
    return tiers
  }

  quote(input: CancellationQuoteInput): CancellationQuote {
    const evaluatedAt = input.requestedAt
    if (input.cancellableAmountMinor < 0n) return { status: 'manual_review_required', reason: 'negative_cancellable_amount', evaluatedAt }
    const timeZone = input.propertyTimeZone ?? 'UTC'
    const checkIn = penaltyStartsAt(input.checkIn, 0, timeZone)
    const requestedAt = Date.parse(input.requestedAt)
    if (checkIn === undefined || !Number.isFinite(checkIn) || !Number.isFinite(requestedAt)) return { status: 'manual_review_required', reason: 'invalid_timestamp_or_timezone', evaluatedAt }
    if (!input.rules.length) return { status: 'policy_unavailable', reason: 'missing_cancellation_policy', evaluatedAt }

    // The same instant as the offer's deadline: hotel-local midnight of the tier's first day.
    const applicable = input.rules
      .filter(rule => { const starts = penaltyStartsAt(input.checkIn, rule.daysBeforeCheckin, timeZone); return starts !== undefined && requestedAt >= starts })
      .sort((a, b) => a.daysBeforeCheckin - b.daysBeforeCheckin)
    const rule = applicable[0]
    if (!rule) return { status: 'quotable', currency: input.currency, cancellableAmountMinor: input.cancellableAmountMinor, penaltyMinor: 0n, refundMinor: input.cancellableAmountMinor, effectiveRule: null, evaluatedAt }

    const hasPercent = rule.penaltyPercent !== undefined
    if (penaltyForms(rule) !== 1) return { status: 'manual_review_required', reason: 'ambiguous_penalty_rule', evaluatedAt }
    if (rule.currency && rule.currency !== input.currency) return { status: 'manual_review_required', reason: 'penalty_currency_mismatch', evaluatedAt }

    let penaltyMinor: bigint
    if (hasPercent) {
      if (!Number.isInteger(rule.penaltyPercent) || rule.penaltyPercent! < 0 || rule.penaltyPercent! > 100) {
        return { status: 'manual_review_required', reason: 'invalid_penalty_percent', evaluatedAt }
      }
      penaltyMinor = (input.cancellableAmountMinor * BigInt(rule.penaltyPercent!)) / 100n
    } else if (rule.penaltyNights !== undefined) {
      if (!Number.isInteger(rule.penaltyNights) || rule.penaltyNights < 1 || rule.penaltyNights > MAX_PENALTY_NIGHTS) return { status: 'manual_review_required', reason: 'invalid_penalty_nights', evaluatedAt }
      if (!Number.isInteger(input.stayNights) || input.stayNights! < 1) return { status: 'manual_review_required', reason: 'stay_nights_unknown', evaluatedAt }
      penaltyMinor = nightsPenalty(input.cancellableAmountMinor, rule.penaltyNights, input.stayNights!)
    } else {
      if (rule.penaltyMinor! < 0n) return { status: 'manual_review_required', reason: 'negative_penalty', evaluatedAt }
      penaltyMinor = rule.penaltyMinor!
    }
    if (penaltyMinor > input.cancellableAmountMinor) penaltyMinor = input.cancellableAmountMinor
    return { status: 'quotable', currency: input.currency, cancellableAmountMinor: input.cancellableAmountMinor, penaltyMinor,
      refundMinor: input.cancellableAmountMinor - penaltyMinor, effectiveRule: rule, evaluatedAt }
  }
}
