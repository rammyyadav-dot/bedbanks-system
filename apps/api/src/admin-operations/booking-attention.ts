import type { BookingAttention } from '@bedbanks/contracts'

export const DEFAULT_STALE_MINUTES = 30
export const DEFAULT_PREBOOK_MAX_MINUTES = 60

export interface AttentionFacts {
  bookingStatus: string
  /** Status of the hold named in the booking snapshot, or null when there is no such hold row. */
  holdStatus: string | null
  holdUpdatedAt: Date | null
  prebookAt: Date | null
  /** Ledger evidence for this booking. */
  hasDebit: boolean
  refundPostedMinor: bigint
  /** The Cancellation record, if any. */
  cancellation: { refundMinor: bigint | null } | null
  now: Date
  staleMinutes?: number
  prebookMaxMinutes?: number
}

const minutesSince = (from: Date, now: Date) => (now.getTime() - from.getTime()) / 60_000

/**
 * Read-only consistency rules over evidence that already exists. They mirror the invariants the booking services
 * establish (confirm: hold CONFIRMED + DEBIT; cancel: hold RELEASED + REFUND = recorded refund; failure: hold released)
 * and never decide anything: a flag means "a person should look", and status is never inferred from evidence.
 */
export function bookingAttention(f: AttentionFacts): BookingAttention[] {
  const flags: BookingAttention[] = []
  const stale = f.staleMinutes ?? DEFAULT_STALE_MINUTES
  const prebookMax = f.prebookMaxMinutes ?? DEFAULT_PREBOOK_MAX_MINUTES
  if (f.bookingStatus === 'PENDING_SUPPLIER') {
    if (f.holdStatus === 'PROCESSING' && f.holdUpdatedAt && minutesSince(f.holdUpdatedAt, f.now) >= stale) flags.push('RECONCILIATION_REQUIRED')
    if (f.prebookAt && minutesSince(f.prebookAt, f.now) >= prebookMax) flags.push('PREBOOK_EXPIRED_UNRESOLVED')
  }
  if (f.bookingStatus === 'CONFIRMED') {
    if (!f.hasDebit) flags.push('FINANCIAL_MISMATCH')
    if (f.holdStatus !== 'CONFIRMED') flags.push('INVENTORY_MISMATCH')
  }
  if (f.bookingStatus === 'FAILED' && f.holdStatus !== null && ['HELD', 'PROCESSING', 'HOLD_PENDING'].includes(f.holdStatus)) flags.push('INVENTORY_NOT_RELEASED')
  if (f.bookingStatus === 'CANCELLED') {
    if (!f.cancellation) flags.push('CANCELLATION_RECORD_MISSING')
    if (f.holdStatus !== null && f.holdStatus !== 'RELEASED') flags.push('INVENTORY_NOT_RELEASED')
    const expectedRefund = f.cancellation?.refundMinor ?? 0n
    if (expectedRefund > 0n && f.refundPostedMinor !== expectedRefund) flags.push('REFUND_MISSING')
  }
  return flags
}
