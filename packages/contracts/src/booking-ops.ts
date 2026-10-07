/**
 * Admin booking module read contracts (ADR 0039, Phase 1): `GET /admin/operations/bookings` and `/:bookingId`.
 *
 * The lifecycle and the Agent-facing vocabulary are separate: `BookingStatus` here is the ten-value operational lifecycle; the Agent API keeps its
 * four-value vocabulary through an explicit mapping. Money is integer minor units as strings plus an ISO-4217 currency. A null is "unknown" (not
 * recorded), never zero or false. Guest names are masked unless the caller holds `booking.pii.view`; net, markup and margin are null unless the
 * caller holds `booking.view.net`. Agency-scoped callers only ever receive their own agency's bookings.
 */
import type { BookingAction, BookingAvailableAction } from './booking-lifecycle'
import type { BookingOperationsPanel } from './booking-ops-queue'
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
  dateType?: BookingDateType | 'updated'
  from?: string
  to?: string
  paymentMode?: string
  paymentStatus?: string
  /** Hotel city or country text. */
  destination?: string
  source?: 'PORTAL' | 'API' | 'MANUAL'
  /** ISO-4217 code; required with an amount range. Amounts are integer minor units as digits. */
  currency?: string
  amountMin?: string
  amountMax?: string
  /** A user id or `unassigned`. Needs `booking.ops.view`. */
  opsOwner?: string
  /** Bookings that have this money event. Needs `booking.finance.view`. */
  moneyEvent?: string
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
  /** The caller's formal booking.* keys (owner membership implies none of the Phase 2 keys). The API re-checks on every action. */
  permissions: string[]
  /** True when this caller may enter a manual booking: `booking.manual.create` held, operator level, and `ADMIN_MANUAL_BOOKING_ENABLED` on. Only hides a button; the API checks again. */
  manualEntry: boolean
  /** True when this caller may send bookings to a supplier: `booking.supplier.retry` held, operator level, and `ADMIN_SUPPLIER_JOBS_ENABLED` on. Only hides controls; the API checks again. */
  supplierDispatch: boolean
  /** True when this caller may use the operations queue: `booking.ops.view` held, operator level, and `ADMIN_BOOKING_OPS_ENABLED` on. Only hides navigation; the API checks again. */
  opsQueue: boolean
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
  /** The lifecycle action that made this change, when it was made by one. */
  action: BookingAction | 'createManual' | 'editReferences' | 'supplierQueued' | 'supplierUnknown' | 'supplierNotFound' | 'supplierCancelFailed' | 'opsAssigned' | 'opsUnassigned' | 'opsAcknowledged' | 'opsEscalated' | 'opsDeescalated' | 'opsResolved' | 'opsNote' | 'opsAnswer' | null
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
  /** What this caller may do next on this booking, from the same rules the API enforces. Empty for a closed booking. */
  availableActions: BookingAvailableAction[]
  /** The supplier queue for this booking: jobs, the call log and what may be done now. Operator-level callers only; null for an agency caller. */
  supplier: BookingSupplierView | null
  /** The operations case (queue reason, SLA, priority, assignee, safe actions). Null when the caller lacks `booking.ops.view`, is agency-scoped, or the queue is switched off. */
  operations: BookingOperationsPanel | null
}

// ---- Phase 3: supplier jobs ---------------------------------------------------------------------------------------------
export const BOOKING_SUPPLIER_JOB_KINDS = ['BOOK', 'CANCEL', 'STATUS_CHECK'] as const
export type BookingSupplierJobKind = (typeof BOOKING_SUPPLIER_JOB_KINDS)[number]
/** QUEUED/RETRY_WAIT: waiting for the runner. RUNNING: a call is in flight. UNKNOWN: the supplier's answer could not be established; the booking is never failed from here. */
export const BOOKING_SUPPLIER_JOB_STATUSES = ['QUEUED', 'RUNNING', 'RETRY_WAIT', 'SUCCEEDED', 'FAILED', 'UNKNOWN'] as const
export type BookingSupplierJobStatus = (typeof BOOKING_SUPPLIER_JOB_STATUSES)[number]
/** The spec's retry schedule: after the first try, three retries, waiting 30 s, then 2 min, then 5 min. So a job makes at most four calls (spec: "3 attempts, 30s / 2 min / 5 min" read as three retries). */
export const BOOKING_SUPPLIER_RETRY_DELAYS_SECONDS = [30, 120, 300] as const
export const BOOKING_SUPPLIER_MAX_ATTEMPTS = 4
export const BOOKING_SUPPLIER_OPS = ['send', 'cancel', 'retryNow', 'sync'] as const
export type BookingSupplierOp = (typeof BOOKING_SUPPLIER_OPS)[number]
export const BOOKING_SUPPLIER_OP_LABEL: Record<BookingSupplierOp, string> = { send: 'Send to supplier', cancel: 'Send cancellation to supplier', retryNow: 'Retry now', sync: 'Sync with supplier' }

export interface BookingSupplierJobView { id: string; kind: BookingSupplierJobKind; status: BookingSupplierJobStatus; attempt: number; maxAttempts: number; runAfter: string | null; lastErrorCode: string | null; createdAt: string; completedAt: string | null }
/** One call to the supplier. A summary only: raw supplier requests and responses are never stored. */
export interface BookingSupplierCallView { id: string; at: string; action: BookingSupplierJobKind; attempt: number; outcome: string; errorCode: string | null; httpStatus: number | null; durationMs: number | null; supplierRef: string | null }
export interface BookingSupplierView {
  /** Why dispatch is unavailable, or null when this booking could be sent. */
  dispatch: { available: boolean; reason: 'DISABLED' | 'NOT_PERMITTED' | 'SUPPLIER_NOT_CONFIGURED' | null }
  supplierStatus: string | null
  jobs: BookingSupplierJobView[]
  calls: BookingSupplierCallView[]
  /** What the caller may start now (permission, booking status and the queue state already considered). */
  ops: BookingSupplierOp[]
}

/** `POST /admin/operations/bookings/:id/supplier`. Needs an Idempotency-Key. */
export interface BookingSupplierRequest { op: BookingSupplierOp; /** CAS, as for actions. */ expectedStatus: BookingStatus }
export interface BookingSupplierResult { bookingId: string; jobId: string; kind: BookingSupplierJobKind; status: BookingSupplierJobStatus; replayed: boolean }

// ---- Phase 2: writes ---------------------------------------------------------------------------------------------------
/** Every booking mutation requires this header (8-128 characters). A replay with the same key and the same request returns the first result. */
export const BOOKING_IDEMPOTENCY_HEADER = 'idempotency-key'
export const BOOKING_REASON_MAX = 500
export const BOOKING_REF_MAX = 64

/** `POST /admin/operations/bookings/:id/actions`. The caller names the action and the status they saw; the API decides legality. */
export interface BookingActionRequest {
  action: BookingAction
  /** CAS: the request fails with 409 if the booking is no longer in this status. */
  expectedStatus: BookingStatus
  reason?: string
  supplierRef?: string
  hotelConfirmationNo?: string
  supplierCancellationRef?: string
  confirmNonRefundable?: boolean
}
/** `PATCH /admin/operations/bookings/:id/references`: add or correct references without changing the status. Omitted fields are untouched; null clears. */
export interface BookingReferencesRequest { supplierRef?: string | null; hotelConfirmationNo?: string | null; agentRef?: string | null; reason: string }
export interface BookingWriteResult {
  bookingId: string
  reference: string
  status: BookingStatus
  version: number
  closed: boolean
  /** True when the idempotency key had already been used for this same request: nothing new was written. */
  replayed: boolean
}

/** `POST /admin/operations/bookings`: a manual (offline or phone) booking, behind `ADMIN_MANUAL_BOOKING_ENABLED`. No supplier is called, no credit is used. */
export interface ManualBookingRequest {
  agencyId: string
  hotelId: string
  supplier: string
  checkIn: string
  checkOut: string
  currency: string
  /** Integer minor units as a string. */
  sellMinor: string
  netMinor?: string
  paymentMode?: 'CREDIT' | 'PREPAID' | 'PAY_AT_HOTEL'
  isRefundable?: boolean
  cancelDeadline?: string
  /** The cancellation terms of this booking, frozen with it. Without them the penalty of a later cancellation is a person's decision, never a guess. `penaltyMinor` is a string of minor units. */
  cancellationRules?: Array<{ daysBeforeCheckin: number; penaltyPercent?: number; penaltyMinor?: string }>
  agentRef?: string
  rooms: Array<{ roomName: string; boardCode?: string; adults: number; children?: number; childAges?: number[] }>
  guests: Array<{ title?: string; firstName: string; lastName: string; isLead?: boolean; type?: 'ADULT' | 'CHILD'; age?: number }>
  /** Queue the booking to its supplier straight away (needs `booking.supplier.retry` and supplier jobs enabled). Otherwise it waits for "Send to supplier" or a manual answer. */
  sendToSupplier?: boolean
}
export const MANUAL_BOOKING_FAILURE = { disabled: 'MANUAL_BOOKING_DISABLED' } as const

