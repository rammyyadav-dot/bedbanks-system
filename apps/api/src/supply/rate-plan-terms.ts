/**
 * Rate plan sale window and payment type (ADR 0057). Pure: no I/O, no clock.
 *
 * A plan may narrow the contract term with `validFrom` / `validTo` (YYYY-MM-DD, inclusive). A null side inherits the contract on that side.
 * The window can never extend the contract. Payment type is recorded as given and never defaulted: null means "not recorded".
 */
export const RATE_PAYMENT_TYPES = ['PREPAID', 'PAY_AT_HOTEL'] as const
export type RatePaymentTypeValue = (typeof RATE_PAYMENT_TYPES)[number]

export interface PlanTerms { validFrom: string | null; validTo: string | null; paymentType: RatePaymentTypeValue | null }
export interface TermsInput { validFrom?: unknown; validTo?: unknown; paymentType?: unknown }
export type TermsResult = { ok: true; terms: PlanTerms } | { ok: false; code: string; message: string }

const DAY = /^\d{4}-\d{2}-\d{2}$/
/** Strict calendar day: 2026-02-30 is refused rather than normalized to March. */
export function isCalendarDay(value: unknown): value is string {
  if (typeof value !== 'string' || !DAY.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

const fail = (code: string, message: string): TermsResult => ({ ok: false, code, message })

/**
 * Merges the request over the current terms (a key left out keeps the current value; an explicit null clears it) and validates the result
 * against the contract term. `current` is the stored plan, or all-null for a create.
 */
export function resolvePlanTerms(input: TermsInput, current: PlanTerms, contract: { validFrom: string; validTo: string }): TermsResult {
  const pick = (key: keyof TermsInput, fallback: unknown) => (Object.prototype.hasOwnProperty.call(input, key) ? input[key] : fallback)
  const validFrom = pick('validFrom', current.validFrom)
  const validTo = pick('validTo', current.validTo)
  const paymentType = pick('paymentType', current.paymentType)
  if (validFrom !== null && !isCalendarDay(validFrom)) return fail('RATE_PLAN_VALIDITY_INVALID', 'validFrom must be a real calendar day (YYYY-MM-DD) or null.')
  if (validTo !== null && !isCalendarDay(validTo)) return fail('RATE_PLAN_VALIDITY_INVALID', 'validTo must be a real calendar day (YYYY-MM-DD) or null.')
  if (validFrom !== null && validTo !== null && validTo < validFrom) return fail('RATE_PLAN_VALIDITY_INVALID', 'validTo is before validFrom.')
  if (validFrom !== null && validFrom < contract.validFrom) return fail('RATE_PLAN_VALIDITY_OUTSIDE_CONTRACT', `validFrom ${validFrom} is before the contract term starts (${contract.validFrom}).`)
  if (validTo !== null && validTo > contract.validTo) return fail('RATE_PLAN_VALIDITY_OUTSIDE_CONTRACT', `validTo ${validTo} is after the contract term ends (${contract.validTo}).`)
  if (paymentType !== null && !(RATE_PAYMENT_TYPES as readonly unknown[]).includes(paymentType)) return fail('RATE_PLAN_PAYMENT_TYPE_INVALID', `paymentType must be one of ${RATE_PAYMENT_TYPES.join(', ')} or null.`)
  return { ok: true, terms: { validFrom: validFrom as string | null, validTo: validTo as string | null, paymentType: paymentType as RatePaymentTypeValue | null } }
}
