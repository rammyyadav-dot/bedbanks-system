import type { BookingPaymentMode, Prisma } from '@prisma/client'
import { effectivePenalty, type BookingAction, type BookingFinanceEventType, type PenaltyFact, type StoredPenaltyQuote } from '@bedbanks/contracts'

/**
 * Money facts of an Admin booking transition (ADR 0039, Phase 5). Called by `transitionBooking` in the same transaction, only when the caller is an
 * Admin-originated path (`emitFinance`): Agent-flow bookings already post to the wallet ledger, and counting them here too would double-count.
 * It writes `BookingFinanceEvent` rows (integer minor units) and nothing else: no ledger entry, wallet or balance is read or changed here.
 */
const CONFIRMING: ReadonlySet<BookingAction> = new Set(['recordConfirmed', 'confirmOnRequest', 'systemConfirm', 'systemConfirmOnRequest'])
const HOLDING: ReadonlySet<BookingAction> = new Set(['recordOnRequest', 'systemOnRequest'])
const RELEASING: ReadonlySet<BookingAction> = new Set(['rejectOnRequest', 'systemRejectOnRequest', 'recordFailed', 'systemFail'])
const REQUESTING_CANCEL: ReadonlySet<BookingAction> = new Set(['requestCancellation', 'systemRequestCancellation'])
const COMPLETING_CANCEL: ReadonlySet<BookingAction> = new Set(['confirmCancellation', 'systemCompleteCancellation'])

export interface FinanceBooking { id: string; tenantId: string; currency: string; totalMinor: bigint; netMinor: bigint | null; paymentMode: string | null }

export const isRequestingCancellation = (action: BookingAction) => REQUESTING_CANCEL.has(action)

/** Reads the penalty quote that was stored on the request that started this cancellation, and the decisions recorded since. */
export async function currentPenalty(tx: Prisma.TransactionClient, booking: FinanceBooking, requested: boolean) {
  const [request, events] = await Promise.all([
    tx.bookingEvent.findFirst({ where: { tenantId: booking.tenantId, bookingId: booking.id, toStatus: 'CANCEL_REQUESTED', action: { in: ['requestCancellation', 'systemRequestCancellation'] } }, orderBy: { createdAt: 'desc' }, select: { payload: true } }),
    tx.bookingFinanceEvent.findMany({ where: { tenantId: booking.tenantId, bookingId: booking.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { type: true, penaltyMinor: true, createdAt: true } }),
  ])
  const quote = ((request?.payload as { penaltyQuote?: StoredPenaltyQuote } | null)?.penaltyQuote ?? null)
  const facts: PenaltyFact[] = events.map((e) => ({ type: e.type as BookingFinanceEventType, penaltyMinor: e.penaltyMinor === null ? null : e.penaltyMinor.toString(), createdAt: e.createdAt.toISOString() }))
  return { quote, facts, penalty: effectivePenalty({ sellMinor: booking.totalMinor.toString(), requested, quote, facts }) }
}

async function nextSeq(tx: Prisma.TransactionClient, booking: FinanceBooking, type: BookingFinanceEventType): Promise<number> {
  const last = await tx.bookingFinanceEvent.aggregate({ where: { tenantId: booking.tenantId, bookingId: booking.id, type }, _max: { seq: true } })
  return (last._max.seq ?? 0) + 1
}

export async function emitTransitionFinance(tx: Prisma.TransactionClient, booking: FinanceBooking, action: BookingAction, actorUserId: string | null): Promise<void> {
  const base = { tenantId: booking.tenantId, bookingId: booking.id, currency: booking.currency, sellMinor: booking.totalMinor, netMinor: booking.netMinor, actorUserId }
  const paymentMode = (booking.paymentMode ?? null) as BookingPaymentMode | null
  const write = async (type: BookingFinanceEventType, extra: { penaltyMinor?: bigint | null; refundMinor?: bigint | null; payload?: Prisma.InputJsonObject } = {}) =>
    tx.bookingFinanceEvent.create({ data: { ...base, type, seq: await nextSeq(tx, booking, type), paymentMode, penaltyMinor: extra.penaltyMinor ?? null, refundMinor: extra.refundMinor ?? null, payload: extra.payload ?? {} }, select: { id: true } })

  if (CONFIRMING.has(action)) { await write('CONFIRMED', { payload: { action } }); return }
  if (HOLDING.has(action)) { await write('ON_REQUEST_HOLD', { payload: { action } }); return }
  if (RELEASING.has(action)) {
    const held = await tx.bookingFinanceEvent.count({ where: { tenantId: booking.tenantId, bookingId: booking.id, type: 'ON_REQUEST_HOLD' } })
    const released = await tx.bookingFinanceEvent.count({ where: { tenantId: booking.tenantId, bookingId: booking.id, type: 'HOLD_RELEASED' } })
    // A hold is released once, and only if one was recorded: a plain failure with no hold moves no money.
    if (held > released) await write('HOLD_RELEASED', { payload: { action } })
    return
  }
  if (COMPLETING_CANCEL.has(action)) {
    const { penalty } = await currentPenalty(tx, booking, true)
    const determined = penalty.state === 'QUOTED' || penalty.state === 'DECIDED' || penalty.state === 'WAIVED'
    // An undetermined penalty is recorded as unknown (null), never as zero: a person must decide before any credit note exists.
    await write('CANCELLED', determined
      ? { penaltyMinor: BigInt(penalty.penaltyMinor), refundMinor: BigInt(penalty.refundMinor), payload: { action, penaltyState: penalty.state } }
      : { payload: { action, penaltyState: 'NEEDS_DECISION' } })
  }
}
