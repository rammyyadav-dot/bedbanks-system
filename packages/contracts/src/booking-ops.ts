/**
 * Admin booking module read contracts (ADR 0039, Phase 1): `GET /admin/operations/bookings` and `/:bookingId`.
 *
 * The lifecycle and the Agent-facing vocabulary are separate: `BookingStatus` here is the ten-value operational lifecycle; the Agent API keeps its
 * four-value vocabulary through an explicit mapping. Money is integer minor units as strings plus an ISO-4217 currency. A null is "unknown" (not
 * recorded), never zero or false. Guest names are masked unless the caller holds `booking.pii.view`; net, markup and margin are null unless the
 * caller holds `booking.view.net`. Agency-scoped callers only ever receive their own agency's bookings.
 */
import type { BookingAttention, BookingOperations, BookingStatus, MinorString, SectionState } from './operations'

export const BOOKING_QUICK_SEARCHES = ['needsAction', 'latest', 'checkInNext7', 'missingSupplierRef', 'deadline48h', 'failed', 'latestCancelled', 'onRequest', 'unpaid', 'noShowCandidates'] as const
export type BookingQuickSearch = (typeof BOOKING_QUICK_SEARCHES)[number]
export const BOOKING_QUICK_SEARCH_LABEL: Record<BookingQuickSearch, string> = {
  needsAction: 'Needs action', latest: 'Latest bookings', checkInNext7: 'Check-in next 7 days', missingSupplierRef: 'Missing supplier ref', deadline48h: 'Deadline in 48h',
  failed: 'Failed', latestCancelled: 'Latest cancelled', onRequest: 'On request', unpaid: 'Unpaid', noShowCandidates: 'No-show candidates',
}
/** Phase 1 defines Needs action by status only (SLA ordering and the computed Urgent rules arrive in Phase 4). */
export const BOOKING_NEEDS_ACTION_STATUSES = ['PENDING_SUPPLIER', 'ON_REQUEST', 'AMEND_REQUESTED', 'CANCEL_REQUESTED', 'FAILED'] as const satisfies readonly BookingStatus[]

export const BOOKING_DATE_TYPES = ['created', 'checkIn', 'checkOut', 'cancelDeadline'] as const
export type BookingDateType = (typeof BOOKING_DATE_TYPES)[number]
export const BOOKING_SORTS = ['created', 'checkIn', 'checkOut', 'deadline', 'amount'] as const
export type BookingSort = (typeof BOOKING_SORTS)[number]
export const BOOKING_PAGE_SIZES = [25, 50, 100] as const
export const BOOKING_PAYMENT_MODES = ['CREDIT', 'PREPAID', 'PAY_AT_HOTEL'] as const
export const BOOKING_PAYMENT_STATUSES = ['PAID', 'UNPAID', 'OVERDUE'] as const
/** Sentinel for "bookings whose agency could not be derived". Operator-level callers only. */
export const BOOKING_UNASSIGNED_AGENCY = 'unassigned'

/** Every filter is applied together and lives in the URL. Comma-separated for multi-select. */
export interface BookingListQuery {
  chip?: BookingQuickSearch
  /** FBEDS reference (prefix), supplier reference, hotel confirmation number or the agency's own reference. */
  reference?: string
  /** Lead guest or any guest. Needs `booking.pii.view`. */
  guest?: string
  agencyId?: string
  supplier?: string
  hotelId?: string
  /** Hotel name, city or country text. */
  hotel?: string
  status?: string
  supplierStatus?: string
  dateType?: BookingDateType
  from?: string
  to?: string
  paymentMode?: string
  paymentStatus?: string
  missingSupplierRef?: boolean
  nonRefundable?: boolean
  amended?: boolean
  /** Reconciliation flags from the existing transaction evidence. Needs that evidence to be readable. */
  attention?: boolean
  sort?: BookingSort
  dir?: 'asc' | 'desc'
  page?: number
  pageSize?: number
}

export interface BookingAccessView {
  /** OPERATOR: every agency of the operator. AGENCY: one agency only. */
  level: 'OPERATOR' | 'AGENCY'
  canViewNet: boolean
  canViewPii: boolean
  /** For an agency-scoped caller: the agency every result belongs to. */
  agencyId: string | null
}

export interface BookingListRow {
  id: string
  /** The existing `FB-` reference. */
  reference: string
  status: BookingStatus
  /** The supplier's own answer, kept apart from `status`. */
  supplierStatus: string | null
  agency: { id: string; name: string } | null
  /** Display name of the agent who booked, when known. */
  agent: string | null
  supplier: string
  supplierRef: string | null
  hotelConfirmationNo: string | null
  agentRef: string | null
  channel: 'PORTAL' | 'API' | 'MANUAL'
  /** Names are masked ("A••• H•••") without `booking.pii.view`. */
  leadGuest: { name: string; masked: boolean } | null
  guests: { adults: number; children: number } | null
  hotel: { id: string; name: string | null; city: string | null; timeZone: string | null }
  room: { name: string | null; board: string | null; quantity: number } | null
  checkIn: string | null
  checkOut: string | null
  nights: number | null
  createdAt: string
  cancelDeadline: string | null
  currency: string
  sellMinor: MinorString
  /** Null without `booking.view.net`, or when the net is not recorded. */
  netMinor: MinorString | null
  marginMinor: MinorString | null
  paymentMode: string | null
  paymentStatus: string | null
  isRefundable: boolean | null
  version: number
  closedAt: string | null
  assignedTo: { id: string; name: string } | null
  /** True when the booking is Confirmed and no supplier reference is recorded. */
  missingSupplierRef: boolean
  amended: boolean
  /** Reconciliation flags from transaction evidence. Null when that evidence is not readable by the API database role: unknown, not "no flags". */
  attention: BookingAttention[] | null
}

export interface BookingListPage {
  items: BookingListRow[]
  page: number
  pageSize: number
  /** Exact count of bookings matching every filter, within the caller's scope. */
  total: number
  access: BookingAccessView
  /** Echo of what was applied, so an empty state can say which filter removed everything. */
  applied: Array<{ key: string; label: string; value: string }>
  /** False when reconciliation flags could not be read (shown as unavailable, not as none). */
  attentionAvailable: boolean
  /** True when the attention filter scanned the newest bookings only (the cap is part of the contract). */
  scanCapped: boolean
}

export interface BookingRoomView { position: number; quantity: number; roomName: string | null; boardCode: string | null; adults: number; children: number; childAges: number[]; sellMinor: MinorString | null; netMinor: MinorString | null }
export interface BookingGuestView { name: string; masked: boolean; isLead: boolean; type: 'ADULT' | 'CHILD'; age: number | null; roomPosition: number | null }
export interface BookingTimelineItem {
  kind: 'status' | 'audit'
  at: string
  /** Status changes: the transition. Audit items: the action name. */
  title: string
  fromStatus: BookingStatus | null
  toStatus: BookingStatus | null
  actorType: 'USER' | 'SYSTEM' | 'SUPPLIER' | null
  actor: string | null
  reason: string | null
  /** True for rows written when the log was introduced: earlier history is in the audit items. */
  backfilled: boolean
  requestId: string | null
}

export interface BookingDetailView {
  access: BookingAccessView
  booking: Omit<BookingListRow, 'attention' | 'leadGuest' | 'guests' | 'room'> & { hotelAddress: string | null; specialRequests: null }
  rooms: BookingRoomView[]
  guests: BookingGuestView[]
  pricing: {
    currency: string
    sellMinor: MinorString
    netMinor: MinorString | null
    markupMinor: MinorString | null
    marginMinor: MinorString | null
    /** Frozen at booking time; reports convert with this, never today's rate. */
    fxRate: string | null
    isRefundable: boolean | null
    cancelDeadline: string | null
    /** Not stored on bookings yet: shown as unavailable, not invented. */
    cancellationPolicy: null
    markupRule: null
    /** Why a field is null, so the screen can say "not visible to you" or "not recorded". */
    netVisibility: 'VISIBLE' | 'HIDDEN_BY_PERMISSION' | 'NOT_RECORDED'
  }
  timeline: BookingTimelineItem[]
  /** The existing transaction record: hold, finance, documents, reconciliation flags. Unavailable when the API database role cannot read it; null for an agency-scoped caller, who never sees internal finance or audit. */
  operationsRecord: SectionState<BookingOperations> | null
}
