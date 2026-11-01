import { Injectable } from '@nestjs/common'

export type CancellationPenaltyType = 'ZERO' | 'PERCENTAGE' | 'NIGHTS' | 'FIXED' | 'FULL_AMOUNT'
export type CancellationPolicyType = 'REFUNDABLE' | 'NON_REFUNDABLE' | 'CONDITIONAL'
export type CancellationPolicyResolution = 'RESOLVED' | 'UNRESOLVED' | 'CONFLICTED'
export type CancellationDeadlineSemantics = 'CALENDAR_DAYS_AT_LOCAL_TIME' | 'ELAPSED_HOURS'

export type CancellationRule = {
  daysBeforeCheckin: number
  penaltyPercent?: number
  penaltyMinor?: bigint
  penaltyNights?: number
  currency?: string
}

export type CancellationSimulationRule = {
  daysBeforeCheckin?: number
  elapsedHoursBeforeCheckin?: number
  penaltyType?: CancellationPenaltyType
  penaltyPercent?: number
  penaltyMinor?: bigint
  penaltyNights?: number
  currency?: string
}

export type CancellationSimulationInput = {
  cancellableAmountMinor: bigint
  nightlyAmountsMinor?: bigint[]
  currency: string
  checkIn: string
  requestedAt: string
  policyType?: CancellationPolicyType
  deadlineSemantics?: CancellationDeadlineSemantics
  propertyTimeZone?: string
  checkInLocalTime?: string
  customerAmountPaidMinor?: bigint
  retainedFeesMinor?: bigint
  priorRefundsMinor?: bigint
  supplierCancellableAmountMinor?: bigint
  supplierPenaltyOverrideMinor?: bigint
  rules: CancellationSimulationRule[]
}

export type CancellationSimulationOutput = {
  status: 'quotable' | 'manual_review_required' | 'policy_unavailable'
  policyType: CancellationPolicyType
  policyResolution: CancellationPolicyResolution
  reason?: string
  evaluatedAt: string
  propertyTimeZone: string
  checkInLocalTime: string
  deadlineSemantics: CancellationDeadlineSemantics
  freeCancellationDeadlineUtc: string | null
  selectedWindowDeadlineUtc: string | null
  selectedPenaltyType: CancellationPenaltyType | null
  currency: string
  cancellableAmountMinor: bigint
  penaltyMinor: bigint
  refundMinor: bigint
  customerCancellationLiabilityMinor: bigint
  customerRefundEntitlementMinor: bigint
  customerRefundPayableMinor: bigint
  settlementBalanceMinor: bigint
  supplierPenaltyMinor: bigint
  supplierExpectedCreditMinor: bigint
  discrepancyReviewRequired: boolean
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
const HOUR_MS = 3_600_000
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const LOCAL_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/

const subtractCalendarDays = (isoDate: string, days: number): string | undefined => {
  if (!ISO_DATE.test(isoDate) || !Number.isInteger(days) || days < 0) return undefined
  const [year, month, day] = isoDate.split('-').map(Number)
  const utc = new Date(Date.UTC(year, month - 1, day - days))
  if (Number.isNaN(utc.getTime())) return undefined
  return utc.toISOString().slice(0, 10)
}

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

  simulate(input: CancellationSimulationInput): CancellationSimulationOutput {
    const evaluatedAt = input.requestedAt
    const policyType: CancellationPolicyType = input.policyType ?? 'REFUNDABLE'
    const deadlineSemantics: CancellationDeadlineSemantics = input.deadlineSemantics ?? 'CALENDAR_DAYS_AT_LOCAL_TIME'
    const propertyTimeZone = input.propertyTimeZone ?? 'UTC'
    const checkInLocalTime = input.checkInLocalTime ?? '00:00'
    const fail = (
      status: 'manual_review_required' | 'policy_unavailable',
      policyResolution: CancellationPolicyResolution,
      reason: string,
    ): CancellationSimulationOutput => ({
      status,
      policyType,
      policyResolution,
      reason,
      evaluatedAt,
      propertyTimeZone,
      checkInLocalTime,
      deadlineSemantics,
      freeCancellationDeadlineUtc: null,
      selectedWindowDeadlineUtc: null,
      selectedPenaltyType: null,
      currency: input.currency,
      cancellableAmountMinor: input.cancellableAmountMinor,
      penaltyMinor: 0n,
      refundMinor: 0n,
      customerCancellationLiabilityMinor: 0n,
      customerRefundEntitlementMinor: 0n,
      customerRefundPayableMinor: 0n,
      settlementBalanceMinor: 0n,
      supplierPenaltyMinor: 0n,
      supplierExpectedCreditMinor: 0n,
      discrepancyReviewRequired: false,
    })

    if (input.cancellableAmountMinor < 0n) return fail('manual_review_required', 'CONFLICTED', 'negative_cancellable_amount')
    const retainedFeesMinor = input.retainedFeesMinor ?? 0n
    const priorRefundsMinor = input.priorRefundsMinor ?? 0n
    const customerAmountPaidMinor = input.customerAmountPaidMinor ?? (input.cancellableAmountMinor + retainedFeesMinor)
    const supplierCancellableAmountMinor = input.supplierCancellableAmountMinor ?? input.cancellableAmountMinor
    if (retainedFeesMinor < 0n || priorRefundsMinor < 0n || customerAmountPaidMinor < 0n || supplierCancellableAmountMinor < 0n) {
      return fail('manual_review_required', 'CONFLICTED', 'negative_financial_component')
    }
    if (priorRefundsMinor > customerAmountPaidMinor) {
      return fail('manual_review_required', 'CONFLICTED', 'excess_prior_refund')
    }
    if (input.supplierPenaltyOverrideMinor !== undefined && input.supplierPenaltyOverrideMinor < 0n) {
      return fail('manual_review_required', 'CONFLICTED', 'negative_penalty')
    }
    if (input.nightlyAmountsMinor) {
      if (input.nightlyAmountsMinor.some(night => night < 0n)) {
        return fail('manual_review_required', 'CONFLICTED', 'negative_nightly_amount')
      }
      const nightlySum = input.nightlyAmountsMinor.reduce((acc, item) => acc + item, 0n)
      if (nightlySum > input.cancellableAmountMinor) {
        return fail('manual_review_required', 'CONFLICTED', 'nightly_breakdown_exceeds_total')
      }
    }

    const checkInInstant = zonedLocalToUtc(input.checkIn, checkInLocalTime, propertyTimeZone)
    const requestedAt = Date.parse(input.requestedAt)
    if (checkInInstant === undefined || !Number.isFinite(checkInInstant) || !Number.isFinite(requestedAt)) {
      return fail('manual_review_required', 'CONFLICTED', 'invalid_timestamp_or_timezone')
    }

    if (policyType === 'NON_REFUNDABLE' && !input.rules.length) {
      const penaltyMinor = input.cancellableAmountMinor
      const refundMinor = 0n
      const customerCancellationLiabilityMinor = penaltyMinor + retainedFeesMinor
      const netCollectionsMinor = customerAmountPaidMinor - priorRefundsMinor
      const settlementBalanceMinor = netCollectionsMinor - customerCancellationLiabilityMinor
      const customerRefundEntitlementMinor = settlementBalanceMinor > 0n ? settlementBalanceMinor : 0n
      const supplierPenaltyMinor = input.supplierPenaltyOverrideMinor !== undefined
        ? (input.supplierPenaltyOverrideMinor > supplierCancellableAmountMinor ? supplierCancellableAmountMinor : input.supplierPenaltyOverrideMinor)
        : supplierCancellableAmountMinor
      const supplierExpectedCreditMinor = supplierCancellableAmountMinor > supplierPenaltyMinor ? supplierCancellableAmountMinor - supplierPenaltyMinor : 0n
      return {
        status: 'quotable',
        policyType,
        policyResolution: 'RESOLVED',
        evaluatedAt,
        propertyTimeZone,
        checkInLocalTime,
        deadlineSemantics,
        freeCancellationDeadlineUtc: null,
        selectedWindowDeadlineUtc: null,
        selectedPenaltyType: 'FULL_AMOUNT',
        currency: input.currency,
        cancellableAmountMinor: input.cancellableAmountMinor,
        penaltyMinor,
        refundMinor,
        customerCancellationLiabilityMinor,
        customerRefundEntitlementMinor,
        customerRefundPayableMinor: customerRefundEntitlementMinor,
        settlementBalanceMinor,
        supplierPenaltyMinor,
        supplierExpectedCreditMinor,
        discrepancyReviewRequired: supplierPenaltyMinor > customerCancellationLiabilityMinor,
      }
    }

    if (!input.rules.length) {
      return fail('policy_unavailable', 'UNRESOLVED', 'missing_cancellation_policy')
    }

    type NormalizedWindow = {
      deadlineUtcMs: number
      penaltyType: CancellationPenaltyType
      customerPenaltyMinor: bigint
      supplierPenaltyMinor: bigint
      signature: string
    }
    const windows: NormalizedWindow[] = []
    for (const rule of input.rules) {
      if (rule.currency && rule.currency !== input.currency) {
        return fail('manual_review_required', 'CONFLICTED', 'penalty_currency_mismatch')
      }
      let deadlineUtcMs: number | undefined
      if (deadlineSemantics === 'ELAPSED_HOURS') {
        const hours = rule.elapsedHoursBeforeCheckin !== undefined
          ? rule.elapsedHoursBeforeCheckin
          : (rule.daysBeforeCheckin !== undefined && Number.isInteger(rule.daysBeforeCheckin) ? rule.daysBeforeCheckin * 24 : undefined)
        if (hours === undefined || !Number.isInteger(hours) || hours < 0) {
          return fail('manual_review_required', 'CONFLICTED', 'invalid_window_deadline')
        }
        deadlineUtcMs = checkInInstant - hours * HOUR_MS
      } else {
        if (rule.daysBeforeCheckin === undefined || !Number.isInteger(rule.daysBeforeCheckin) || rule.daysBeforeCheckin < 0) {
          return fail('manual_review_required', 'CONFLICTED', 'invalid_window_deadline')
        }
        const deadlineDate = subtractCalendarDays(input.checkIn, rule.daysBeforeCheckin)
        if (!deadlineDate) return fail('manual_review_required', 'CONFLICTED', 'invalid_window_deadline')
        deadlineUtcMs = zonedLocalToUtc(deadlineDate, checkInLocalTime, propertyTimeZone)
      }
      if (deadlineUtcMs === undefined || !Number.isFinite(deadlineUtcMs)) {
        return fail('manual_review_required', 'CONFLICTED', 'invalid_timestamp_or_timezone')
      }

      const definedKinds = [
        rule.penaltyPercent !== undefined,
        rule.penaltyMinor !== undefined,
        rule.penaltyNights !== undefined,
      ].filter(Boolean).length

      let penaltyType = rule.penaltyType
      if (!penaltyType) {
        if (definedKinds !== 1) return fail('manual_review_required', 'CONFLICTED', 'ambiguous_penalty_rule')
        if (rule.penaltyPercent !== undefined) penaltyType = 'PERCENTAGE'
        else if (rule.penaltyMinor !== undefined) penaltyType = 'FIXED'
        else penaltyType = 'NIGHTS'
      }

      let customerPenaltyMinor = 0n
      let supplierPenaltyMinor = 0n
      if (penaltyType === 'ZERO') {
        if (definedKinds > 0 && rule.penaltyPercent !== 0 && rule.penaltyMinor !== 0n) {
          return fail('manual_review_required', 'CONFLICTED', 'ambiguous_penalty_rule')
        }
        customerPenaltyMinor = 0n
        supplierPenaltyMinor = 0n
      } else if (penaltyType === 'FULL_AMOUNT') {
        if (definedKinds > 0 && rule.penaltyPercent !== 100) {
          return fail('manual_review_required', 'CONFLICTED', 'ambiguous_penalty_rule')
        }
        customerPenaltyMinor = input.cancellableAmountMinor
        supplierPenaltyMinor = supplierCancellableAmountMinor
      } else if (penaltyType === 'PERCENTAGE') {
        if (rule.penaltyMinor !== undefined || rule.penaltyNights !== undefined || !Number.isInteger(rule.penaltyPercent) || rule.penaltyPercent! < 0 || rule.penaltyPercent! > 100) {
          return fail('manual_review_required', 'CONFLICTED', 'invalid_penalty_percent')
        }
        customerPenaltyMinor = (input.cancellableAmountMinor * BigInt(rule.penaltyPercent!)) / 100n
        supplierPenaltyMinor = (supplierCancellableAmountMinor * BigInt(rule.penaltyPercent!)) / 100n
      } else if (penaltyType === 'FIXED') {
        if (rule.penaltyPercent !== undefined || rule.penaltyNights !== undefined || rule.penaltyMinor === undefined) {
          return fail('manual_review_required', 'CONFLICTED', 'ambiguous_penalty_rule')
        }
        if (rule.penaltyMinor < 0n) return fail('manual_review_required', 'CONFLICTED', 'negative_penalty')
        customerPenaltyMinor = rule.penaltyMinor
        supplierPenaltyMinor = rule.penaltyMinor
      } else if (penaltyType === 'NIGHTS') {
        if (rule.penaltyPercent !== undefined || rule.penaltyMinor !== undefined || !Number.isInteger(rule.penaltyNights) || rule.penaltyNights! < 1) {
          return fail('manual_review_required', 'CONFLICTED', 'invalid_penalty_nights')
        }
        if (!input.nightlyAmountsMinor || input.nightlyAmountsMinor.length < rule.penaltyNights!) {
          return fail('manual_review_required', 'UNRESOLVED', 'missing_nightly_breakdown')
        }
        customerPenaltyMinor = input.nightlyAmountsMinor.slice(0, rule.penaltyNights!).reduce((acc, item) => acc + item, 0n)
        supplierPenaltyMinor = customerPenaltyMinor
      }

      if (customerPenaltyMinor > input.cancellableAmountMinor) customerPenaltyMinor = input.cancellableAmountMinor
      if (supplierPenaltyMinor > supplierCancellableAmountMinor) supplierPenaltyMinor = supplierCancellableAmountMinor

      windows.push({
        deadlineUtcMs,
        penaltyType,
        customerPenaltyMinor,
        supplierPenaltyMinor,
        signature: `${penaltyType}:${customerPenaltyMinor.toString()}`,
      })
    }

    const byDeadline = new Map<number, string>()
    for (const win of windows) {
      const existing = byDeadline.get(win.deadlineUtcMs)
      if (existing !== undefined && existing !== win.signature) {
        return fail('manual_review_required', 'CONFLICTED', 'conflicting_penalty_windows')
      }
      byDeadline.set(win.deadlineUtcMs, win.signature)
    }

    const positivePenaltyWindows = windows.filter(win => win.customerPenaltyMinor > 0n).sort((a, b) => a.deadlineUtcMs - b.deadlineUtcMs)
    const freeCancellationDeadlineUtc = policyType === 'NON_REFUNDABLE'
      ? null
      : (positivePenaltyWindows[0] ? new Date(positivePenaltyWindows[0].deadlineUtcMs).toISOString() : new Date(checkInInstant).toISOString())

    // Half-open interval semantics: effective_from <= requestedAt < effective_to
    // Among all windows whose deadline has been reached (requestedAt >= deadlineUtcMs), select the latest deadline (closest to check-in).
    const activeWindows = windows
      .filter(win => requestedAt >= win.deadlineUtcMs)
      .sort((a, b) => b.deadlineUtcMs - a.deadlineUtcMs)
    const selected = activeWindows[0] ?? null

    const penaltyMinor = selected ? selected.customerPenaltyMinor : (policyType === 'NON_REFUNDABLE' ? input.cancellableAmountMinor : 0n)
    const refundMinor = input.cancellableAmountMinor - penaltyMinor
    const selectedPenaltyType: CancellationPenaltyType = selected ? selected.penaltyType : (policyType === 'NON_REFUNDABLE' ? 'FULL_AMOUNT' : 'ZERO')
    const customerCancellationLiabilityMinor = penaltyMinor + retainedFeesMinor
    const netCollectionsMinor = customerAmountPaidMinor - priorRefundsMinor
    const settlementBalanceMinor = netCollectionsMinor - customerCancellationLiabilityMinor
    const customerRefundEntitlementMinor = settlementBalanceMinor > 0n ? settlementBalanceMinor : 0n
    const rawSupplierPenalty = input.supplierPenaltyOverrideMinor !== undefined
      ? input.supplierPenaltyOverrideMinor
      : (selected ? selected.supplierPenaltyMinor : (policyType === 'NON_REFUNDABLE' ? supplierCancellableAmountMinor : 0n))
    const supplierPenaltyMinor = rawSupplierPenalty > supplierCancellableAmountMinor ? supplierCancellableAmountMinor : rawSupplierPenalty
    const supplierExpectedCreditMinor = supplierCancellableAmountMinor > supplierPenaltyMinor ? supplierCancellableAmountMinor - supplierPenaltyMinor : 0n

    return {
      status: 'quotable',
      policyType,
      policyResolution: 'RESOLVED',
      evaluatedAt,
      propertyTimeZone,
      checkInLocalTime,
      deadlineSemantics,
      freeCancellationDeadlineUtc,
      selectedWindowDeadlineUtc: selected ? new Date(selected.deadlineUtcMs).toISOString() : null,
      selectedPenaltyType,
      currency: input.currency,
      cancellableAmountMinor: input.cancellableAmountMinor,
      penaltyMinor,
      refundMinor,
      customerCancellationLiabilityMinor,
      customerRefundEntitlementMinor,
      customerRefundPayableMinor: customerRefundEntitlementMinor,
      settlementBalanceMinor,
      supplierPenaltyMinor,
      supplierExpectedCreditMinor,
      discrepancyReviewRequired: supplierPenaltyMinor > customerCancellationLiabilityMinor,
    }
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
