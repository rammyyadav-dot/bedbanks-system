import { BadRequestException } from '@nestjs/common'
import {
  FUNDING_METHODS, FUNDING_PAYER_TYPES, FUNDING_SECOND_APPROVAL_THRESHOLD_MINOR,
  type FundingDeclareRequest, type FundingMethod, type FundingPayerType,
} from '@bedbanks/contracts'
import { assertSupportedSettlementCurrency } from '../agent/currency'

const MINOR = /^[1-9][0-9]{0,17}$/
const DAY = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 86_400_000
/** A value date may be today (any time zone) and at most a year old. */
const MAX_AGE_DAYS = 366

export interface ValidDeclaration {
  currency: string; amountMinor: bigint; method: FundingMethod; bankReference: string; valueDate: Date
  payerName: string; payerType: FundingPayerType; notes: string | null; requestId: string
  complianceReviewRequired: boolean; secondApprovalRequired: boolean
}

/** Owner decision (2026-10-04): cash deposits and payments from anyone other than the agency are allowed but need a compliance review. */
export const complianceReviewRequired = (method: FundingMethod, payerType: FundingPayerType) => method === 'CASH_DEPOSIT' || payerType === 'THIRD_PARTY'

/** More than the threshold needs a second approver. A currency without a configured threshold always needs one (fail closed). */
export function secondApprovalRequired(currency: string, amountMinor: bigint): boolean {
  const threshold = FUNDING_SECOND_APPROVAL_THRESHOLD_MINOR[currency]
  return threshold === undefined || amountMinor > BigInt(threshold)
}

function text(name: string, value: unknown, max: number, required: boolean): string | null {
  if (value === undefined || value === null || value === '') {
    if (required) throw new BadRequestException(`${name} is required`)
    return null
  }
  if (typeof value !== 'string') throw new BadRequestException(`${name} must be text`)
  const trimmed = value.trim().replace(/\s+/g, ' ')
  if (required && trimmed.length === 0) throw new BadRequestException(`${name} is required`)
  if (trimmed.length > max) throw new BadRequestException(`${name} must be at most ${max} characters`)
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) throw new BadRequestException(`${name} contains control characters`)
  return trimmed.length ? trimmed : null
}

/** Validates an untrusted request body (JSON from Admin or the agent portal). */
export function validateDeclaration(body: unknown, now: Date = new Date()): ValidDeclaration {
  const b = (body && typeof body === 'object' ? body : {}) as { [K in keyof FundingDeclareRequest]?: unknown }
  if (typeof b.currency !== 'string' || !/^[A-Z]{3}$/.test(b.currency)) throw new BadRequestException('currency must be a 3-letter ISO-4217 code')
  assertSupportedSettlementCurrency(b.currency)
  if (typeof b.amountMinor !== 'string' || !MINOR.test(b.amountMinor)) throw new BadRequestException('amountMinor must be a positive whole number of minor units (a string of digits)')
  const amountMinor = BigInt(b.amountMinor)
  if (!(FUNDING_METHODS as readonly string[]).includes(b.method as string)) throw new BadRequestException(`method must be one of ${FUNDING_METHODS.join(', ')}`)
  if (!(FUNDING_PAYER_TYPES as readonly string[]).includes(b.payerType as string)) throw new BadRequestException(`payerType must be one of ${FUNDING_PAYER_TYPES.join(', ')}`)
  const method = b.method as FundingMethod
  const payerType = b.payerType as FundingPayerType
  // References are compared case-insensitively by banks; store one canonical form so a duplicate cannot hide behind case or spacing.
  const bankReference = (text('bankReference', b.bankReference, 80, true) as string).toUpperCase()
  const payerName = text('payerName', b.payerName, 140, true) as string
  const notes = text('notes', b.notes, 500, false)
  if (typeof b.valueDate !== 'string' || !DAY.test(b.valueDate)) throw new BadRequestException('valueDate must be YYYY-MM-DD')
  const valueDate = new Date(`${b.valueDate}T00:00:00.000Z`)
  if (Number.isNaN(valueDate.getTime()) || valueDate.toISOString().slice(0, 10) !== b.valueDate) throw new BadRequestException('valueDate is not a real date')
  // Latest allowed: today in the easternmost time zone (UTC+14); earliest: one year back.
  if (valueDate.getTime() > now.getTime() + 14 * 3_600_000) throw new BadRequestException('valueDate cannot be in the future')
  if (valueDate.getTime() < now.getTime() - MAX_AGE_DAYS * DAY_MS) throw new BadRequestException('valueDate is more than a year old')
  const requestId = text('requestId', b.requestId, 80, true) as string
  if (requestId.length < 8) throw new BadRequestException('requestId must be 8 to 80 characters')
  return {
    currency: b.currency, amountMinor, method, bankReference, valueDate, payerName, payerType, notes, requestId,
    complianceReviewRequired: complianceReviewRequired(method, payerType), secondApprovalRequired: secondApprovalRequired(b.currency, amountMinor),
  }
}

export interface DutyState {
  status: string; declaredById: string; verifiedById: string | null; complianceReviewRequired: boolean
  complianceClearedById: string | null; secondApprovalRequired: boolean
}

/** A refusal: `state` is a 409 (the receipt is not in the right state), `duty` a 403 (this person may not take this step). */
export interface Refusal { kind: 'state' | 'duty'; message: string }
const state = (message: string): Refusal => ({ kind: 'state', message })
const duty = (message: string): Refusal => ({ kind: 'duty', message })

/** Separation of duties for one caller. Returns null when allowed, otherwise the refusal (also shown to the caller). */
export const duties = {
  verify(r: DutyState, me: string): Refusal | null {
    if (r.status !== 'DECLARED') return state(`Only a declared receipt can be verified (this one is ${r.status.toLowerCase()})`)
    if (r.declaredById === me) return duty('The person who declared a receipt cannot verify it')
    return null
  },
  clearCompliance(r: DutyState, me: string): Refusal | null {
    if (!r.complianceReviewRequired) return state('This receipt does not need a compliance review')
    if (r.complianceClearedById) return state('Compliance review is already cleared')
    if (r.status !== 'DECLARED' && r.status !== 'VERIFIED') return state(`A ${r.status.toLowerCase()} receipt cannot be cleared`)
    if (r.declaredById === me) return duty('The person who declared a receipt cannot clear its compliance review')
    return null
  },
  post(r: DutyState, me: string): Refusal | null {
    if (r.status !== 'VERIFIED') return state(`Only a verified receipt can be posted (this one is ${r.status.toLowerCase()})`)
    if (r.complianceReviewRequired && !r.complianceClearedById) return state('The compliance review must be cleared before posting')
    if (r.declaredById === me) return duty('The person who declared a receipt cannot post it')
    if (r.secondApprovalRequired && r.verifiedById === me) return duty('Above the threshold a second person must post: the verifier cannot')
    return null
  },
  reject(r: DutyState): Refusal | null {
    if (r.status !== 'DECLARED' && r.status !== 'VERIFIED') return state(`A ${r.status.toLowerCase()} receipt cannot be rejected`)
    return null
  },
}
