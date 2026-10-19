/**
 * Supplier extranet read models (ADR 0011, ADR 0061). Every route is scoped server-side to the caller's active supplier
 * organization. No identifier here is an authorization input. Monetary amounts are deliberately absent from this slice.
 */
export type ExtranetPermission =
  | 'supplier.extranet.hotels.read'
  | 'supplier.extranet.rooms.read'
  | 'supplier.extranet.drafts.manage'
  | 'supplier.extranet.contracts.read'
  | 'supplier.extranet.bookings.read'
  | 'supplier.extranet.bookings.answer'

/** GET /supplier/extranet/contracts (`supplier.extranet.contracts.read`). Read-only; the supplier cannot create or change a contract here. */
export interface ExtranetRatePlanSummary {
  id: string
  code: string
  status: 'DRAFT' | 'ACTIVE' | 'SUSPENDED' | 'EXPIRED'
  roomTypeName: string
  boardBasis: string
  refundable: boolean
  occupancy: number
  /** ISO-4217. */
  currency: string
  /** ISO dates (YYYY-MM-DD). Null inherits the contract term. */
  validFrom: string | null
  validTo: string | null
}

export interface ExtranetContractSummary {
  id: string
  code: string
  status: 'DRAFT' | 'REVIEW' | 'ACTIVE' | 'EXPIRED' | 'SUSPENDED'
  hotelId: string | null
  hotelName: string | null
  validFrom: string
  validTo: string
  /** ISO-4217. */
  settlementCurrency: string
  ratePlans: ExtranetRatePlanSummary[]
}

export interface ExtranetContractList { contracts: ExtranetContractSummary[] }

/**
 * GET /supplier/extranet/bookings and /bookings/:bookingId (`supplier.extranet.bookings.read`), ADR 0061 Amendment 1.
 * Only bookings whose frozen `supplierId` is the caller's active organization are returned. Read-only.
 *
 * Deliberately absent from every shape here: sell or total price, markup, FX rate, agency or agent identity, channel, payment, wallet or ledger data,
 * and the raw search snapshot. Money is an integer string of minor units in `currency`; `null` means "not recorded", never zero.
 */
export type ExtranetBookingStatus =
  | 'PENDING_SUPPLIER' | 'ON_REQUEST' | 'CONFIRMED' | 'AMEND_REQUESTED' | 'CANCEL_REQUESTED' | 'CANCELLED' | 'CHECKED_OUT' | 'NO_SHOW' | 'REJECTED' | 'FAILED'

/** RECORDED: every room line has a net and the total reconciles. PARTIAL: some lines lack a net. NOT_RECORDED: none does. MISMATCH: the lines do not reconcile with the stored booking net. */
export type ExtranetNetStatus = 'RECORDED' | 'PARTIAL' | 'NOT_RECORDED' | 'MISMATCH'

export interface ExtranetBookingRoom {
  position: number
  roomName: string | null
  boardCode: string | null
  quantity: number
  adults: number
  children: number
  /** The supplier's net for this room line, integer minor units in the booking `currency`. Null: not recorded. */
  netMinor: string | null
}

export interface ExtranetBookingSummary {
  id: string
  reference: string
  status: ExtranetBookingStatus
  hotelId: string
  hotelName: string | null
  /** ISO dates (YYYY-MM-DD). */
  checkIn: string | null
  checkOut: string | null
  nights: number | null
  /** Lead guest's name only. No contact detail is ever returned. */
  leadGuestName: string | null
  /** ISO-4217 currency of every amount below. */
  currency: string
  /** Sum of the room-line nets. Only present when `netStatus` is RECORDED. */
  netMinor: string | null
  netStatus: ExtranetNetStatus
  supplierRef: string | null
  createdAt: string
}

export interface ExtranetBookingDetail extends ExtranetBookingSummary {
  hotelConfirmationNo: string | null
  rooms: ExtranetBookingRoom[]
}

export interface ExtranetBookingList {
  bookings: ExtranetBookingSummary[]
  /** Opaque. Pass back as `cursor` for the next page; null when there is none. */
  nextCursor: string | null
}

/** Query of GET /supplier/extranet/bookings. Every field optional; `limit` is 1-50 (default 25). */
export interface ExtranetBookingQuery {
  status?: ExtranetBookingStatus
  /** Arrival date range, inclusive, YYYY-MM-DD. */
  checkInFrom?: string
  checkInTo?: string
  /** Booking reference prefix, 3-40 characters. */
  reference?: string
  limit?: number
  cursor?: string
}

/**
 * POST /supplier/extranet/bookings/:bookingId/answer (`supplier.extranet.bookings.answer`), ADR 0061 Amendment 2.
 * The supplier answers one of its own bookings. Only these three answers exist; cancellations and "no booking exists" stay with fBeds operators.
 * Requires an `Idempotency-Key` header (8-128 of A-Z a-z 0-9 . _ : -). The caller states the status it saw; a different current status is a 409.
 */
export const EXTRANET_BOOKING_ANSWERS = ['CONFIRMED', 'ON_REQUEST', 'REJECTED'] as const
export type ExtranetBookingAnswer = (typeof EXTRANET_BOOKING_ANSWERS)[number]

export interface ExtranetBookingAnswerRequest {
  answer: ExtranetBookingAnswer
  /** Compare-and-set: the booking must still be in this status. */
  expectedStatus: ExtranetBookingStatus
  /** Your own booking reference. Required to confirm. */
  supplierRef?: string
  hotelConfirmationNo?: string
  /** Required to reject (at least 10 characters). */
  reason?: string
}

export interface ExtranetBookingAnswerResult {
  bookingId: string
  reference: string
  status: ExtranetBookingStatus
  /** True when the same Idempotency-Key and body had already been applied. Nothing changed on this call. */
  replayed: boolean
}
