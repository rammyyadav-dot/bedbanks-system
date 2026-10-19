import type { BookingAction, ExtranetBookingAnswer, ExtranetBookingStatus } from '@bedbanks/contracts'

export const SUPPLIER_ANSWER_REASON_MIN = 10

/**
 * The lifecycle action a supplier answer maps to, per the booking's current status (ADR 0061 Amendment 2, option A).
 * Mirrors BOOKING_OPS_ANSWER_RULES for the three answers a supplier may give; anything else is null and refused. Cancellation answers and
 * "no booking exists" are deliberately absent: they credit agencies or clear unknown outcomes and need evidence only fBeds can weigh.
 */
export function supplierAnswerAction(answer: ExtranetBookingAnswer, status: ExtranetBookingStatus): { action: BookingAction; supplierStatus: string } | null {
  switch (answer) {
    case 'CONFIRMED':
      if (status === 'PENDING_SUPPLIER') return { action: 'systemConfirm', supplierStatus: 'CONFIRMED' }
      if (status === 'ON_REQUEST') return { action: 'systemConfirmOnRequest', supplierStatus: 'CONFIRMED' }
      return null
    case 'ON_REQUEST':
      return status === 'PENDING_SUPPLIER' ? { action: 'systemOnRequest', supplierStatus: 'ON_REQUEST' } : null
    case 'REJECTED':
      if (status === 'PENDING_SUPPLIER') return { action: 'systemFail', supplierStatus: 'REJECTED' }
      if (status === 'ON_REQUEST') return { action: 'systemRejectOnRequest', supplierStatus: 'REJECTED' }
      return null
  }
}

/** Fields a supplier must give for an answer. Returns the names of the missing ones. */
export function missingAnswerFields(answer: ExtranetBookingAnswer, input: { supplierRef?: string; reason?: string }): string[] {
  const missing: string[] = []
  if (answer === 'CONFIRMED' && !input.supplierRef?.trim()) missing.push('supplierRef')
  if (answer === 'REJECTED' && (input.reason?.trim().length ?? 0) < SUPPLIER_ANSWER_REASON_MIN) missing.push('reason')
  return missing
}
