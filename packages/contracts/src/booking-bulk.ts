/**
 * Bulk actions on bookings (ADR 0039, Phase 6C). The bulk layer is ORCHESTRATION ONLY: for each booking it calls the existing single-booking service, which keeps
 * its own permission check, row lock, version check, idempotency and audit. Nothing here (or in its API service) updates a booking by any other path.
 *
 * Explicit booking ids only, at most `BOOKING_BULK_MAX_IDS`, never truncated: a request above the limit is refused. Only non-financial operational actions
 * with an existing safe single-booking equivalent are offered; cancellation, penalties, waivers, documents, money events, ledger and supplier financial actions are
 * individual workflows and are deliberately absent from this enum.
 * Pure and shared by the API (which enforces) and the Admin (which only displays).
 */
export const BOOKING_BULK_ACTIONS = ['ASSIGN_OWNER', 'ACKNOWLEDGE'] as const
export type BookingBulkAction = (typeof BOOKING_BULK_ACTIONS)[number]
export const BOOKING_BULK_MAX_IDS = 100
export const BOOKING_BULK_ACTION_LABEL: Readonly<Record<BookingBulkAction, string>> = { ASSIGN_OWNER: 'Assign or change owner', ACKNOWLEDGE: 'Acknowledge my cases' }
/** Layer 1: the capability to invoke each bulk action. Layer 3 (the exact single-booking permission) is enforced per booking by the existing service. */
export const BOOKING_BULK_PERMISSION: Readonly<Record<BookingBulkAction, string>> = { ASSIGN_OWNER: 'booking.bulk.assign', ACKNOWLEDGE: 'booking.bulk.acknowledge' }
/** The single-booking permission each action maps to (informational: the existing service enforces it). */
export const BOOKING_BULK_UNDERLYING_PERMISSION: Readonly<Record<BookingBulkAction, string>> = { ASSIGN_OWNER: 'booking.ops.assign', ACKNOWLEDGE: 'booking.ops.assign' }

export const BOOKING_BULK_STATUSES = ['PENDING', 'PROCESSING', 'PARTIAL', 'SUCCEEDED', 'FAILED'] as const
export type BookingBulkStatus = (typeof BOOKING_BULK_STATUSES)[number]
export const BOOKING_BULK_ITEM_STATUSES = ['PENDING', 'SUCCEEDED', 'FAILED'] as const
export type BookingBulkItemStatus = (typeof BOOKING_BULK_ITEM_STATUSES)[number]

/** Stable, machine-readable reasons an item can fail. Never an exception message. */
export const BOOKING_BULK_ITEM_ERRORS = ['NOT_FOUND', 'FORBIDDEN', 'ASSIGNEE_NOT_ALLOWED', 'INVALID_STATE', 'STALE_STATE', 'IDEMPOTENCY_CONFLICT', 'INTERNAL_ERROR'] as const
export type BookingBulkItemError = (typeof BOOKING_BULK_ITEM_ERRORS)[number]
export const BOOKING_BULK_ITEM_ERROR_LABEL: Readonly<Record<BookingBulkItemError, string>> = {
  NOT_FOUND: 'Booking not found', FORBIDDEN: 'You do not have permission to do this to this booking', ASSIGNEE_NOT_ALLOWED: 'That person cannot own cases here',
  INVALID_STATE: 'Not possible in the booking’s current state', STALE_STATE: 'Changed while the action ran; nothing was applied', IDEMPOTENCY_CONFLICT: 'A conflicting earlier request exists', INTERNAL_ERROR: 'Could not be completed; nothing was applied',
}

export type BookingBulkRequest =
  | { bookingIds: string[]; action: 'ASSIGN_OWNER'; payload: { assigneeUserId: string | null }; idempotencyKey: string }
  | { bookingIds: string[]; action: 'ACKNOWLEDGE'; payload: Record<string, never>; idempotencyKey: string }

export type BookingBulkIssueCode = 'BOOKING_BULK_INVALID' | 'BOOKING_BULK_EMPTY' | 'BOOKING_BULK_TOO_MANY' | 'BOOKING_BULK_DUPLICATE_IDS' | 'BOOKING_BULK_UNSUPPORTED_ACTION' | 'BOOKING_BULK_UNKNOWN_FIELD'
export interface BookingBulkIssue { field: string; code: BookingBulkIssueCode; message: string }
export type BookingBulkValidation = { ok: true; value: BookingBulkRequest } | { ok: false; issues: BookingBulkIssue[] }

const IDENTIFIER = /^[A-Za-z0-9_.:-]{1,80}$/
const KEY = /^[A-Za-z0-9._:-]{8,128}$/

/** Strict validation of a bulk request. Every problem is reported at once; unknown fields are refused; nothing is truncated or deduplicated for the caller. */
export function validateBulkRequest(body: unknown): BookingBulkValidation {
  const issues: BookingBulkIssue[] = []
  const bad = (field: string, code: BookingBulkIssueCode, message: string) => { issues.push({ field, code, message }) }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { ok: false, issues: [{ field: '*', code: 'BOOKING_BULK_INVALID', message: 'A request body is required' }] }
  const b = body as Record<string, unknown>
  for (const key of Object.keys(b)) if (!['bookingIds', 'action', 'payload', 'idempotencyKey'].includes(key)) bad(key, 'BOOKING_BULK_UNKNOWN_FIELD', `Unsupported field "${key.slice(0, 40)}"`)
  const ids = b.bookingIds
  if (!Array.isArray(ids)) bad('bookingIds', 'BOOKING_BULK_INVALID', 'bookingIds must be a list')
  else {
    if (ids.length === 0) bad('bookingIds', 'BOOKING_BULK_EMPTY', 'Select at least one booking')
    if (ids.length > BOOKING_BULK_MAX_IDS) bad('bookingIds', 'BOOKING_BULK_TOO_MANY', `At most ${BOOKING_BULK_MAX_IDS} bookings per bulk action (you sent ${ids.length}). Nothing was processed.`)
    else if (ids.some((id) => typeof id !== 'string' || !IDENTIFIER.test(id))) bad('bookingIds', 'BOOKING_BULK_INVALID', 'Every booking id must be a valid id')
    else if (new Set(ids as string[]).size !== ids.length) bad('bookingIds', 'BOOKING_BULK_DUPLICATE_IDS', 'The same booking is listed more than once')
  }
  const action = b.action
  if (typeof action !== 'string' || !(BOOKING_BULK_ACTIONS as readonly string[]).includes(action)) bad('action', 'BOOKING_BULK_UNSUPPORTED_ACTION', 'That bulk action is not supported')
  else {
    const p = b.payload
    const payload = p === undefined ? {} : p
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) bad('payload', 'BOOKING_BULK_INVALID', 'payload must be an object')
    else if (action === 'ASSIGN_OWNER') {
      const keys = Object.keys(payload)
      const a = (payload as { assigneeUserId?: unknown }).assigneeUserId
      if (keys.some((k) => k !== 'assigneeUserId')) bad('payload', 'BOOKING_BULK_UNKNOWN_FIELD', 'Only assigneeUserId is accepted')
      if (!(a === null || (typeof a === 'string' && IDENTIFIER.test(a)))) bad('payload.assigneeUserId', 'BOOKING_BULK_INVALID', 'assigneeUserId must be a user id, or null to unassign')
    } else if (Object.keys(payload).length > 0) bad('payload', 'BOOKING_BULK_UNKNOWN_FIELD', 'This action takes no payload')
  }
  if (typeof b.idempotencyKey !== 'string' || !KEY.test(b.idempotencyKey)) bad('idempotencyKey', 'BOOKING_BULK_INVALID', 'An idempotencyKey of 8 to 128 letters, digits or . _ : - is required')
  if (issues.length) return { ok: false, issues }
  const value = (b.action === 'ASSIGN_OWNER'
    ? { bookingIds: [...(ids as string[])], action: 'ASSIGN_OWNER', payload: { assigneeUserId: ((b.payload ?? {}) as { assigneeUserId: string | null }).assigneeUserId }, idempotencyKey: b.idempotencyKey as string }
    : { bookingIds: [...(ids as string[])], action: 'ACKNOWLEDGE', payload: {}, idempotencyKey: b.idempotencyKey as string }) as BookingBulkRequest
  return { ok: true, value }
}

/** The status of a finished operation: all succeeded, all failed, or PARTIAL. Never "success" when anything failed. */
export function finalBulkStatus(succeeded: number, failed: number): BookingBulkStatus {
  if (failed === 0 && succeeded > 0) return 'SUCCEEDED'
  if (succeeded === 0) return 'FAILED'
  return 'PARTIAL'
}

export interface BookingBulkItemView { bookingId: string; reference: string | null; status: BookingBulkItemStatus; errorCode: BookingBulkItemError | null }
export interface BookingBulkOperationView {
  id: string
  action: BookingBulkAction
  status: BookingBulkStatus
  requestedCount: number
  processedCount: number
  succeededCount: number
  failedCount: number
  createdAt: string
  completedAt: string | null
  /** True when this response is an earlier operation returned for a repeated request: nothing was applied again. */
  replayed: boolean
  /** Failure counts by reason, so a partial result can be read at a glance. */
  failuresByCode: Partial<Record<BookingBulkItemError, number>>
  items: BookingBulkItemView[]
}
export const BOOKING_BULK_FAILURE = { forbidden: 'BOOKING_BULK_FORBIDDEN', notFound: 'BOOKING_BULK_NOT_FOUND', idempotencyConflict: 'IDEMPOTENCY_CONFLICT' } as const
