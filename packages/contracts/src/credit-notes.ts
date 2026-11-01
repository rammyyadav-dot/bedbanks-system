import type { MinorString, Paged } from './operations'

/**
 * Partial credit notes to an agency (ADR 0095 part B). A finance user proposes a credit for a charged, not cancelled booking; a different finance user approves or rejects it.
 * Approval posts one REFUND to the agency account. Amounts are integer minor units serialised as strings, in the booking currency. Cancelled bookings are credited by the cancellation settlement instead.
 */
export const CREDIT_NOTE_REASONS = ['SUPPLIER_SERVICE_FAILURE', 'PRICE_CORRECTION', 'GOODWILL'] as const
export type CreditNoteReasonName = (typeof CREDIT_NOTE_REASONS)[number]

export const CREDIT_NOTE_STATUSES = ['PROPOSED', 'APPROVED', 'REJECTED'] as const
export type CreditNoteStatusName = (typeof CREDIT_NOTE_STATUSES)[number]

/** Writes answer 503 with CREDIT_NOTES_DISABLED unless the deployment sets CREDIT_NOTES_ENABLED=true. Reads always work. */
export const CREDIT_NOTE_FAILURE = {
  disabled: 'CREDIT_NOTES_DISABLED',
  invalid: 'CREDIT_NOTE_INVALID',
  notFound: 'CREDIT_NOTE_NOT_FOUND',
  bookingNotFound: 'CREDIT_NOTE_BOOKING_NOT_FOUND',
  bookingNotCreditable: 'CREDIT_NOTE_BOOKING_STATE',
  notCharged: 'CREDIT_NOTE_NOT_LEDGER_CHARGED',
  exceedsRefundable: 'CREDIT_NOTE_EXCEEDS_REFUNDABLE',
  requestReused: 'CREDIT_NOTE_REQUEST_REUSED',
  decided: 'CREDIT_NOTE_DECIDED',
  ownProposal: 'CREDIT_NOTE_OWN_PROPOSAL',
  changed: 'CREDIT_NOTE_CHANGED',
} as const

export const creditNotePermissions = { propose: 'finance.creditnote.propose', approve: 'finance.creditnote.approve' } as const

export interface CreditNoteProposeRequest {
  /** Client-generated idempotency key (8 to 80 characters). Retrying returns the same credit note. */
  requestId: string
  bookingId: string
  /** Positive whole number of minor units in the booking currency, digits only. */
  amountMinor: string
  reason: CreditNoteReasonName
  /** Why, in words (3 to 500 characters). Do not put guest personal data here. */
  note: string
}

export interface CreditNoteDecisionRequest { reason?: string }

export interface BookingCreditNoteView {
  id: string
  number: string
  bookingId: string
  bookingReference: string
  currency: string
  amountMinor: MinorString
  reason: CreditNoteReasonName
  note: string
  status: CreditNoteStatusName
  proposedById: string
  proposedAt: string
  decidedById: string | null
  decidedAt: string | null
  decisionReason: string | null
  /** Set once approved: the REFUND entry on the agency account. */
  ledgerEntryId: string | null
  /** For the CALLER: the endpoint still enforces permission and separation of duties. */
  canDecide: boolean
}

export type BookingCreditNotePage = Paged<BookingCreditNoteView>
