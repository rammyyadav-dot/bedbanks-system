import { bookingAttention, type AttentionFacts } from './booking-attention'

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

  it('never infers a status: UNKNOWN-like pending evidence is not turned into FAILED', () => {
    const flags = bookingAttention({ ...base, bookingStatus: 'PENDING_SUPPLIER', holdStatus: 'PROCESSING', hasDebit: false, holdUpdatedAt: minutesAgo(120), prebookAt: minutesAgo(120) })
    expect(flags).toEqual(['RECONCILIATION_REQUIRED', 'PREBOOK_EXPIRED_UNRESOLVED'])
    expect(flags).not.toContain('FINANCIAL_MISMATCH')
  })
})
