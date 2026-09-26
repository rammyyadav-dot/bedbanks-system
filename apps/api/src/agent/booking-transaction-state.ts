import { ConflictException } from '@nestjs/common'
import type { BookingTransactionState } from '@bedbanks/domain'

const ALLOWED_TRANSITIONS: Readonly<Record<BookingTransactionState, readonly BookingTransactionState[]>> = {
  RECHECKED: ['INVENTORY_HELD', 'FAILED'],
  INVENTORY_HELD: ['FINANCE_AUTHORIZED', 'FAILED'],
  FINANCE_AUTHORIZED: ['PREBOOKED', 'FAILED'],
  PREBOOKED: ['BOOKING_PENDING', 'FAILED'],
  BOOKING_PENDING: ['CONFIRMED', 'FAILED'],
  CONFIRMED: [],
  FAILED: [],
}

export function canTransitionBookingTransaction(from: BookingTransactionState, to: BookingTransactionState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to)
}

export function assertBookingTransactionTransition(from: BookingTransactionState, to: BookingTransactionState): void {
  if (!canTransitionBookingTransaction(from, to)) {
    throw new ConflictException(`Invalid booking transaction transition: ${from} -> ${to}`)
  }
}
