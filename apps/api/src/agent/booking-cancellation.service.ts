import { rulesForPlan } from '../supply/cancellation-rules'
import { freezeCancellationTerms } from './booking-cancellation-terms'
import { buildPenaltyQuote, frozenTimeZone } from '../booking-ops/booking-penalty-quote'
import { refundKey } from '../booking-finance-posting/posting-plan'
import { transitionBooking } from '../booking-ops/booking-transition'
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { BookingTransactionDatabase, type BookingTransactionClient } from './booking-transaction.database'
import { appendLedgerEntry, referenceSumMinor } from '../ledger/ledger-core'
import { moveNight } from '../inventory/inventory-counters'
import { AgentAuditService } from './audit.service'
import { CancellationPolicyService, penaltyStartsAt } from './cancellation-policy.service'
import { LedgerService } from './ledger.service'
import { agencyConstraint, lockBookingSql, resolveAgentBookingScope } from './booking-agency-scope'

export interface CancellationCommand { tenantId: string; userId: string; requestId: string; bookingId: string; reason?: string; now?: Date }
export type CancellationQuoteView = { bookingId: string; currency: string; totalMinor: string; penaltyMinor: string; refundMinor: string; additionalRefundMinor?: string; checkIn: string; evaluatedAt: string }
export type CancellationResult = CancellationQuoteView & { status: 'CANCELLED'; alreadyCancelled: boolean; cancellationId: string }

/**
 * Cancels a CONFIRMED contracted-inventory booking in ONE transaction: contract cancellation policy -> integer
 * penalty/refund, sold inventory returned, refund posted to the ledger, booking CANCELLED, audit. Fails closed
 * (409, nothing changed) when the policy is missing, ambiguous or cannot be evaluated, or the stay has started.
 * The penalty is simply the part of the original DEBIT that is not refunded.
 */
@Injectable()
export class BookingCancellationService {
  constructor(
    @Inject(BookingTransactionDatabase) private readonly prisma: BookingTransactionClient,
    private readonly policy: CancellationPolicyService,
    private readonly ledger: LedgerService,
    private readonly audit: AgentAuditService,
  ) {}

  async quote(command: Omit<CancellationCommand, 'reason'>): Promise<CancellationQuoteView> {
    return this.prisma.withTenant(command.tenantId, async tx => {
      const scope = await resolveAgentBookingScope(tx, command.tenantId, command.userId)
      const booking = await tx.booking.findFirst({ where: { ...agencyConstraint(scope), id: command.bookingId, tenantId: command.tenantId } })
      if (!booking) throw new NotFoundException('Booking not found')
      if (booking.status !== 'CONFIRMED') throw new ConflictException('Booking is not cancellable')
      const { view, refund } = await this.evaluate(tx, command.tenantId, booking, command.now ?? new Date())
      const { additional } = await this.refundDetails(tx, command.tenantId, booking, refund, false)
      return { ...view, additionalRefundMinor: additional.toString() }
    })
  }

  async cancel(command: CancellationCommand): Promise<CancellationResult> {
    const { tenantId, userId, requestId, bookingId } = command
    try {
      return await this.prisma.withTenant(tenantId, async tx => {
        const scope = await resolveAgentBookingScope(tx, tenantId, userId)
        const locked = await tx.$queryRaw<Array<{ id: string }>>(lockBookingSql(tenantId, bookingId, scope))
        if (locked.length !== 1) throw new NotFoundException('Booking not found')
        const booking = await tx.booking.findFirstOrThrow({ where: { ...agencyConstraint(scope), id: bookingId, tenantId } })
        if (booking.status === 'CANCELLED') {
          const done = await tx.cancellation.findUniqueOrThrow({ where: { bookingId } })
          const refund = done.refundMinor ?? 0n
          return { bookingId, currency: booking.currency, totalMinor: booking.totalMinor.toString(), penaltyMinor: (booking.totalMinor - refund).toString(), refundMinor: refund.toString(),
            checkIn: String((booking.searchSnapshot as { checkIn?: unknown }).checkIn), evaluatedAt: done.createdAt.toISOString(), status: 'CANCELLED' as const, alreadyCancelled: true, cancellationId: done.id }
        }
        if (booking.status !== 'CONFIRMED') throw new ConflictException('Booking is not cancellable')

        const { view, holdId, penalty, refund } = await this.evaluate(tx, tenantId, booking, command.now ?? new Date())
        const { walletId, reference, posted, additional } = await this.refundDetails(tx, tenantId, booking, refund, true)

        const nights = await tx.inventoryHoldNight.findMany({ where: { holdId, tenantId } })
        if (nights.length === 0) throw new ConflictException('Booking has no inventory record')
        for (const night of nights) await moveNight(tx, tenantId, night, 'cancel')
        await tx.inventoryHold.update({ where: { id: holdId, tenantId }, data: { status: 'RELEASED', releasedAt: new Date() } })
        if (additional > 0n) {
          await appendLedgerEntry(tx, { tenantId, walletId, type: 'REFUND', amountMinor: additional, currency: booking.currency, reference, idempotencyKey: refundKey(bookingId, refund, posted) })
        }
        const cancellation = await tx.cancellation.create({ data: { bookingId, reason: command.reason?.slice(0, 500) ?? null, refundMinor: refund } })
        // Through the one writer of Booking.status (ADR 0039): start, then complete, as two recorded moves in the same transaction.
        const move = { tenantId, bookingId, actor: { type: 'USER' as const, id: userId }, level: 'SYSTEM' as const, now: new Date() }
        await transitionBooking(tx, { ...move, action: 'systemRequestCancellation', expectedStatus: 'CONFIRMED', idempotencyKey: `cancel:${bookingId}:request` })
        await transitionBooking(tx, { ...move, action: 'systemCompleteCancellation', expectedStatus: 'CANCEL_REQUESTED', idempotencyKey: `cancel:${bookingId}:complete` })
        await tx.auditEvent.create({ data: { tenantId, userId, actorType: 'USER', action: 'booking.cancelled', entityType: 'booking', entityId: bookingId,
          payload: { requestId, cancellationId: cancellation.id, currency: booking.currency, totalMinor: booking.totalMinor.toString(), penaltyMinor: penalty.toString(), refundMinor: refund.toString(), walletId, postedMinor: additional.toString() } } })
        return { ...view, additionalRefundMinor: additional.toString(), status: 'CANCELLED' as const, alreadyCancelled: false, cancellationId: cancellation.id }
      })
    } catch (error) {
      if (error instanceof ConflictException || error instanceof NotFoundException) {
        await this.audit.record({ tenantId, userId, action: 'booking.cancel.refused', entityType: 'booking', entityId: bookingId, payload: { requestId, reason: error.message } }).catch(() => undefined)
      }
      throw error
    }
  }

  private async refundDetails(tx: Prisma.TransactionClient, tenantId: string, booking: { id: string; currency: string; totalMinor: bigint }, target: bigint, lockWallet: boolean) {
    const debit = await tx.ledgerEntry.findFirst({ where: { tenantId, idempotencyKey: `booking:${booking.id}:authorize:settle-debit`, type: 'DEBIT' } })
    if (!debit || -debit.amountMinor !== booking.totalMinor || debit.currency !== booking.currency) throw new ConflictException('Booking was never charged')
    if (lockWallet) {
      const walletRows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "Wallet" WHERE "id" = ${debit.walletId} AND "tenant_id" = ${tenantId} FOR UPDATE`)
      if (walletRows.length !== 1) throw new ConflictException('Wallet is unavailable')
    }
    const reference = `booking:${booking.id}`
    const posted = await referenceSumMinor(tx, tenantId, debit.walletId, reference, 'REFUND')
    if (posted > target) throw new ConflictException('Cancellation requires Finance review: previous credits exceed the policy refund')
    const additional = target - posted
    this.ledger.assertRefundWithinAuthorized({ refundMinor: additional, authorizedRefundableMinor: -debit.amountMinor - posted })
    return { walletId: debit.walletId, reference, posted, additional }
  }

  private async evaluate(tx: Prisma.TransactionClient, tenantId: string, booking: {
    id: string; hotelId: string; currency: string; totalMinor: bigint; isRefundable: boolean | null
    searchSnapshot: Prisma.JsonValue; cancellationPolicy: Prisma.JsonValue | null
  }, now: Date) {
    const snapshot = booking.searchSnapshot as { checkIn?: string; checkOut?: string; inventoryHoldId?: string; ratePlanId?: string }
    if (!snapshot.checkIn || !snapshot.inventoryHoldId || !snapshot.ratePlanId) throw new ConflictException('Booking snapshot is incomplete')

    let terms: unknown = booking.cancellationPolicy
    const { isRefundable } = booking
    // Only pre-snapshot Agent bookings retain the legacy contract lookup.
    if (terms === null && isRefundable === true) {
      const plan = await tx.ratePlan.findFirst({ where: { id: snapshot.ratePlanId, tenantId }, include: { contract: { include: { cancellationPolicies: true } } } })
      if (!plan) throw new ConflictException('Rate plan is unavailable')
      const resolved = rulesForPlan(plan, plan.contract.cancellationPolicies)
      if (!resolved.missing) {
        terms = freezeCancellationTerms(resolved.rules.filter((rule) => rule.kind !== 'NO_SHOW'), booking.currency, resolved.set, now, {
          bufferDays: plan.contract.clientBufferDays,
          stayNights: 0,
        })
      }
    }
    const legacyZone = (terms as { timeZone?: unknown } | null)?.timeZone === undefined
      ? (await tx.hotel.findFirst({ where: { id: booking.hotelId, tenantId }, select: { timeZone: true } }))?.timeZone ?? ''
      : ''
    const timeZone = frozenTimeZone(terms, legacyZone)
    const quote = buildPenaltyQuote({ sellMinor: booking.totalMinor, currency: booking.currency, isRefundable, checkIn: snapshot.checkIn, checkOut: snapshot.checkOut, rules: terms, requestedAt: now, timeZone }, this.policy)
    if (quote.status !== 'quotable') {
      let detail = quote.detail
      if (quote.reason === 'policy_unavailable') {
        const tiers = (terms as { rules?: unknown[] } | null)?.rules
        if (Array.isArray(tiers) && tiers.length === 0) detail = 'missing_cancellation_policy'
        else if (booking.cancellationPolicy !== null) detail = 'the frozen cancellation terms are unreadable'
      }
      throw new ConflictException(`Cancellation requires manual review: ${detail}`)
    }
    const starts = penaltyStartsAt(snapshot.checkIn, 0, timeZone)
    if (starts === undefined) throw new ConflictException('Cancellation requires manual review: invalid stay date or hotel time zone')
    if (now.getTime() >= starts) throw new ConflictException('Stay has already started')

    return {
      holdId: snapshot.inventoryHoldId, penalty: BigInt(quote.penaltyMinor), refund: BigInt(quote.refundMinor),
      view: { bookingId: booking.id, currency: quote.currency, totalMinor: quote.sellMinor, penaltyMinor: quote.penaltyMinor, refundMinor: quote.refundMinor, checkIn: snapshot.checkIn, evaluatedAt: quote.evaluatedAt },
    }
  }
}
