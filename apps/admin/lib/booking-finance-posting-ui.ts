import { POSTING_REVIEW_REASONS, POSTING_SKIP_REASONS, type PostingReviewReason, type PostingSkipReason } from '@bedbanks/contracts'

/** What a person should do about each review reason (ADR 0076 runbook). Every contract value has text, so the page can never show a raw code as its only explanation. */
export const REVIEW_TEXT: Record<PostingReviewReason, { title: string; action: string }> = {
  PAYMENT_MODE_UNKNOWN: { title: 'Payment mode unknown', action: 'Set the booking\'s payment mode. The event is retried automatically.' },
  NO_AGENCY: { title: 'No agency on the booking', action: 'The booking has no agency, so no account can be charged. Finance decides how to attribute it.' },
  NO_WALLET: { title: 'Agency has no open account', action: 'Open the agency\'s account in this currency (it opens with its first funding receipt). The event is retried automatically.' },
  NO_SUPPLIER: { title: 'No supplier on the booking', action: 'The booking has no supplier organization to accrue a payable to. Fix the booking record.' },
  NET_UNKNOWN: { title: 'Supplier net cost unknown', action: 'Record the net cost on the booking. Nothing is charged until it is known.' },
  HOLD_AMOUNT_DIFFERS: { title: 'On-request hold differs from the confirmed price', action: 'A hold was taken for another amount than the confirmation. Finance decides how to settle it; nothing was posted.' },
  AMENDMENT_NEEDS_LEDGER_ADJUSTMENT: { title: 'Amendment after the charge', action: 'The booking was amended after it was charged at another total. Adjustments are not booked automatically; Finance decides.' },
  REFUND_WOULD_DECREASE: { title: 'Decision would refund less than already refunded', action: 'A refund is never taken back automatically. A person decides.' },
  REFUND_EXCEEDS_CHARGE: { title: 'Refund above the amount charged', action: 'Stop and investigate. Do not force a refund.' },
  EVENT_INCONSISTENT: { title: 'Recorded amounts do not add up', action: 'Stop and investigate. The recorded money fact is inconsistent with the booking.' },
}

export const SKIP_TEXT: Record<PostingSkipReason, string> = {
  PAY_AT_HOTEL: 'Pay at hotel: no money moves through us',
  ZERO_SELL: 'Zero price: nothing to post',
  ALREADY_CHARGED_ON_LEDGER: 'Already charged on the ledger by the agent flow',
  HOLD_ALREADY_POSTED: 'Hold already on the ledger',
  NO_HOLD_ON_LEDGER: 'No hold on the ledger to release',
  HOLD_ALREADY_RELEASED: 'Hold already released',
  PENALTY_UNDETERMINED: 'Cancelled with the penalty not yet decided; the decision will post the refund',
  AWAITS_CANCELLATION: 'Penalty decided before the cancellation completed; posts with the cancellation',
  NOT_CHARGED_ON_LEDGER: 'Booking was never charged on the ledger: nothing to refund',
  NOTHING_TO_ADD: 'Already posted in full',
  AMENDMENT_ALREADY_REFLECTED: 'Amendment already reflected in the charge',
}

export const EVENT_TEXT: Record<string, string> = {
  CONFIRMED: 'Confirmed', ON_REQUEST_HOLD: 'On-request hold', HOLD_RELEASED: 'Hold released', CANCELLED: 'Cancelled',
  PENALTY_DECIDED: 'Penalty decided', PENALTY_WAIVED: 'Penalty waived', AMENDED: 'Amended',
}

export const reviewText = (reason: string) => REVIEW_TEXT[reason as PostingReviewReason] ?? { title: reason, action: 'Unrecognised reason; ask an engineer.' }
export const skipText = (reason: string) => SKIP_TEXT[reason as PostingSkipReason] ?? reason
export const eventText = (type: string) => EVENT_TEXT[type] ?? type
/** The retry window the consumer uses (ADR 0076). */
export const nextRetryAt = (lastAttemptIso: string) => new Date(new Date(lastAttemptIso).getTime() + 5 * 60_000).toISOString()

export const ALL_REVIEW_REASONS = POSTING_REVIEW_REASONS
export const ALL_SKIP_REASONS = POSTING_SKIP_REASONS

export const SETTLEMENT_STATUS_TEXT: Record<'PROPOSED' | 'APPROVED' | 'REJECTED', string> = { PROPOSED: 'Waiting for approval', APPROVED: 'Approved and recorded', REJECTED: 'Rejected' }
export const settlementTone = (status: string): 'ok' | 'warn' | 'bad' | 'neutral' => (status === 'APPROVED' ? 'ok' : status === 'PROPOSED' ? 'warn' : status === 'REJECTED' ? 'bad' : 'neutral')

export const TERMS_BASIS_TEXT: Record<'CHECK_OUT' | 'CHECK_IN' | 'CONFIRMATION', string> = { CHECK_OUT: 'after check-out', CHECK_IN: 'after check-in', CONFIRMATION: 'after confirmation' }
export const termsText = (basis: string | null, days: number | null) => (basis === null || days === null ? 'No terms set' : `${days} day${days === 1 ? '' : 's'} ${TERMS_BASIS_TEXT[basis as keyof typeof TERMS_BASIS_TEXT] ?? basis}`)
