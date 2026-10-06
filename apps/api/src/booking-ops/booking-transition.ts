import { BadRequestException, ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common'
import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import {
  actionBlock, BOOKING_ACTION_RULES, BOOKING_REASON_MAX, BOOKING_REF_MAX, missingFields,
  type BookingAction, type BookingActionField, type BookingStatus,
  type StoredPenaltyQuote,
} from '@bedbanks/contracts'
import { emitTransitionFinance, isRequestingCancellation } from './booking-finance-events'

/**
 * `transitionBooking`: the ONE writer of `Booking.status` and `Booking.closedAt` (ADR 0039, Phase 2).
 *
 * It runs inside a transaction the caller opened (tenant context already set), applies exactly one named action from the lifecycle table, writes the
 * immutable `BookingEvent` in the same transaction, and is idempotent per (tenant, booking, key). It does not decide who may act: callers (the Admin
 * actions service now; the supplier job runner and nightly job later) resolve permission first. It never reads or logs a guest name.
 *
 * Errors are specific and carry a stable code: ILLEGAL_TRANSITION, BOOKING_CLOSED, STALE_STATUS, MISSING_FIELDS, CONFIRMATION_REQUIRED,
 * NO_SHOW_WINDOW, IDEMPOTENCY_CONFLICT, BOOKING_NOT_FOUND. None of them leaks other tenants' data.
 */
export interface TransitionActor { type: 'USER' | 'SYSTEM' | 'SUPPLIER'; id?: string | null }
export interface TransitionInput {
  tenantId: string
  bookingId: string
  action: BookingAction
  /** The status the caller saw. A different current status is a 409, so two operators never both win. */
  expectedStatus: BookingStatus
  actor: TransitionActor
  level: 'OPERATOR' | 'AGENCY' | 'SYSTEM'
  reason?: string
  supplierRef?: string
  hotelConfirmationNo?: string
  supplierCancellationRef?: string
  confirmNonRefundable?: boolean
  /** The supplier's own word (free text such as CONFIRMED or ON_REQUEST), kept apart from the status. Written with the move. */
  supplierStatus?: string
  /** Admin-originated callers set this so the move also records its money fact (ADR 0039, Phase 5). The Agent flow does not: it already posts to the wallet ledger. */
  emitFinance?: boolean
  /** Penalty worked out by the caller when cancellation is requested; stored on that request's event and fixed from then on. */
  penaltyQuote?: StoredPenaltyQuote
  /** When present the request is replay-safe. */
  idempotencyKey?: string
  now: Date
}
export interface TransitionOutcome { bookingId: string; reference: string; status: BookingStatus; version: number; closed: boolean; replayed: boolean }

const clean = (value: string | undefined) => { const v = value?.trim(); return v ? v : undefined }

export function requestFingerprint(bookingId: string, input: Pick<TransitionInput, 'action' | 'expectedStatus' | 'reason' | 'supplierRef' | 'hotelConfirmationNo' | 'supplierCancellationRef' | 'confirmNonRefundable'>): string {
  const canonical = JSON.stringify([bookingId, input.action, input.expectedStatus, clean(input.reason) ?? null, clean(input.supplierRef) ?? null, clean(input.hotelConfirmationNo) ?? null, clean(input.supplierCancellationRef) ?? null, input.confirmNonRefundable === true])
  return createHash('sha256').update(canonical).digest('hex')
}

function assertBounded(field: string, value: string | undefined, max: number) {
  if (value !== undefined && value.length > max) throw new BadRequestException({ message: `${field} is too long (max ${max} characters)`, code: 'FIELD_TOO_LONG' })
}

export async function transitionBooking(tx: Prisma.TransactionClient, input: TransitionInput): Promise<TransitionOutcome> {
  const rule = BOOKING_ACTION_RULES[input.action]
  if (!rule) throw new BadRequestException({ message: 'Unknown booking action', code: 'UNKNOWN_ACTION' })
  const reason = clean(input.reason); const supplierRef = clean(input.supplierRef); const hotelConfirmationNo = clean(input.hotelConfirmationNo); const supplierCancellationRef = clean(input.supplierCancellationRef)
  assertBounded('reason', reason, BOOKING_REASON_MAX); assertBounded('supplierRef', supplierRef, BOOKING_REF_MAX); assertBounded('hotelConfirmationNo', hotelConfirmationNo, BOOKING_REF_MAX); assertBounded('supplierCancellationRef', supplierCancellationRef, BOOKING_REF_MAX)
  if (input.actor.type === 'USER' && !input.actor.id) throw new BadRequestException({ message: 'A user action needs an actor', code: 'ACTOR_REQUIRED' })
  if (!rule.actors.includes(input.level)) throw new ConflictException({ message: 'This action is not available to this kind of caller', code: 'ILLEGAL_TRANSITION' })

  const booking = await tx.booking.findFirst({ where: { id: input.bookingId, tenantId: input.tenantId }, select: { id: true, reference: true, status: true, version: true, closedAt: true, isRefundable: true, checkIn: true, currency: true, totalMinor: true, netMinor: true, paymentMode: true } })
  if (!booking) throw new NotFoundException({ message: 'Booking not found', code: 'BOOKING_NOT_FOUND' })

  const fingerprint = requestFingerprint(input.bookingId, { ...input, reason, supplierRef, hotelConfirmationNo, supplierCancellationRef })
  if (input.idempotencyKey) {
    const earlier = await tx.bookingEvent.findUnique({ where: { tenantId_bookingId_idempotencyKey: { tenantId: input.tenantId, bookingId: input.bookingId, idempotencyKey: input.idempotencyKey } }, select: { requestFingerprint: true } })
    if (earlier) {
      if (earlier.requestFingerprint !== fingerprint) throw new ConflictException({ message: 'This idempotency key was already used for a different request', code: 'IDEMPOTENCY_CONFLICT' })
      return { bookingId: booking.id, reference: booking.reference, status: booking.status as BookingStatus, version: booking.version, closed: booking.closedAt !== null, replayed: true }
    }
  }

  if (booking.status !== input.expectedStatus) throw new ConflictException({ message: `The booking is now ${booking.status}, not ${input.expectedStatus}. Reload and try again.`, code: 'STALE_STATUS', currentStatus: booking.status })
  const block = actionBlock(rule, { status: booking.status as BookingStatus, closedAt: booking.closedAt?.toISOString() ?? null, isRefundable: booking.isRefundable, checkIn: booking.checkIn?.toISOString().slice(0, 10) ?? null }, input.now)
  if (block === 'CLOSED') throw new ConflictException({ message: 'This booking is closed and locked for edits', code: 'BOOKING_CLOSED' })
  if (block === 'NO_SHOW_WINDOW' || block === 'NO_STAY_DATES') throw new UnprocessableEntityException({ message: block === 'NO_STAY_DATES' ? 'A no-show needs known stay dates' : 'A no-show must be marked within 7 days of check-in', code: 'NO_SHOW_WINDOW' })
  if (block) throw new ConflictException({ message: `${rule.label} is not allowed from ${booking.status}`, code: 'ILLEGAL_TRANSITION', currentStatus: booking.status })

  const missing = missingFields(rule, { reason, supplierRef, hotelConfirmationNo, supplierCancellationRef })
  if (missing.length) throw new UnprocessableEntityException({ message: `Required: ${missing.join(', ')}`, code: 'MISSING_FIELDS', fields: missing as BookingActionField[] })
  const needsSecond = Boolean(rule.secondConfirmationWhenNonRefundable) && (input.level === 'AGENCY' || booking.isRefundable !== true)
  if (needsSecond && input.confirmNonRefundable !== true) throw new UnprocessableEntityException({ message: 'This booking is not known to be refundable. Confirm a second time to continue.', code: 'CONFIRMATION_REQUIRED' })

  const closing = input.action === 'close'
  const data: Prisma.BookingUpdateManyMutationInput = { status: rule.to }
  const writesRefs = input.action === 'recordConfirmed' || input.action === 'confirmOnRequest' || input.action === 'systemConfirm' || input.action === 'systemConfirmOnRequest'
  if (supplierRef !== undefined && writesRefs) data.supplierRef = supplierRef
  if (hotelConfirmationNo !== undefined && writesRefs) data.hotelConfirmationNo = hotelConfirmationNo
  if (input.supplierStatus !== undefined) data.supplierStatus = input.supplierStatus.slice(0, 40)
  if (rule.bumpsVersion) data.version = { increment: 1 }
  if (closing) data.closedAt = input.now
  // Compare-and-set: only the row in the status the caller saw, and not locked, is changed.
  const changed = await tx.booking.updateMany({ where: { id: booking.id, tenantId: input.tenantId, status: rule.from, closedAt: null }, data })
  if (changed.count !== 1) throw new ConflictException({ message: 'The booking changed while you were working. Reload and try again.', code: 'STALE_STATUS' })

  const payload: Record<string, Prisma.InputJsonValue> = {}
  if (supplierCancellationRef) payload.supplierCancellationRef = supplierCancellationRef
  if (supplierRef && data.supplierRef !== undefined) payload.supplierRef = supplierRef
  if (hotelConfirmationNo && data.hotelConfirmationNo !== undefined) payload.hotelConfirmationNo = hotelConfirmationNo
  if (needsSecond) payload.secondConfirmation = true
  if (input.action === 'approveAmendment') payload.amendment = 'approved'
  if (input.action === 'rejectAmendment') payload.amendment = 'rejected'
  if (closing) payload.closed = true
  if (input.emitFinance && input.penaltyQuote && isRequestingCancellation(input.action)) payload.penaltyQuote = input.penaltyQuote as unknown as Prisma.InputJsonObject
  await tx.bookingEvent.create({ data: {
    tenantId: input.tenantId, bookingId: booking.id, fromStatus: rule.from, toStatus: rule.to, actorType: input.actor.type, actorId: input.actor.id ?? null,
    reason: reason ?? null, action: input.action, payload, idempotencyKey: input.idempotencyKey ?? null, requestFingerprint: input.idempotencyKey ? fingerprint : null,
  } })
  if (input.emitFinance) await emitTransitionFinance(tx, { id: booking.id, tenantId: input.tenantId, currency: booking.currency, totalMinor: booking.totalMinor, netMinor: booking.netMinor, paymentMode: booking.paymentMode }, input.action, input.actor.type === 'USER' ? input.actor.id ?? null : null)
  return { bookingId: booking.id, reference: booking.reference, status: rule.to, version: booking.version + (rule.bumpsVersion ? 1 : 0), closed: closing, replayed: false }
}
