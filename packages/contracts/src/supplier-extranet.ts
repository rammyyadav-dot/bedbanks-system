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
  | 'supplier.extranet.changes.read'
  | 'supplier.extranet.changes.author'

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
  /** True when the contract has more plans than are listed (the list is capped at 200). */
  ratePlansTruncated: boolean
}

export interface ExtranetContractList {
  contracts: ExtranetContractSummary[]
  /** Opaque. Pass back as `cursor` for the next page; null when there is none. Query: `limit` 1-50 (default 25). */
  nextCursor: string | null
}

/** GET /supplier/extranet/hotels (`supplier.extranet.hotels.read`). Keyset-paged by hotel name; query `limit` 1-50 (default 25) and `cursor`. */
export interface ExtranetHotelSummary {
  id: string
  name: string
  city: string
  countryCode: string
  propertyType: string
  contentStatus: string
  mappingStatus: string
}
export interface ExtranetHotelList {
  hotels: ExtranetHotelSummary[]
  nextCursor: string | null
}

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

/**
 * Availability change sets (`supplier.extranet.changes.read` / `.author`), ADR 0061 Amendment 3, slice 4a.
 * The supplier prepares a CSV of availability and stop-sale changes for one mapped hotel; it is validated, stored as a DRAFT, frozen on submit and
 * reviewed by fBeds staff. Nothing here changes the live calendar. Rates are not accepted in this slice.
 *
 * CSV columns: `plan_code` or `plan_id`, `date`, and any of `allotment`, `stop_sell`, `min_stay`, `release_days`. At most 366 cells per set.
 * Create, replace, submit and withdraw need an `Idempotency-Key` header (8-128 of A-Z a-z 0-9 . _ : -); one key names one request per organization.
 */
export const EXTRANET_CHANGE_SET_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'APPLIED', 'FAILED', 'WITHDRAWN'] as const
export type ExtranetChangeSetStatus = (typeof EXTRANET_CHANGE_SET_STATUSES)[number]

export interface ExtranetChangeCell {
  ratePlanId: string
  ratePlanCode: string
  /** ISO date (YYYY-MM-DD). */
  stayDate: string
  allotment: number
  stopSell: boolean
  minStay: number
  /** Null: use the plan's release. */
  releaseDays: number | null
}

export interface ExtranetChangeSetSummary {
  id: string
  hotelId: string
  hotelName: string | null
  status: ExtranetChangeSetStatus
  /** Increases each time a draft's cells are replaced. */
  version: number
  cellCount: number
  createdAt: string
  submittedAt: string | null
}

export interface ExtranetChangeSetEvent {
  action: string
  fromStatus: ExtranetChangeSetStatus | null
  toStatus: ExtranetChangeSetStatus
  createdAt: string
}

export interface ExtranetChangeSetDetail extends ExtranetChangeSetSummary {
  /** SHA-256 over the canonical cells. */
  contentSha256: string
  cells: ExtranetChangeCell[]
  events: ExtranetChangeSetEvent[]
}

export interface ExtranetChangeSetList {
  changeSets: ExtranetChangeSetSummary[]
  /** Opaque. Pass back as `cursor` for the next page; null when there is none. Query: `status`, `limit` 1-50 (default 25). */
  nextCursor: string | null
}

export interface ExtranetImportIssue {
  line: number
  code: string
  message: string
  field?: string
}

/** The validator's report. `ok` is false when `fatal` or `errors` is non-empty; nothing is stored then. */
export interface ExtranetChangeSetPreview {
  ok: boolean
  fatal: ExtranetImportIssue[]
  errors: ExtranetImportIssue[]
  warnings: ExtranetImportIssue[]
  truncatedErrors: boolean
  cells: ExtranetChangeCell[]
}

/** POST /supplier/extranet/change-sets/preview and POST /supplier/extranet/change-sets. */
export interface ExtranetChangeSetCreateRequest { hotelId: string; csv: string }
/** PUT /supplier/extranet/change-sets/:changeSetId (a DRAFT only). `expectedVersion` is the version the supplier last saw. */
export interface ExtranetChangeSetReplaceRequest { csv: string; expectedVersion: number }
/** POST .../submit and .../withdraw. */
export interface ExtranetChangeSetTransitionRequest { expectedVersion: number }

export interface ExtranetChangeSetResult {
  changeSet: ExtranetChangeSetDetail
  /** True when the same Idempotency-Key and body had already been applied. Nothing changed on this call. */
  replayed: boolean
}
