/**
 * The backlog of the booking Finance consumer (ADR 0076): what it has posted, skipped, and what waits for a person. Read-only; nothing here posts or changes anything.
 * Amounts are integer minor units serialised as strings. The reason codes are the stable codes stored on `BookingFinancePosting.reason`, never free text.
 */
export const POSTING_SKIP_REASONS = [
  'PAY_AT_HOTEL', 'ZERO_SELL', 'ALREADY_CHARGED_ON_LEDGER', 'HOLD_ALREADY_POSTED', 'NO_HOLD_ON_LEDGER', 'HOLD_ALREADY_RELEASED',
  'PENALTY_UNDETERMINED', 'AWAITS_CANCELLATION', 'NOT_CHARGED_ON_LEDGER', 'NOTHING_TO_ADD', 'AMENDMENT_ALREADY_REFLECTED',
] as const
export type PostingSkipReason = (typeof POSTING_SKIP_REASONS)[number]

export const POSTING_REVIEW_REASONS = [
  'PAYMENT_MODE_UNKNOWN', 'NO_AGENCY', 'NO_WALLET', 'NO_SUPPLIER', 'NET_UNKNOWN', 'REFUND_EXCEEDS_CHARGE', 'REFUND_WOULD_DECREASE', 'EVENT_INCONSISTENT',
  'HOLD_AMOUNT_DIFFERS', 'AMENDMENT_NEEDS_LEDGER_ADJUSTMENT',
] as const
export type PostingReviewReason = (typeof POSTING_REVIEW_REASONS)[number]

/** 503 code when the consumer's database role is not configured or lacks a grant. Not an empty backlog. */
export const BOOKING_FINANCE_POSTING_UNAVAILABLE = 'BOOKING_FINANCE_POSTING_UNAVAILABLE'
/** At most this many rows of each list are returned; the counts are always complete. */
export const POSTING_BACKLOG_LIST_LIMIT = 100

export interface PostingBacklogItem {
  eventId: string
  bookingId: string
  eventType: string
  currency: string
  sellMinor: string
  /** When the money fact was recorded. */
  recordedAt: string
}

export interface PostingReviewItem extends PostingBacklogItem {
  reason: string
  attempts: number
  /** The last attempt; the next one is five minutes after it. */
  lastAttemptAt: string
}

export interface PostingBacklogView {
  generatedAt: string
  counts: { posted: number; skipped: number; reviewRequired: number; waiting: number }
  skippedByReason: Array<{ reason: string; count: number }>
  /** Events that need a person, oldest first. */
  review: PostingReviewItem[]
  /** Events not yet attempted (queued, or waiting behind an earlier event of their booking). */
  waiting: PostingBacklogItem[]
  listLimit: number
}
