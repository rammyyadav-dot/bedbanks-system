import type { BookingAction, ExtranetBookingAnswer, ExtranetBookingStatus } from '@bedbanks/contracts'

export const SUPPLIER_ANSWER_REASON_MIN = 10

/**
 * A supplier-visible booking is always contracted inventory, so it holds the agency's wallet reservation and an inventory hold until the agent confirmation
 * (or the reconciliation sweep) settles them. The booking-module role this service writes with is forbidden from the ledger, wallets and holds, so an answer
 * that only moved the status would leave money and stock unsettled (confirm: never debited, stock still held; reject: funds and stock never released).
 * Until a settlement path exists (ADR 0061 Amendment 4) a first answer is refused; a replay of an answer already recorded still returns its stored result.
 */
export const ANSWER_REQUIRES_SETTLEMENT = 'ANSWER_REQUIRES_SETTLEMENT'
export const ANSWER_REQUIRES_SETTLEMENT_MESSAGE = 'This booking is still being settled by fBeds, so it cannot be answered here yet. Nothing was changed. Contact your fBeds account manager to have it answered.'

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
