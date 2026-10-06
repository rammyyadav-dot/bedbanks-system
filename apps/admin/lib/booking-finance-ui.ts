// Pure helpers for the booking "Finance & documents" panel and the cancellation-terms entry (ADR 0039, Phase 5). No React, no network, no floating point.
import type { BookingDocumentType, BookingFinanceEventType, DocumentBlock, EffectivePenalty, FrozenCancellationRule, StoredPenaltyQuote } from '@bedbanks/contracts'
import { parseMajorToMinor } from './minor-units'

export const FINANCE_EVENT_LABEL: Record<BookingFinanceEventType, string> = {
  CONFIRMED: 'Confirmed: amount due recorded', ON_REQUEST_HOLD: 'On request: amount held', HOLD_RELEASED: 'Hold released', CANCELLED: 'Cancelled: penalty and refund recorded', PENALTY_DECIDED: 'Penalty decided', PENALTY_WAIVED: 'Penalty waived (reduced)',
}
export const DOCUMENT_LABEL: Record<BookingDocumentType, string> = { VOUCHER: 'Voucher', INVOICE: 'Invoice', CREDIT_NOTE: 'Credit note', CANCELLATION_NOTE: 'Cancellation note' }
export const DOCUMENT_ROUTE: Record<BookingDocumentType, string> = { VOUCHER: 'voucher', INVOICE: 'invoice', CREDIT_NOTE: 'credit-note', CANCELLATION_NOTE: 'cancellation-note' }
export const DOCUMENT_BLOCK_COPY: Record<Exclude<DocumentBlock, null | 'ALREADY_ISSUED'>, string> = {
  NOT_CONFIRMED: 'The booking was never confirmed.', HOTEL_CONFIRMATION_REQUIRED: 'Record the hotel confirmation number first.', BOOKING_CANCELLED: 'Not issued for a cancelled booking.', NOT_CANCELLED: 'Available once the booking is cancelled.',
  PENALTY_DECISION_REQUIRED: 'Decide the cancellation penalty first.', NOTHING_TO_CREDIT: 'The whole amount is retained, so there is nothing to credit.', INVOICE_REQUIRED: 'Issue the invoice first.',
}
export const NEEDS_DECISION_COPY: Record<string, string> = {
  policy_unavailable: 'No cancellation terms were stored with this booking.', manual_review_required: 'The terms could not be applied automatically.', refundability_unknown: 'It is not known whether this booking is refundable.', no_quote: 'No penalty was worked out.', invalid_sell_amount: 'The booking amount is not valid.',
}

/** The order the three cancellation documents are issued in (the credit note refers to the invoice). */
export const CANCELLATION_DOCUMENT_ORDER: readonly BookingDocumentType[] = ['INVOICE', 'CREDIT_NOTE', 'CANCELLATION_NOTE']

export function penaltySummary(p: EffectivePenalty): string {
  if (p.state === 'NOT_REQUESTED') return 'No cancellation has been requested.'
  if (p.state === 'NEEDS_DECISION') return `The penalty is not decided. ${NEEDS_DECISION_COPY[p.reason] ?? ''}`.trim()
  return { QUOTED: 'Penalty fixed when cancellation was requested.', DECIDED: 'Penalty decided by an operator.', WAIVED: 'Penalty reduced by an approved waiver.' }[p.state]
}
export function quoteSummary(q: StoredPenaltyQuote | null): string {
  if (!q) return 'No cancellation terms apply yet.'
  if (q.status === 'needs_decision') return `${NEEDS_DECISION_COPY[q.reason] ?? q.detail} A person must decide the penalty.`
  if (q.basis === 'NON_REFUNDABLE') return 'Non-refundable: the whole amount would be retained.'
  return q.ruleDaysBeforeCheckin === null ? 'Outside every penalty window: the whole amount would be refunded.' : `Inside the “within ${q.ruleDaysBeforeCheckin} day(s) of check-in” window.`
}

export interface RuleForm { days: string; kind: 'percent' | 'fixed'; value: string }
export const emptyRuleForm = (): RuleForm => ({ days: '', kind: 'percent', value: '' })

/** Rules as typed to the API's frozen shape. Percent and days are whole numbers; a fixed amount becomes integer minor units. Returns field-keyed errors otherwise. */
export function buildRules(rows: RuleForm[], currency: string): { rules: FrozenCancellationRule[] } | { errors: Record<string, string> } {
  const errors: Record<string, string> = {}
  const rules: FrozenCancellationRule[] = []
  rows.forEach((r, i) => {
    const days = /^\d{1,4}$/.test(r.days.trim()) ? Number(r.days.trim()) : null
    if (days === null || days > 3650) errors[`rules.${i}.days`] = 'Whole days before check-in'
    if (r.kind === 'percent') {
      const pct = /^\d{1,3}$/.test(r.value.trim()) ? Number(r.value.trim()) : null
      if (pct === null || pct > 100) errors[`rules.${i}.value`] = 'A whole percent from 0 to 100'
      else if (days !== null) rules.push({ daysBeforeCheckin: days, penaltyPercent: pct })
    } else {
      const minor = parseMajorToMinor(r.value, currency)
      if (minor === null) errors[`rules.${i}.value`] = 'A plain amount with at most the currency’s decimals'
      else if (days !== null) rules.push({ daysBeforeCheckin: days, penaltyMinor: minor })
    }
  })
  if (rows.length > 12) errors.rules = 'At most 12 rules'
  return Object.keys(errors).length ? { errors } : { rules }
}
