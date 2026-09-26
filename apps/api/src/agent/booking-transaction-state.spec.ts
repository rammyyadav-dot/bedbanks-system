import { ConflictException } from '@nestjs/common'
import type { BookingTransactionState } from '@bedbanks/domain'
import { assertBookingTransactionTransition, canTransitionBookingTransaction } from './booking-transaction-state'

describe('booking transaction state guard', () => {
  const forward: Array<[BookingTransactionState, BookingTransactionState]> = [
    ['RECHECKED', 'INVENTORY_HELD'],
    ['INVENTORY_HELD', 'FINANCE_AUTHORIZED'],
    ['FINANCE_AUTHORIZED', 'PREBOOKED'],
    ['PREBOOKED', 'BOOKING_PENDING'],
    ['BOOKING_PENDING', 'CONFIRMED'],
  ]

  it.each(forward)('allows the guarded forward transition %s -> %s', (from, to) => {
    expect(canTransitionBookingTransaction(from, to)).toBe(true)
    expect(() => assertBookingTransactionTransition(from, to)).not.toThrow()
  })

  it.each(['RECHECKED', 'INVENTORY_HELD', 'FINANCE_AUTHORIZED', 'PREBOOKED', 'BOOKING_PENDING'] as BookingTransactionState[])(
    'allows non-terminal state %s to fail closed',
    state => expect(() => assertBookingTransactionTransition(state, 'FAILED')).not.toThrow(),
  )

  it.each([
    ['RECHECKED', 'FINANCE_AUTHORIZED'],
    ['INVENTORY_HELD', 'PREBOOKED'],
    ['FINANCE_AUTHORIZED', 'CONFIRMED'],
    ['PREBOOKED', 'CONFIRMED'],
    ['BOOKING_PENDING', 'RECHECKED'],
    ['CONFIRMED', 'BOOKING_PENDING'],
    ['CONFIRMED', 'FAILED'],
    ['FAILED', 'RECHECKED'],
    ['FAILED', 'CONFIRMED'],
  ] as Array<[BookingTransactionState, BookingTransactionState]>)('rejects invalid transition %s -> %s', (from, to) => {
    expect(canTransitionBookingTransaction(from, to)).toBe(false)
    expect(() => assertBookingTransactionTransition(from, to)).toThrow(ConflictException)
  })

  it.each(['CONFIRMED', 'FAILED'] as BookingTransactionState[])('keeps terminal state %s immutable', state => {
    expect(() => assertBookingTransactionTransition(state, state)).toThrow(ConflictException)
  })
})
