// Pure helpers for the booking action dialogs and the manual entry form (ADR 0039, Phase 2). No React, no network.
import { BOOKING_REASON_MAX, BOOKING_REF_MAX, type BookingActionField, type BookingAvailableAction, type BookingActionRequest, type BookingStatus, type ManualBookingRequest } from '@bedbanks/contracts'
import { ApiResponseError } from './api/errors'
import { parseMajorToMinor } from './minor-units'

export const newIdempotencyKey = (): string => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(16).slice(2)}`)

export interface ActionFormState { reason: string; supplierRef: string; hotelConfirmationNo: string; supplierCancellationRef: string; confirmNonRefundable: boolean }
export const emptyActionForm = (): ActionFormState => ({ reason: '', supplierRef: '', hotelConfirmationNo: '', supplierCancellationRef: '', confirmNonRefundable: false })

export const FIELD_LABEL: Record<BookingActionField, string> = {
  reason: 'Reason', supplierRef: 'Supplier reference', hotelConfirmationNo: 'Hotel confirmation number', supplierCancellationRef: 'Supplier cancellation reference', confirmNonRefundable: 'Second confirmation',
}

/** Builds the request body, or lists what is still missing. Trims; never sends empty strings. */
export function buildActionRequest(action: BookingAvailableAction, expectedStatus: BookingStatus, form: ActionFormState): { request: BookingActionRequest } | { missing: BookingActionField[] } {
  const value = (v: string) => v.trim()
  const missing: BookingActionField[] = []
  for (const field of action.required) {
    if (field === 'confirmNonRefundable') continue
    if (!value(form[field])) missing.push(field)
  }
  if (action.needsSecondConfirmation && !form.confirmNonRefundable) missing.push('confirmNonRefundable')
  if (missing.length) return { missing }
  const request: BookingActionRequest = { action: action.action, expectedStatus }
  if (value(form.reason)) request.reason = value(form.reason)
  if (action.required.includes('supplierRef') || value(form.supplierRef)) { if (value(form.supplierRef)) request.supplierRef = value(form.supplierRef) }
  if (action.required.includes('hotelConfirmationNo') || value(form.hotelConfirmationNo)) { if (value(form.hotelConfirmationNo)) request.hotelConfirmationNo = value(form.hotelConfirmationNo) }
  if (value(form.supplierCancellationRef)) request.supplierCancellationRef = value(form.supplierCancellationRef)
  if (action.needsSecondConfirmation) request.confirmNonRefundable = true
  return { request }
}

/** Fields an action may collect, beyond the required ones (optional ones are shown but not demanded). */
export function visibleFields(action: BookingAvailableAction): BookingActionField[] {
  const fields = new Set<BookingActionField>(action.required)
  if (action.action === 'recordConfirmed') fields.add('hotelConfirmationNo')
  if (action.action === 'approveAmendment') fields.add('reason')
  if (action.action === 'recordOnRequest') fields.add('reason')
  return (['supplierRef', 'hotelConfirmationNo', 'supplierCancellationRef', 'reason'] as const).filter((f) => fields.has(f))
}
export const isOptional = (action: BookingAvailableAction, field: BookingActionField) => !action.required.includes(field)

export const MAX_LENGTH: Record<BookingActionField, number> = { reason: BOOKING_REASON_MAX, supplierRef: BOOKING_REF_MAX, hotelConfirmationNo: BOOKING_REF_MAX, supplierCancellationRef: BOOKING_REF_MAX, confirmNonRefundable: 0 }

const COPY: Record<string, string> = {
  STALE_STATUS: 'This booking changed while you were working. Close this and reload to see its current status.',
  ILLEGAL_TRANSITION: 'That move is not allowed from the booking’s current status.',
  BOOKING_CLOSED: 'This booking is closed and locked for edits.',
  MISSING_FIELDS: 'Some required fields are missing.',
  CONFIRMATION_REQUIRED: 'This booking is not known to be refundable. Tick the second confirmation to continue.',
  NO_SHOW_WINDOW: 'A no-show can only be marked within 7 days of check-in.',
  IDEMPOTENCY_CONFLICT: 'This request was already used with different details. Close the dialog and start again.',
  PERMISSION_DENIED: 'You do not have permission to do this on this booking.',
  FORBIDDEN: 'You do not have permission to do this.',
  BOOKING_NOT_FOUND: 'This booking could not be found.',
  NOT_FOUND: 'This booking could not be found.',
  FIELD_TOO_LONG: 'One of the fields is too long.',
  NO_CHANGE: 'Nothing changed: those references are already recorded.',
  MANUAL_BOOKING_DISABLED: 'Manual booking entry is switched off in this environment.',
  HOTEL_NOT_FOUND: 'That hotel was not found for this operator.',
  AGENCY_NOT_FOUND: 'That agency was not found for this operator.',
  AGENCY_NOT_ACTIVE: 'New bookings are blocked for an agency that is not active.',
  CURRENCY_NOT_ENABLED: 'That currency is not enabled for this deployment.',
  OPERATIONS_READ_DENIED: 'The booking service is not available to this environment right now. Nothing was changed.',
  SUPPLIER_NOT_CONFIGURED: 'No supplier connection is set up for this booking’s supplier, so nothing can be sent. Record the supplier’s answer by hand instead.',
  SUPPLIER_JOB_ACTIVE: 'A supplier job is already queued or running for this booking.',
  SUPPLIER_OUTCOME_UNKNOWN: 'The supplier’s answer is not known. Sync with the supplier first: sending again could create a duplicate booking.',
  ILLEGAL_SUPPLIER_OPERATION: 'That supplier operation is not available for this booking now.',
  SUPPLIER_JOBS_DISABLED: 'The supplier queue is switched off in this environment.',
  NETWORK_ERROR: 'The server could not be reached. Nothing was confirmed; you can retry safely, the same request will not be applied twice.',
  API_TIMEOUT: 'The server did not answer in time. The change may or may not have been applied: reload the booking before trying again. Retrying this dialog is safe.',
}
/** Plain words for an API failure, plus the server's own message for validation errors, and the request id for support. */
export function describeActionError(error: unknown): { message: string; requestId: string | null; reload: boolean } {
  if (!(error instanceof ApiResponseError)) return { message: 'Something went wrong. Nothing was confirmed.', requestId: null, reload: false }
  const base = COPY[error.code] ?? (error.status >= 500 ? 'The server could not complete the request. Nothing was confirmed.' : error.message || 'The request was refused.')
  const detail = error.code === 'MISSING_FIELDS' || error.code === 'VALIDATION_ERROR' || error.code === 'INVALID_MANUAL_BOOKING' ? ` ${error.message}` : ''
  return { message: `${base}${detail}`.trim(), requestId: error.requestId, reload: error.code === 'STALE_STATUS' || error.code === 'ILLEGAL_TRANSITION' || error.code === 'BOOKING_CLOSED' || error.code === 'API_TIMEOUT' }
}

// ---- manual entry ------------------------------------------------------------------------------------------------------
export interface ManualRoomForm { roomName: string; boardCode: string; adults: string; children: string; childAges: string }
export interface ManualGuestForm { title: string; firstName: string; lastName: string; isLead: boolean }
export interface ManualForm {
  sendToSupplier: boolean
  agencyId: string; hotelId: string; supplier: string; checkIn: string; checkOut: string; currency: string; sell: string; net: string
  paymentMode: '' | 'CREDIT' | 'PREPAID' | 'PAY_AT_HOTEL'; refundable: '' | 'yes' | 'no'; cancelDeadline: string; agentRef: string
  rooms: ManualRoomForm[]; guests: ManualGuestForm[]
}
export const emptyManualForm = (currency = 'AED'): ManualForm => ({
  sendToSupplier: false, agencyId: '', hotelId: '', supplier: '', checkIn: '', checkOut: '', currency, sell: '', net: '', paymentMode: '', refundable: '', cancelDeadline: '', agentRef: '',
  rooms: [{ roomName: '', boardCode: '', adults: '2', children: '0', childAges: '' }], guests: [{ title: '', firstName: '', lastName: '', isLead: true }],
})

const wholeNumber = (v: string): number | null => (/^\d{1,2}$/.test(v.trim()) ? Number(v.trim()) : null)

/** Converts the form to the API request using integer minor units only, or returns field-keyed errors. The API validates again. */
export function buildManualRequest(form: ManualForm): { request: ManualBookingRequest } | { errors: Record<string, string> } {
  const errors: Record<string, string> = {}
  const need = (key: string, value: string, label: string) => { if (!value.trim()) errors[key] = `${label} is required` }
  need('agencyId', form.agencyId, 'Agency'); need('hotelId', form.hotelId, 'Hotel'); need('supplier', form.supplier, 'Supplier'); need('checkIn', form.checkIn, 'Check-in'); need('checkOut', form.checkOut, 'Check-out')
  if (form.checkIn && form.checkOut && form.checkOut <= form.checkIn) errors.checkOut = 'Check-out must be after check-in'
  const sellMinor = parseMajorToMinor(form.sell, form.currency)
  if (sellMinor === null || BigInt(sellMinor) <= 0n) errors.sell = 'Enter the sell amount as a plain number with at most the currency’s decimals'
  let netMinor: string | undefined
  if (form.net.trim()) { const n = parseMajorToMinor(form.net, form.currency); if (n === null) errors.net = 'Enter the net amount as a plain number'; else netMinor = n }
  const rooms = form.rooms.map((r, i) => {
    const adults = wholeNumber(r.adults); const children = wholeNumber(r.children || '0')
    const ages = r.childAges.split(',').map((a) => a.trim()).filter(Boolean).map((a) => wholeNumber(a))
    if (!r.roomName.trim()) errors[`rooms.${i}.roomName`] = 'Room name is required'
    if (adults === null || adults < 1) errors[`rooms.${i}.adults`] = 'Adults: 1 to 9'
    if (children === null) errors[`rooms.${i}.children`] = 'Children: a whole number'
    else if (ages.length !== children || ages.some((a) => a === null || a > 17)) errors[`rooms.${i}.childAges`] = 'Enter one age (0 to 17) per child, separated by commas'
    return { roomName: r.roomName.trim(), ...(r.boardCode.trim() ? { boardCode: r.boardCode.trim() } : {}), adults: adults ?? 0, children: children ?? 0, childAges: ages.filter((a): a is number => a !== null) }
  })
  const guests = form.guests.map((g, i) => {
    if (!g.firstName.trim()) errors[`guests.${i}.firstName`] = 'First name is required'
    if (!g.lastName.trim()) errors[`guests.${i}.lastName`] = 'Last name is required'
    return { ...(g.title.trim() ? { title: g.title.trim() } : {}), firstName: g.firstName.trim(), lastName: g.lastName.trim(), isLead: g.isLead }
  })
  if (guests.filter((g) => g.isLead).length !== 1) errors.guests = 'Choose exactly one lead guest'
  if (Object.keys(errors).length) return { errors }
  const request: ManualBookingRequest = {
    agencyId: form.agencyId, hotelId: form.hotelId, supplier: form.supplier.trim(), checkIn: form.checkIn, checkOut: form.checkOut, currency: form.currency, sellMinor: sellMinor as string, rooms, guests,
    ...(form.sendToSupplier ? { sendToSupplier: true } : {}), ...(netMinor ? { netMinor } : {}), ...(form.paymentMode ? { paymentMode: form.paymentMode } : {}), ...(form.refundable ? { isRefundable: form.refundable === 'yes' } : {}),
    ...(form.cancelDeadline ? { cancelDeadline: new Date(form.cancelDeadline).toISOString() } : {}), ...(form.agentRef.trim() ? { agentRef: form.agentRef.trim() } : {}),
  }
  return { request }
}
