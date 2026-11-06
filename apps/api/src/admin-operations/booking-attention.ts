import type { BookingAttention } from '@bedbanks/contracts'
import { supplierMutationAcceptedReference, type SupplierMutationState } from '../agent/supplier-mutation-journal.service'

export const DEFAULT_STALE_MINUTES = 30
export const DEFAULT_PREBOOK_MAX_MINUTES = 60

/** One supplier operation, when the journal was read. `absent` means no row, not "not looked at". */
export type AcknowledgementLeg = 'absent' | 'accepted' | 'not_accepted'
export interface AcknowledgementFacts {
  prebook: AcknowledgementLeg
  book: AcknowledgementLeg
  cancel: AcknowledgementLeg
}

/** The latest CANCELLED money fact. Null amounts are a broken fact: penalty and refund are both required and must add to the sell. */
export interface FinanceCancellationFact {
  refundMinor: bigint | null
  penaltyMinor: bigint | null
  sellMinor: bigint
}

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
  /** Booking sell, when the caller has it. Omitted means it was not compared. */
  sellMinor?: bigint | null
  /**
   * Latest supplier journal row per operation. Omitted means the journal was not read.
   * An all-`absent` value means it was read and this booking has no rows.
   */
  acknowledgement?: AcknowledgementFacts
  /** Whether a voucher document is on file. Omitted means documents were not read. `false` is not a flag: vouchers are issued on first view. */
  voucherIssued?: boolean
  /**
   * Latest CANCELLED finance-outbox row. Omitted means the outbox was not read.
   * `null` means it was read and this booking has no such row (the Agent path does not write one).
   * An unposted fact is not compared with the wallet: Finance posts it later.
   */
  financeCancellation?: FinanceCancellationFact | null
}

const MINUTES = 60_000
const minutesSince = (from: Date, now: Date) => (now.getTime() - from.getTime()) / MINUTES
const MUTATION_STATES = new Set<SupplierMutationState>(['PREPARED', 'SENDING', 'ACKNOWLEDGED', 'REJECTED', 'UNKNOWN', 'RESOLVED'])
/** Statuses that exist only after the stay was confirmed. A voucher may remain on file after cancellation. */
const CONFIRMED_STAY = new Set(['CONFIRMED', 'AMEND_REQUESTED', 'CANCEL_REQUESTED', 'CHECKED_OUT', 'NO_SHOW', 'CANCELLED'])
/** Stock is sold and the wallet charge is still the live one. */
const SOLD_STAY = new Set(['CONFIRMED', 'AMEND_REQUESTED', 'CHECKED_OUT'])

const add = (flags: BookingAttention[], flag: BookingAttention) => {
  if (!flags.includes(flag)) flags.push(flag)
}

export function acknowledgementOf(rows: ReadonlyArray<{ operation: string; status: string; supplierStatus: string | null; supplierReference: string | null }>): AcknowledgementFacts {
  const latest: Record<'PREBOOK' | 'BOOK' | 'CANCEL', AcknowledgementLeg> = { PREBOOK: 'absent', BOOK: 'absent', CANCEL: 'absent' }
  for (const row of rows) {
    if (row.operation !== 'PREBOOK' && row.operation !== 'BOOK' && row.operation !== 'CANCEL') continue
    if (latest[row.operation] !== 'absent') continue
    const status = MUTATION_STATES.has(row.status as SupplierMutationState) ? row.status as SupplierMutationState : null
    latest[row.operation] = status && supplierMutationAcceptedReference({ status, supplierStatus: row.supplierStatus, supplierReference: row.supplierReference }) ? 'accepted' : 'not_accepted'
  }
  return { prebook: latest.PREBOOK, book: latest.BOOK, cancel: latest.CANCEL }
}

/**
 * Read-only consistency rules over evidence that already exists. They mirror the invariants the booking services
 * establish (confirm: accepted prebook, hold CONFIRMED, DEBIT, voucher only once that is true; cancel: hold RELEASED,
 * posted refund equals the cancellation record, and neither exceeds the sell). A cancellation money fact must add up
 * and agree with that record. It is not compared with the wallet until Finance posts it. The function never decides anything.
 * A flag means "a person should look". Status is never inferred from evidence. A fact that was not read is omitted
 * and is not treated as a match.
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
  noteAcknowledgement(flags, f)
  noteVoucher(flags, f)
  noteMoneyFacts(flags, f)
  return flags
}

function noteAcknowledgement(flags: BookingAttention[], f: AttentionFacts) {
  const journal = f.acknowledgement
  if (!journal) return
  const confirmed = CONFIRMED_STAY.has(f.bookingStatus)
  // An accepted book that never became a confirmed stay leaves the supplier holding a reservation the stock and wallet did not settle.
  if (journal.book === 'accepted' && !confirmed) add(flags, 'ACKNOWLEDGEMENT_MISMATCH')
  if (journal.book === 'not_accepted' && confirmed) add(flags, 'ACKNOWLEDGEMENT_MISMATCH')
  if (journal.prebook === 'not_accepted' && confirmed && journal.book !== 'accepted') add(flags, 'ACKNOWLEDGEMENT_MISMATCH')
  if (journal.cancel === 'accepted' && f.bookingStatus !== 'CANCELLED' && f.bookingStatus !== 'CANCEL_REQUESTED') add(flags, 'ACKNOWLEDGEMENT_MISMATCH')
  if (journal.cancel === 'not_accepted' && f.bookingStatus === 'CANCELLED') add(flags, 'ACKNOWLEDGEMENT_MISMATCH')
}

function noteVoucher(flags: BookingAttention[], f: AttentionFacts) {
  if (f.voucherIssued !== true) return
  if (!CONFIRMED_STAY.has(f.bookingStatus)) {
    add(flags, 'VOUCHER_MISMATCH')
    return
  }
  if (SOLD_STAY.has(f.bookingStatus) && (!f.hasDebit || (f.holdStatus !== null && f.holdStatus !== 'CONFIRMED'))) add(flags, 'VOUCHER_MISMATCH')
  if (f.bookingStatus === 'CANCELLED' && f.holdStatus !== null && f.holdStatus !== 'RELEASED') add(flags, 'VOUCHER_MISMATCH')
}

function noteMoneyFacts(flags: BookingAttention[], f: AttentionFacts) {
  if (f.sellMinor != null) {
    if (f.refundPostedMinor > f.sellMinor) add(flags, 'MONEY_FACT_MISMATCH')
    if ((f.cancellation?.refundMinor ?? 0n) > f.sellMinor) add(flags, 'MONEY_FACT_MISMATCH')
  }
  if (f.bookingStatus === 'CANCELLED' && f.refundPostedMinor > 0n && !f.hasDebit) add(flags, 'MONEY_FACT_MISMATCH')
  const fact = f.financeCancellation
  if (!fact) return
  const refund = fact.refundMinor
  const penalty = fact.penaltyMinor
  if (refund === null || penalty === null || penalty + refund !== fact.sellMinor) add(flags, 'MONEY_FACT_MISMATCH')
  if (f.bookingStatus !== 'CANCELLED') add(flags, 'MONEY_FACT_MISMATCH')
  if (f.sellMinor != null && fact.sellMinor !== f.sellMinor) add(flags, 'MONEY_FACT_MISMATCH')
  if (f.cancellation && f.cancellation.refundMinor !== refund) add(flags, 'MONEY_FACT_MISMATCH')
}
