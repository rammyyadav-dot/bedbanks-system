/**
 * Money and documents of the Admin booking module (ADR 0039, Phase 5). Pure, shared by the API (which decides) and the Admin (which only shows).
 *
 * The booking module does not post ledger entries or edit a balance: it records immutable FINANCE EVENTS (integer minor units + ISO-4217 currency) that the Finance
 * module books, and it issues documents. All arithmetic here is BigInt; there is no floating point anywhere. A penalty is fixed when cancellation is
 * REQUESTED, from the rules frozen with the booking; a lower penalty is a waiver that a second person must approve; a higher one is impossible.
 */
import type { BookingStatus } from './operations'

export const BOOKING_FINANCE_EVENT_TYPES = ['CONFIRMED', 'ON_REQUEST_HOLD', 'HOLD_RELEASED', 'CANCELLED', 'PENALTY_DECIDED', 'PENALTY_WAIVED'] as const
export type BookingFinanceEventType = (typeof BOOKING_FINANCE_EVENT_TYPES)[number]

export const BOOKING_DOCUMENT_TYPES = ['VOUCHER', 'INVOICE', 'CREDIT_NOTE', 'CANCELLATION_NOTE'] as const
export type BookingDocumentType = (typeof BOOKING_DOCUMENT_TYPES)[number]
export const BOOKING_DOCUMENT_ROUTE_TYPES: Readonly<Record<string, BookingDocumentType>> = { voucher: 'VOUCHER', invoice: 'INVOICE', 'credit-note': 'CREDIT_NOTE', 'cancellation-note': 'CANCELLATION_NOTE' }
export const BOOKING_DOCUMENT_PREFIX: Readonly<Record<BookingDocumentType, string>> = { VOUCHER: 'VCH', INVOICE: 'INV', CREDIT_NOTE: 'CN', CANCELLATION_NOTE: 'CXL' }
export function bookingDocumentTypeFromRoute(value: string): BookingDocumentType | null {
  return Object.prototype.hasOwnProperty.call(BOOKING_DOCUMENT_ROUTE_TYPES, value) ? BOOKING_DOCUMENT_ROUTE_TYPES[value] : null
}

export const MAX_MINOR = 9_007_199_254_740_991n * 1000n // far above any real booking; refuses absurd input rather than overflowing BIGINT
export const MAX_CANCELLATION_RULES = 12
export const PENALTY_REASON_MAX = 500

/** One rule, in the shape the CancellationPolicyService evaluates, with the fixed amount as a decimal string of minor units. */
export interface FrozenCancellationRule { daysBeforeCheckin: number; penaltyPercent?: number; penaltyMinor?: string }
export interface FrozenCancellationPolicy { rules: FrozenCancellationRule[]; frozenAt: string; source: 'MANUAL_ENTRY' }

const MINOR = /^\d{1,24}$/
export function parseMinor(value: unknown): bigint | null {
  if (typeof value !== 'string' || !MINOR.test(value)) return null
  const n = BigInt(value)
  return n <= MAX_MINOR ? n : null
}

/** Strict validation of rules as stored or entered. Returns null for anything ambiguous: an unreadable policy is "unavailable", never "free". */
export function parseFrozenRules(value: unknown): FrozenCancellationRule[] | null {
  const source = Array.isArray(value) ? value : value && typeof value === 'object' && Array.isArray((value as { rules?: unknown }).rules) ? (value as { rules: unknown[] }).rules : null
  if (!source || source.length === 0 || source.length > MAX_CANCELLATION_RULES) return null
  const rules: FrozenCancellationRule[] = []
  for (const raw of source) {
    if (!raw || typeof raw !== 'object') return null
    const r = raw as Record<string, unknown>
    if (typeof r.daysBeforeCheckin !== 'number' || !Number.isInteger(r.daysBeforeCheckin) || r.daysBeforeCheckin < 0 || r.daysBeforeCheckin > 3650) return null
    const hasPercent = r.penaltyPercent !== undefined && r.penaltyPercent !== null
    const hasFixed = r.penaltyMinor !== undefined && r.penaltyMinor !== null
    if (hasPercent === hasFixed) return null
    if (hasPercent) {
      if (typeof r.penaltyPercent !== 'number' || !Number.isInteger(r.penaltyPercent) || r.penaltyPercent < 0 || r.penaltyPercent > 100) return null
      rules.push({ daysBeforeCheckin: r.daysBeforeCheckin, penaltyPercent: r.penaltyPercent })
    } else {
      if (parseMinor(r.penaltyMinor) === null) return null
      rules.push({ daysBeforeCheckin: r.daysBeforeCheckin, penaltyMinor: r.penaltyMinor as string })
    }
  }
  return rules
}

/** The penalty worked out when cancellation was requested, stored on that request's BookingEvent. All amounts are decimal strings of minor units. */
export type StoredPenaltyQuote =
  | { status: 'quotable'; currency: string; sellMinor: string; penaltyMinor: string; refundMinor: string; ruleDaysBeforeCheckin: number | null; basis: 'RULE' | 'NON_REFUNDABLE'; evaluatedAt: string }
  | { status: 'needs_decision'; reason: 'policy_unavailable' | 'manual_review_required' | 'refundability_unknown'; detail: string; evaluatedAt: string }

/** A split of the sell amount. Invalid input (negative, more than the sell amount) is refused, never clamped. */
export function splitSell(sellMinor: bigint, penaltyMinor: bigint): { penaltyMinor: bigint; refundMinor: bigint } | null {
  if (sellMinor < 0n || penaltyMinor < 0n || penaltyMinor > sellMinor) return null
  return { penaltyMinor, refundMinor: sellMinor - penaltyMinor }
}

export interface PenaltyFact { type: BookingFinanceEventType; penaltyMinor: string | null; createdAt: string }
export type EffectivePenalty =
  | { state: 'NOT_REQUESTED' }
  | { state: 'NEEDS_DECISION'; reason: string }
  | { state: 'QUOTED' | 'DECIDED' | 'WAIVED'; penaltyMinor: string; refundMinor: string }

/**
 * The one penalty that counts: the latest waiver or decision, else the quote taken when cancellation was requested. `facts` are in creation order.
 * With nothing determined it is NEEDS_DECISION: money is never guessed, and no credit note can be issued until a person decides.
 */
export function effectivePenalty(input: { sellMinor: string; requested: boolean; quote: StoredPenaltyQuote | null; facts: readonly PenaltyFact[] }): EffectivePenalty {
  if (!input.requested) return { state: 'NOT_REQUESTED' }
  const sell = parseMinor(input.sellMinor)
  if (sell === null) return { state: 'NEEDS_DECISION', reason: 'invalid_sell_amount' }
  for (let i = input.facts.length - 1; i >= 0; i--) {
    const f = input.facts[i]
    if ((f.type === 'PENALTY_WAIVED' || f.type === 'PENALTY_DECIDED') && f.penaltyMinor !== null) {
      const split = splitSell(sell, BigInt(f.penaltyMinor))
      if (split) return { state: f.type === 'PENALTY_WAIVED' ? 'WAIVED' : 'DECIDED', penaltyMinor: split.penaltyMinor.toString(), refundMinor: split.refundMinor.toString() }
    }
  }
  const q = input.quote
  if (q && q.status === 'quotable') {
    const split = splitSell(sell, BigInt(q.penaltyMinor))
    if (split) return { state: 'QUOTED', penaltyMinor: split.penaltyMinor.toString(), refundMinor: split.refundMinor.toString() }
  }
  return { state: 'NEEDS_DECISION', reason: q && q.status === 'needs_decision' ? q.reason : 'no_quote' }
}

export type PenaltyChange = { kind: 'DECIDE' } | { kind: 'WAIVE' } | { kind: 'REFUSE'; code: 'PENALTY_UNCHANGED' | 'PENALTY_CANNOT_INCREASE' | 'PENALTY_INVALID' | 'PENALTY_NOT_OPEN' }

/** What a requested penalty means given the current one. Equal is refused (nothing to record); higher is refused (the penalty is fixed at request time). */
export function classifyPenaltyChange(current: EffectivePenalty, sellMinor: bigint, requested: bigint): PenaltyChange {
  if (current.state === 'NOT_REQUESTED') return { kind: 'REFUSE', code: 'PENALTY_NOT_OPEN' }
  if (!splitSell(sellMinor, requested)) return { kind: 'REFUSE', code: 'PENALTY_INVALID' }
  if (current.state === 'NEEDS_DECISION') return { kind: 'DECIDE' }
  const now = BigInt(current.penaltyMinor)
  if (requested === now) return { kind: 'REFUSE', code: 'PENALTY_UNCHANGED' }
  return requested < now ? { kind: 'WAIVE' } : { kind: 'REFUSE', code: 'PENALTY_CANNOT_INCREASE' }
}

export interface DocumentEligibilityFacts {
  status: BookingStatus
  hasConfirmedEvent: boolean
  hotelConfirmationNo: string | null
  penalty: EffectivePenalty
  sellMinor: string
  issued: readonly BookingDocumentType[]
}
export type DocumentBlock = null | 'ALREADY_ISSUED' | 'NOT_CONFIRMED' | 'HOTEL_CONFIRMATION_REQUIRED' | 'BOOKING_CANCELLED' | 'NOT_CANCELLED' | 'PENALTY_DECISION_REQUIRED' | 'NOTHING_TO_CREDIT' | 'INVOICE_REQUIRED'
export const DOCUMENT_BLOCK_TEXT: Readonly<Record<Exclude<DocumentBlock, null>, string>> = {
  ALREADY_ISSUED: 'This document was already issued and cannot be changed.',
  NOT_CONFIRMED: 'The booking was never confirmed, so there is nothing to document.',
  HOTEL_CONFIRMATION_REQUIRED: 'A voucher needs the hotel confirmation number. Record it first.',
  BOOKING_CANCELLED: 'A voucher is not issued for a cancelled booking.',
  NOT_CANCELLED: 'This document is issued only once the booking is cancelled.',
  PENALTY_DECISION_REQUIRED: 'The cancellation penalty has not been decided. Decide it first.',
  NOTHING_TO_CREDIT: 'The whole amount is retained as a penalty, so there is no credit to issue.',
  INVOICE_REQUIRED: 'Issue the invoice first.',
}

/** Pure eligibility: what blocks issuing `type` now. The first block wins. Issuing is idempotent, so ALREADY_ISSUED is reported, not an error. */
export function documentBlock(type: BookingDocumentType, f: DocumentEligibilityFacts): DocumentBlock {
  if (f.issued.includes(type)) return 'ALREADY_ISSUED'
  if (!f.hasConfirmedEvent) return 'NOT_CONFIRMED'
  if (type === 'VOUCHER') {
    if (f.status === 'CANCELLED' || f.status === 'CANCEL_REQUESTED') return 'BOOKING_CANCELLED'
    return f.hotelConfirmationNo ? null : 'HOTEL_CONFIRMATION_REQUIRED'
  }
  if (type === 'INVOICE') return null
  if (f.status !== 'CANCELLED') return 'NOT_CANCELLED'
  if (f.penalty.state === 'NOT_REQUESTED' || f.penalty.state === 'NEEDS_DECISION') return 'PENALTY_DECISION_REQUIRED'
  if (type === 'CREDIT_NOTE') {
    if (f.penalty.refundMinor === '0') return 'NOTHING_TO_CREDIT'
    return f.issued.includes('INVOICE') ? null : 'INVOICE_REQUIRED'
  }
  return null
}

export interface BookingFinanceEventView { id: string; type: BookingFinanceEventType; seq: number; currency: string; sellMinor: string; netMinor: string | null; penaltyMinor: string | null; refundMinor: string | null; paymentMode: string | null; actorUserId: string | null; createdAt: string; note: string | null }
export interface BookingIssuedDocumentView { id: string; type: BookingDocumentType; number: string; issuedAt: string; htmlPath: string }
export interface BookingFinanceView {
  bookingId: string
  reference: string
  status: BookingStatus
  closed: boolean
  currency: string
  /** Only for a caller who may see net rates (`booking.view.net`); otherwise null and never present in the response. */
  netMinor: string | null
  sellMinor: string
  paymentMode: string | null
  isRefundable: boolean | null
  terms: { rules: FrozenCancellationRule[] | null; frozenAt: string | null; source: string | null }
  penalty: EffectivePenalty & { quote: StoredPenaltyQuote | null; waivedFrom: string | null }
  /** While the booking is Confirmed: what cancelling right now would cost, so the operator sees it before asking. Not stored; the real quote is taken when cancellation is requested. */
  cancellationPreview: StoredPenaltyQuote | null
  events: BookingFinanceEventView[]
  documents: BookingIssuedDocumentView[]
  eligible: Record<BookingDocumentType, DocumentBlock>
  can: { issueDocuments: boolean; decidePenalty: boolean; waivePenalty: boolean }
  /** The Finance module books these events; until it does, this module shows them as "awaiting Finance booking". */
  ledger: 'NOT_POSTED_BY_THIS_MODULE'
}

export interface BookingPenaltyRequest { penaltyMinor: string; reason: string }
export interface BookingPenaltyResult { bookingId: string; kind: 'DECIDE' | 'WAIVE'; penaltyMinor: string; refundMinor: string; replayed: boolean }
export interface BookingDocumentIssueResult { document: BookingIssuedDocumentView; replayed: boolean }
export const BOOKING_FINANCE_FAILURE = { forbidden: 'BOOKING_FINANCE_FORBIDDEN', selfWaive: 'PENALTY_SELF_APPROVAL', documentsIssued: 'DOCUMENTS_ISSUED' } as const
