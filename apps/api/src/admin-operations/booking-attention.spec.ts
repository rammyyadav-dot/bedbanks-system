import { acknowledgementOf, bookingAttention, type AttentionFacts } from './booking-attention'

const now = new Date('2026-10-02T12:00:00Z')
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000)
const base: AttentionFacts = { bookingStatus: 'CONFIRMED', holdStatus: 'CONFIRMED', holdUpdatedAt: minutesAgo(5), prebookAt: null, hasDebit: true, refundPostedMinor: 0n, cancellation: null, now }

describe('bookingAttention (read-only consistency flags)', () => {
  it('raises nothing for a healthy confirmed booking, with or without a document', () => {
    expect(bookingAttention(base)).toEqual([])
  })

  it('flags a confirmed booking with no debit or with an unconfirmed hold', () => {
    expect(bookingAttention({ ...base, hasDebit: false })).toEqual(['FINANCIAL_MISMATCH'])
    expect(bookingAttention({ ...base, holdStatus: 'HELD' })).toEqual(['INVENTORY_MISMATCH'])
    expect(bookingAttention({ ...base, holdStatus: null })).toEqual(['INVENTORY_MISMATCH'])
  })

  it('flags a pending booking only once its processing hold is stale, not while in flight', () => {
    const pending = { ...base, bookingStatus: 'PENDING_SUPPLIER', holdStatus: 'PROCESSING', hasDebit: false }
    expect(bookingAttention({ ...pending, holdUpdatedAt: minutesAgo(10) })).toEqual([])
    expect(bookingAttention({ ...pending, holdUpdatedAt: minutesAgo(30) })).toEqual(['RECONCILIATION_REQUIRED'])
    expect(bookingAttention({ ...pending, holdUpdatedAt: minutesAgo(31), staleMinutes: 45 })).toEqual([])
  })

  it('flags an expired prebook that was never confirmed, but not one inside its window', () => {
    const pending = { ...base, bookingStatus: 'PENDING_SUPPLIER', holdStatus: 'PROCESSING', hasDebit: false, holdUpdatedAt: minutesAgo(1) }
    expect(bookingAttention({ ...pending, prebookAt: minutesAgo(59) })).toEqual([])
    expect(bookingAttention({ ...pending, prebookAt: minutesAgo(61) })).toEqual(['PREBOOK_EXPIRED_UNRESOLVED'])
  })

  it('flags a failed booking whose inventory is still held', () => {
    for (const holdStatus of ['HELD', 'PROCESSING', 'HOLD_PENDING']) expect(bookingAttention({ ...base, bookingStatus: 'FAILED', holdStatus, hasDebit: false })).toEqual(['INVENTORY_NOT_RELEASED'])
    expect(bookingAttention({ ...base, bookingStatus: 'FAILED', holdStatus: 'RELEASED', hasDebit: false })).toEqual([])
    expect(bookingAttention({ ...base, bookingStatus: 'FAILED', holdStatus: null, hasDebit: false })).toEqual([])
  })

  it('checks cancelled bookings for a record, a released hold and a refund that matches the record', () => {
    const cancelled = { ...base, bookingStatus: 'CANCELLED', holdStatus: 'RELEASED', cancellation: { refundMinor: 25_000n }, refundPostedMinor: 25_000n }
    expect(bookingAttention(cancelled)).toEqual([])
    expect(bookingAttention({ ...cancelled, refundPostedMinor: 0n })).toEqual(['REFUND_MISSING'])
    expect(bookingAttention({ ...cancelled, refundPostedMinor: 24_999n })).toEqual(['REFUND_MISSING'])
    expect(bookingAttention({ ...cancelled, cancellation: null })).toEqual(['CANCELLATION_RECORD_MISSING'])
    expect(bookingAttention({ ...cancelled, holdStatus: 'CONFIRMED' })).toEqual(['INVENTORY_NOT_RELEASED'])
    expect(bookingAttention({ ...cancelled, cancellation: { refundMinor: 0n }, refundPostedMinor: 0n })).toEqual([])
  })

  const accepted = { status: 'ACKNOWLEDGED', supplierStatus: 'accepted', supplierReference: 'SUP-1' }
  const rejected = { status: 'REJECTED', supplierStatus: 'rejected', supplierReference: null }
  const none = { prebook: 'absent' as const, book: 'absent' as const, cancel: 'absent' as const }

  it('keeps the latest acknowledgement per operation and ignores an older row', () => {
    expect(acknowledgementOf([
      { operation: 'PREBOOK', ...accepted },
      { operation: 'PREBOOK', ...rejected },
      { operation: 'BOOK', ...rejected },
      { operation: 'CANCEL', status: 'RESOLVED', supplierStatus: 'confirmed', supplierReference: 'CXL-1' },
    ])).toEqual({ prebook: 'accepted', book: 'not_accepted', cancel: 'accepted' })
    expect(acknowledgementOf([])).toEqual(none)
  })

  it('flags an acknowledgement that disagrees with the booking, and leaves an accepted prebook that later failed alone', () => {
    const sold = { ...base, acknowledgement: { ...none, prebook: 'accepted' as const } }
    expect(bookingAttention(sold)).toEqual([])
    expect(bookingAttention({ ...sold, acknowledgement: { ...none, prebook: 'not_accepted' } })).toEqual(['ACKNOWLEDGEMENT_MISMATCH'])
    expect(bookingAttention({ ...sold, acknowledgement: { ...none, book: 'not_accepted', prebook: 'accepted' } })).toEqual(['ACKNOWLEDGEMENT_MISMATCH'])
    expect(bookingAttention({ ...base, bookingStatus: 'PENDING_SUPPLIER', holdStatus: 'PROCESSING', hasDebit: false, acknowledgement: { ...none, book: 'accepted' } })).toEqual(['ACKNOWLEDGEMENT_MISMATCH'])
    expect(bookingAttention({ ...base, bookingStatus: 'FAILED', holdStatus: 'RELEASED', hasDebit: false, acknowledgement: { ...none, prebook: 'accepted' } })).toEqual([])
    expect(bookingAttention({ ...base, bookingStatus: 'CANCELLED', holdStatus: 'RELEASED', hasDebit: true, cancellation: { refundMinor: 0n }, acknowledgement: { ...none, cancel: 'not_accepted' } })).toEqual(['ACKNOWLEDGEMENT_MISMATCH'])
    expect(bookingAttention({ ...base, bookingStatus: 'CONFIRMED', acknowledgement: { ...none, cancel: 'accepted', prebook: 'accepted' } })).toEqual(['ACKNOWLEDGEMENT_MISMATCH'])
  })

  it('flags a voucher that does not match a sold or released stay, and ignores a voucher that was never issued', () => {
    expect(bookingAttention({ ...base, voucherIssued: false })).toEqual([])
    expect(bookingAttention({ ...base, voucherIssued: true })).toEqual([])
    expect(bookingAttention({ ...base, voucherIssued: true, hasDebit: false })).toEqual(['FINANCIAL_MISMATCH', 'VOUCHER_MISMATCH'])
    expect(bookingAttention({ ...base, voucherIssued: true, holdStatus: 'PROCESSING' })).toEqual(['INVENTORY_MISMATCH', 'VOUCHER_MISMATCH'])
    expect(bookingAttention({ ...base, bookingStatus: 'FAILED', holdStatus: 'RELEASED', hasDebit: false, voucherIssued: true })).toEqual(['VOUCHER_MISMATCH'])
    const cancelled = { ...base, bookingStatus: 'CANCELLED', holdStatus: 'RELEASED', cancellation: { refundMinor: 0n }, voucherIssued: true }
    expect(bookingAttention(cancelled)).toEqual([])
    expect(bookingAttention({ ...cancelled, holdStatus: 'CONFIRMED' })).toEqual(['INVENTORY_NOT_RELEASED', 'VOUCHER_MISMATCH'])
  })

  it('matches the cancellation refund to the sell and to the finance fact, without treating an unread fact as a match', () => {
    const cancelled = { ...base, bookingStatus: 'CANCELLED', holdStatus: 'RELEASED', hasDebit: true, cancellation: { refundMinor: 25_000n }, refundPostedMinor: 25_000n, sellMinor: 100_000n }
    expect(bookingAttention(cancelled)).toEqual([])
    expect(bookingAttention({ ...cancelled, refundPostedMinor: 100_001n })).toEqual(['REFUND_MISSING', 'MONEY_FACT_MISMATCH'])
    expect(bookingAttention({ ...cancelled, cancellation: { refundMinor: 100_001n }, refundPostedMinor: 100_001n })).toEqual(['MONEY_FACT_MISMATCH'])
    expect(bookingAttention({ ...cancelled, hasDebit: false })).toEqual(['MONEY_FACT_MISMATCH'])
    const fact = { refundMinor: 25_000n, penaltyMinor: 75_000n, sellMinor: 100_000n }
    expect(bookingAttention({ ...cancelled, financeCancellation: fact })).toEqual([])
    expect(bookingAttention({ ...cancelled, financeCancellation: { ...fact, penaltyMinor: 70_000n } })).toEqual(['MONEY_FACT_MISMATCH'])
    expect(bookingAttention({ ...cancelled, financeCancellation: { ...fact, refundMinor: null } })).toEqual(['MONEY_FACT_MISMATCH'])
    expect(bookingAttention({ ...cancelled, financeCancellation: { ...fact, sellMinor: 90_000n } })).toEqual(['MONEY_FACT_MISMATCH'])
    expect(bookingAttention({ ...base, financeCancellation: fact })).toEqual(['MONEY_FACT_MISMATCH'])
    expect(bookingAttention({ ...cancelled, cancellation: { refundMinor: 20_000n }, refundPostedMinor: 20_000n, financeCancellation: fact })).toEqual(['MONEY_FACT_MISMATCH'])
    expect(bookingAttention({ ...cancelled, financeCancellation: null })).toEqual([])
  })

  it('never infers a status: UNKNOWN-like pending evidence is not turned into FAILED', () => {
    const flags = bookingAttention({ ...base, bookingStatus: 'PENDING_SUPPLIER', holdStatus: 'PROCESSING', hasDebit: false, holdUpdatedAt: minutesAgo(120), prebookAt: minutesAgo(120) })
    expect(flags).toEqual(['RECONCILIATION_REQUIRED', 'PREBOOK_EXPIRED_UNRESOLVED'])
    expect(flags).not.toContain('FINANCIAL_MISMATCH')
  })
})
