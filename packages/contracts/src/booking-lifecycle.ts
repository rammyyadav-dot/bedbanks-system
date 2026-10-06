/**
 * The Admin booking lifecycle (ADR 0039, Phase 2): the ten statuses, the one table of legal moves, and the named actions that perform them.
 * Pure data and pure functions, shared by the API (which enforces it) and the Admin (which only shows what the API would accept).
 *
 * The API is the authority: a status is changed only by `transitionBooking`, through one of the actions below, never by a generic "set status".
 * "Closed" is not a status: it is a `closedAt` lock (spec decision 2), applied to the five terminal statuses.
 */
import type { BookingStatus } from './operations'

/** The spec's transition table. `(new)` is Pending supplier. Closed is the lock, not a move. */
export const BOOKING_TRANSITIONS: Readonly<Record<BookingStatus, readonly BookingStatus[]>> = {
  PENDING_SUPPLIER: ['CONFIRMED', 'ON_REQUEST', 'FAILED'],
  ON_REQUEST: ['CONFIRMED', 'REJECTED'],
  CONFIRMED: ['AMEND_REQUESTED', 'CANCEL_REQUESTED', 'CHECKED_OUT'],
  AMEND_REQUESTED: ['CONFIRMED'],
  CANCEL_REQUESTED: ['CANCELLED'],
  CHECKED_OUT: ['NO_SHOW'],
  NO_SHOW: [],
  CANCELLED: [],
  REJECTED: [],
  FAILED: [],
}
/** Statuses that can be locked with `closedAt` (after the dispute window). Nothing else may be closed. */
export const BOOKING_CLOSABLE_STATUSES = ['CHECKED_OUT', 'NO_SHOW', 'CANCELLED', 'REJECTED', 'FAILED'] as const satisfies readonly BookingStatus[]
/** The hotel may report a no-show within this many days of check-in (spec workflow G). */
export const NO_SHOW_WINDOW_DAYS = 7

export const BOOKING_ACTIONS = [
  'recordConfirmed', 'recordOnRequest', 'recordFailed',
  'confirmOnRequest', 'rejectOnRequest',
  'requestAmendment', 'approveAmendment', 'rejectAmendment',
  'requestCancellation', 'confirmCancellation',
  'markNoShow', 'markCheckedOut', 'close',
] as const
export type BookingAction = (typeof BOOKING_ACTIONS)[number]

export type BookingActionField = 'reason' | 'supplierRef' | 'hotelConfirmationNo' | 'supplierCancellationRef' | 'confirmNonRefundable'
export type BookingActorKind = 'OPERATOR' | 'AGENCY' | 'SYSTEM'

export interface BookingActionRule {
  action: BookingAction
  label: string
  from: BookingStatus
  /** The status the move ends in. `close` keeps the status and sets the lock. */
  to: BookingStatus
  /** Held by any one of these formal permissions. */
  permissions: readonly string[]
  /** Fields the request must carry (non-empty). */
  required: readonly BookingActionField[]
  /** Who may perform it: operator-level callers, agency-scoped callers (their own agency only) or the system (nightly job). */
  actors: readonly BookingActorKind[]
  /** Needs an explicit second confirmation when the booking is not (known to be) refundable. */
  secondConfirmationWhenNonRefundable?: true
  /** Bumps `Booking.version` (an approved amendment). */
  bumpsVersion?: true
  /** One-line plain-language effect, shown in the dialog. */
  effect: string
}

const R = (rule: BookingActionRule): BookingActionRule => rule
export const BOOKING_ACTION_RULES: Readonly<Record<BookingAction, BookingActionRule>> = {
  recordConfirmed: R({ action: 'recordConfirmed', label: 'Record supplier confirmation', from: 'PENDING_SUPPLIER', to: 'CONFIRMED', permissions: ['booking.confirm.manual'], required: ['supplierRef'], actors: ['OPERATOR'], effect: 'Marks the booking Confirmed with the supplier reference you enter. No supplier call is made and no credit is consumed in this phase.' }),
  recordOnRequest: R({ action: 'recordOnRequest', label: 'Record "on request"', from: 'PENDING_SUPPLIER', to: 'ON_REQUEST', permissions: ['booking.confirm.manual'], required: [], actors: ['OPERATOR'], effect: 'The supplier answered "on request": the booking joins the ops queue.' }),
  recordFailed: R({ action: 'recordFailed', label: 'Record failure', from: 'PENDING_SUPPLIER', to: 'FAILED', permissions: ['booking.confirm.manual'], required: ['reason'], actors: ['OPERATOR'], effect: 'The supplier could not book it. A failed booking is never revived: rebooking creates a new booking.' }),
  confirmOnRequest: R({ action: 'confirmOnRequest', label: 'Confirm', from: 'ON_REQUEST', to: 'CONFIRMED', permissions: ['booking.on-request.resolve'], required: ['supplierRef', 'hotelConfirmationNo'], actors: ['OPERATOR'], effect: 'The supplier or hotel confirmed. Both references are mandatory.' }),
  rejectOnRequest: R({ action: 'rejectOnRequest', label: 'Reject', from: 'ON_REQUEST', to: 'REJECTED', permissions: ['booking.on-request.resolve'], required: ['reason'], actors: ['OPERATOR'], effect: 'The supplier or hotel declined. A reason is mandatory.' }),
  requestAmendment: R({ action: 'requestAmendment', label: 'Request amendment', from: 'CONFIRMED', to: 'AMEND_REQUESTED', permissions: ['booking.amend', 'booking.amend.request'], required: ['reason'], actors: ['OPERATOR', 'AGENCY'], effect: 'Describe the change (names, dates, room, occupancy, requests). Do not put guest personal details in this note.' }),
  approveAmendment: R({ action: 'approveAmendment', label: 'Approve amendment', from: 'AMEND_REQUESTED', to: 'CONFIRMED', permissions: ['booking.amend'], required: [], actors: ['OPERATOR'], bumpsVersion: true, effect: 'The booking returns to Confirmed and its version goes up by one. Applying the change to the booking data arrives with supplier integration.' }),
  rejectAmendment: R({ action: 'rejectAmendment', label: 'Reject amendment', from: 'AMEND_REQUESTED', to: 'CONFIRMED', permissions: ['booking.amend'], required: ['reason'], actors: ['OPERATOR'], effect: 'The booking returns to Confirmed exactly as it was.' }),
  requestCancellation: R({ action: 'requestCancellation', label: 'Request cancellation', from: 'CONFIRMED', to: 'CANCEL_REQUESTED', permissions: ['booking.cancel', 'booking.cancel.nonrefundable', 'booking.cancel.request'], required: ['reason'], actors: ['OPERATOR', 'AGENCY'], secondConfirmationWhenNonRefundable: true, effect: 'Starts a cancellation. The penalty is not stored on bookings yet, so it is not shown; check the cancellation policy before confirming.' }),
  confirmCancellation: R({ action: 'confirmCancellation', label: 'Record cancellation', from: 'CANCEL_REQUESTED', to: 'CANCELLED', permissions: ['booking.cancel', 'booking.cancel.nonrefundable'], required: ['supplierCancellationRef'], actors: ['OPERATOR'], secondConfirmationWhenNonRefundable: true, effect: 'The supplier cancelled; enter its cancellation reference. No money moves in this phase.' }),
  markNoShow: R({ action: 'markNoShow', label: 'Mark no-show', from: 'CHECKED_OUT', to: 'NO_SHOW', permissions: ['booking.no-show.mark'], required: ['reason'], actors: ['OPERATOR'], effect: `The hotel reported a no-show, within ${NO_SHOW_WINDOW_DAYS} days of check-in. No penalty is applied in this phase.` }),
  markCheckedOut: R({ action: 'markCheckedOut', label: 'Check out', from: 'CONFIRMED', to: 'CHECKED_OUT', permissions: [], required: [], actors: ['SYSTEM'], effect: 'Done by the nightly job the day after check-out.' }),
  close: R({ action: 'close', label: 'Close as failed', from: 'FAILED', to: 'FAILED', permissions: ['booking.rebook'], required: ['reason'], actors: ['OPERATOR'], effect: 'Locks the failed booking for edits. Its failure stays visible for reporting.' }),
}

/** Every rule must be a legal move in the table (or the lock). Checked by a test, so the two cannot drift. */
export function isLegalMove(from: BookingStatus, to: BookingStatus): boolean { return BOOKING_TRANSITIONS[from].includes(to) }

export interface BookingActionFacts {
  status: BookingStatus
  closedAt: string | null
  isRefundable: boolean | null
  /** `YYYY-MM-DD`, or null when the stay dates are unknown. */
  checkIn: string | null
}

export type ActionBlock = 'WRONG_STATUS' | 'CLOSED' | 'NO_SHOW_WINDOW' | 'NO_STAY_DATES' | 'SYSTEM_ONLY' | 'NOT_PERMITTED' | 'NOT_CLOSABLE'

/** Status, lock and window rules only. Permission is checked by the caller with the caller's keys (see `permissionFor`). */
export function actionBlock(rule: BookingActionRule, facts: BookingActionFacts, now: Date): ActionBlock | null {
  if (facts.closedAt) return 'CLOSED'
  if (facts.status !== rule.from) return 'WRONG_STATUS'
  if (rule.action === 'close' && !(BOOKING_CLOSABLE_STATUSES as readonly string[]).includes(facts.status)) return 'NOT_CLOSABLE'
  if (rule.action === 'markNoShow') {
    if (!facts.checkIn) return 'NO_STAY_DATES'
    const limit = Date.parse(`${facts.checkIn}T00:00:00Z`) + (NO_SHOW_WINDOW_DAYS + 1) * 86_400_000 // inclusive of the seventh day
    if (now.getTime() >= limit) return 'NO_SHOW_WINDOW'
  }
  return null
}

/**
 * The permission that authorises this action for this booking, or null if the caller holds none. A non-refundable (or unknown-refundability)
 * booking needs `booking.cancel.nonrefundable` to be cancelled by an operator; an agency user can only request, and always needs the second confirmation.
 */
export function permissionFor(rule: BookingActionRule, level: 'OPERATOR' | 'AGENCY', held: ReadonlySet<string>, isRefundable: boolean | null): string | null {
  if (!rule.actors.includes(level)) return null
  if (rule.action === 'requestCancellation' || rule.action === 'confirmCancellation') {
    if (level === 'AGENCY') return held.has('booking.cancel.request') && rule.action === 'requestCancellation' ? 'booking.cancel.request' : null
    if (isRefundable === true) return held.has('booking.cancel') ? 'booking.cancel' : held.has('booking.cancel.nonrefundable') ? 'booking.cancel.nonrefundable' : null
    return held.has('booking.cancel.nonrefundable') ? 'booking.cancel.nonrefundable' : null
  }
  if (rule.action === 'requestAmendment' && level === 'AGENCY') return held.has('booking.amend.request') ? 'booking.amend.request' : null
  return rule.permissions.find((key) => held.has(key)) ?? null
}

export interface BookingAvailableAction {
  action: BookingAction
  label: string
  to: BookingStatus
  required: readonly BookingActionField[]
  /** The dialog must ask the user to confirm a non-refundable (or unknown-refundability) cancellation a second time. */
  needsSecondConfirmation: boolean
  effect: string
}

/** The actions this caller may start on this booking right now, in rule order. The same function the API uses, so the screen never offers a refused move. */
export function availableActions(facts: BookingActionFacts, level: 'OPERATOR' | 'AGENCY', held: ReadonlySet<string>, now: Date): BookingAvailableAction[] {
  return BOOKING_ACTIONS.map((a) => BOOKING_ACTION_RULES[a])
    .filter((rule) => !rule.actors.includes('SYSTEM') || rule.actors.length > 1)
    .filter((rule) => actionBlock(rule, facts, now) === null && permissionFor(rule, level, held, facts.isRefundable) !== null)
    .map((rule) => ({ action: rule.action, label: rule.label, to: rule.to, required: rule.required, needsSecondConfirmation: Boolean(rule.secondConfirmationWhenNonRefundable) && (level === 'AGENCY' || facts.isRefundable !== true), effect: rule.effect }))
}

/** Fields of `BookingActionField` a request must still supply. */
export function missingFields(rule: BookingActionRule, input: Partial<Record<BookingActionField, unknown>>): BookingActionField[] {
  return rule.required.filter((field) => field === 'confirmNonRefundable' ? input[field] !== true : typeof input[field] !== 'string' || (input[field] as string).trim().length === 0)
}
