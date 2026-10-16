// Agent checkout (ADR 0066): guest details per room, non-binding special requests, terms acceptance and the confirmation result.

export const GUEST_TITLES = ['Mr', 'Mrs', 'Ms', 'Miss', 'Mstr'] as const
export type GuestTitle = typeof GUEST_TITLES[number]

/** Non-binding requests a hotel may or may not honour. The voucher prints them as "not guaranteed". */
export const SPECIAL_REQUEST_CODES = ['EARLY_CHECK_IN', 'LATE_CHECK_IN', 'LATE_CHECK_OUT', 'NON_SMOKING', 'HIGH_FLOOR', 'QUIET_ROOM', 'TWIN_BEDS', 'DOUBLE_BED', 'ADJOINING_ROOMS', 'HONEYMOON'] as const
export type SpecialRequestCode = typeof SPECIAL_REQUEST_CODES[number]
export const SPECIAL_REQUEST_LABELS: Record<SpecialRequestCode, string> = {
  EARLY_CHECK_IN: 'Early check-in', LATE_CHECK_IN: 'Late check-in', LATE_CHECK_OUT: 'Late check-out', NON_SMOKING: 'Non-smoking room', HIGH_FLOOR: 'High floor',
  QUIET_ROOM: 'Quiet room', TWIN_BEDS: 'Twin beds', DOUBLE_BED: 'Double bed', ADJOINING_ROOMS: 'Adjoining rooms', HONEYMOON: 'Honeymoon / special occasion',
}
export const SPECIAL_REQUEST_NOTE_MAX = 300
export const AGENT_REF_MAX = 60
export const CONFIRMATION_CC_MAX = 3
/** Estimated arrival, hotel local time, 24-hour "HH:MM". Optional, non-binding, printed on the voucher like a special request. */
export const ARRIVAL_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/
/** Prebook refusal (409) when the agency already holds an active booking for the same lead guest, hotel and dates. Repeat with acknowledgeDuplicate: true to book anyway. */
export const DUPLICATE_BOOKING_SUSPECTED = 'DUPLICATE_BOOKING_SUSPECTED'
/** One entry of the 409's error.details: the existing booking, never its guests. */
export interface DuplicateBookingMatch { reference: string; status: string; createdAt: string }

export interface CheckoutGuest {
  /** 1-based room within the booking. */
  roomNumber: number
  type: 'ADULT' | 'CHILD'
  title?: GuestTitle
  firstName: string
  lastName: string
  /** Required for a child; must equal one of the searched child ages. */
  age?: number
}

export interface CheckoutSpecialRequests { codes: SpecialRequestCode[]; note?: string; arrivalTime?: string }

/** Extra fields of POST routes.agent.prebook (on top of hold, idempotency key and occupancy). */
export interface CheckoutDetails {
  guests?: CheckoutGuest[]
  agentRef?: string
  specialRequests?: CheckoutSpecialRequests
  /** Must be true when booking is enabled: the agent accepted the cancellation policy and booking terms. */
  termsAccepted?: boolean
  /** The agent saw the duplicate-booking warning and books anyway. Audited. */
  acknowledgeDuplicate?: boolean
}

/** Extra field of POST routes.agent.bookings (confirm). */
export interface ConfirmBookingRequest { bookingId: string; ccEmails?: string[] }

/** The confirmation email's true state: queued in the outbox (sent by the dispatcher when enabled), or not queued because there is no recipient. */
export type ConfirmationEmailState = { status: 'queued'; to: string; cc: string[] } | { status: 'not_queued'; reason: 'no_recipient' }

export interface ConfirmBookingResponse {
  bookingId: string
  reference: string
  status: 'CONFIRMED'
  alreadyConfirmed: boolean
  /** Issued right after confirmation; null when issuing failed (the documents can still be opened from My bookings). */
  documents: { voucher: string | null; invoice: string | null }
  email: ConfirmationEmailState
}
