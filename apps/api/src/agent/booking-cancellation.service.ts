import { cancellationTiers, rulesForPlan } from '../supply/cancellation-rules'
import { readFrozenTerms } from './booking-cancellation-terms'
import { transitionBooking } from '../booking-ops/booking-transition'
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../database/prisma.service'
import { appendLedgerEntry } from '../ledger/ledger-core'
import { moveNight } from '../inventory/inventory-counters'
import { AgentAuditService } from './audit.service'
import { CancellationPolicyService, buyerRules, penaltyStartsAt, type CancellationRule } from './cancellation-policy.service'
import { LedgerService } from './ledger.service'

export interface CancellationCommand { tenantId: string; userId: string; requestId: string; bookingId: string; reason?: string; now?: Date }
export type CancellationQuoteView = { bookingId: string; currency: string; totalMinor: string; penaltyMinor: string; refundMinor: string; checkIn: string; evaluatedAt: string }
export type CancellationResult = CancellationQuoteView & { status: 'CANCELLED'; alreadyCancelled: boolean; cancellationId: string }

/**
 * Cancels a CONFIRMED contracted-inventory booking in ONE transaction: contract cancellation policy -> integer
 * penalty/refund, sold inventory returned, refund posted to the ledger, booking CANCELLED, audit. Fails closed
 * (409, nothing changed) when the policy is missing, ambiguous or cannot be evaluated, or the stay has started.
 * The penalty is simply the part of the original DEBIT that is not refunded.
 */
const nightsBetween = (checkIn: string, checkOut: string | undefined): number | null => {
  if (!checkOut) return null
  const nights = Math.round((Date.parse(`${checkOut}T00:00:00.000Z`) - Date.parse(`${checkIn}T00:00:00.000Z`)) / 86_400_000)
  return Number.isInteger(nights) && nights > 0 ? nights : null
}

@Injectable()
export class BookingCancellationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: CancellationPolicyService,
    private readonly ledger: LedgerService,
    private readonly audit: AgentAuditService,
  ) {}

  async quote(command: Omit<CancellationCommand, 'reason'>): Promise<CancellationQuoteView> {
    return this.prisma.withTenant(command.tenantId, async tx => {
      const booking = await tx.booking.findFirst({ where: { id: command.bookingId, tenantId: command.tenantId } })
      if (!booking) throw new NotFoundException('Booking not found')
      if (booking.status !== 'CONFIRMED') throw new ConflictException('Booking is not cancellable')
      return (await this.evaluate(tx, command.tenantId, booking, command.now ?? new Date())).view
    })
  }

  async cancel(command: CancellationCommand): Promise<CancellationResult> {
    const { tenantId, userId, requestId, bookingId } = command
    try {
      return await this.prisma.withTenant(tenantId, async tx => {
        const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "Booking" WHERE "id" = ${bookingId} AND "tenant_id" = ${tenantId} FOR UPDATE`)
        if (locked.length !== 1) throw new NotFoundException('Booking not found')
        const booking = await tx.booking.findFirstOrThrow({ where: { id: bookingId, tenantId } })
        if (booking.status === 'CANCELLED') {
          const done = await tx.cancellation.findUniqueOrThrow({ where: { bookingId } })
          const refund = done.refundMinor ?? 0n
          return { bookingId, currency: booking.currency, totalMinor: booking.totalMinor.toString(), penaltyMinor: (booking.totalMinor - refund).toString(), refundMinor: refund.toString(),
            checkIn: String((booking.searchSnapshot as { checkIn?: unknown }).checkIn), evaluatedAt: done.createdAt.toISOString(), status: 'CANCELLED' as const, alreadyCancelled: true, cancellationId: done.id }
        }
        if (booking.status !== 'CONFIRMED') throw new ConflictException('Booking is not cancellable')

        const { view, holdId, penalty, refund } = await this.evaluate(tx, tenantId, booking, command.now ?? new Date())
        this.ledger.assertRefundWithinAuthorized({ refundMinor: refund, authorizedRefundableMinor: booking.totalMinor })
        const debit = await tx.ledgerEntry.findFirst({ where: { tenantId, idempotencyKey: `booking:${bookingId}:authorize:settle-debit`, type: 'DEBIT' } })
        if (!debit || -debit.amountMinor !== booking.totalMinor || debit.currency !== booking.currency) throw new ConflictException('Booking was never charged')
        const walletRows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "Wallet" WHERE "id" = ${debit.walletId} AND "tenant_id" = ${tenantId} FOR UPDATE`)
        if (walletRows.length !== 1) throw new ConflictException('Wallet is unavailable')

        const nights = await tx.inventoryHoldNight.findMany({ where: { holdId, tenantId } })
        if (nights.length === 0) throw new ConflictException('Booking has no inventory record')
        for (const night of nights) await moveNight(tx, tenantId, night, 'cancel')
        await tx.inventoryHold.update({ where: { id: holdId }, data: { status: 'RELEASED', releasedAt: new Date() } })
        if (refund > 0n) {
          await appendLedgerEntry(tx, { tenantId, walletId: debit.walletId, type: 'REFUND', amountMinor: refund, currency: booking.currency, reference: `booking:${bookingId}`, idempotencyKey: `booking:${bookingId}:cancel-refund` })
        }
        const cancellation = await tx.cancellation.create({ data: { bookingId, reason: command.reason?.slice(0, 500) ?? null, refundMinor: refund } })
        // Through the one writer of Booking.status (ADR 0039): start, then complete, as two recorded moves in the same transaction.
        const move = { tenantId, bookingId, actor: { type: 'USER' as const, id: userId }, level: 'SYSTEM' as const, now: new Date() }
        await transitionBooking(tx, { ...move, action: 'systemRequestCancellation', expectedStatus: 'CONFIRMED', idempotencyKey: `cancel:${bookingId}:request` })
        await transitionBooking(tx, { ...move, action: 'systemCompleteCancellation', expectedStatus: 'CANCEL_REQUESTED', idempotencyKey: `cancel:${bookingId}:complete` })
        await tx.auditEvent.create({ data: { tenantId, userId, actorType: 'USER', action: 'booking.cancelled', entityType: 'booking', entityId: bookingId,
          payload: { requestId, cancellationId: cancellation.id, currency: booking.currency, totalMinor: booking.totalMinor.toString(), penaltyMinor: penalty.toString(), refundMinor: refund.toString(), walletId: debit.walletId } } })
        return { ...view, status: 'CANCELLED' as const, alreadyCancelled: false, cancellationId: cancellation.id }
      })
    } catch (error) {
      if (error instanceof ConflictException || error instanceof NotFoundException) {
        await this.audit.record({ tenantId, userId, action: 'booking.cancel.refused', entityType: 'booking', entityId: bookingId, payload: { requestId, reason: error.message } }).catch(() => undefined)
      }
      throw error
    }
  }

  private async evaluate(tx: Prisma.TransactionClient, tenantId: string, booking: { id: string; currency: string; totalMinor: bigint; searchSnapshot: Prisma.JsonValue; cancellationPolicy: Prisma.JsonValue | null }, now: Date) {
    const snapshot = booking.searchSnapshot as { checkIn?: string; checkOut?: string; inventoryHoldId?: string; ratePlanId?: string; canonicalHotelId?: string }
    if (!snapshot.checkIn || !snapshot.inventoryHoldId || !snapshot.ratePlanId) throw new ConflictException('Booking snapshot is incomplete')
    const plan = await tx.ratePlan.findFirst({ where: { id: snapshot.ratePlanId, tenantId }, include: { contract: { include: { cancellationPolicies: true } }, roomType: { include: { hotel: true } } } })
    if (!plan) throw new ConflictException('Rate plan is unavailable')
    const timeZone = plan.roomType.hotel.timeZone || 'UTC'
    // Finding F13: the terms frozen at booking govern. Only a booking made before they were frozen reads the plan's live rules; unreadable frozen terms are never treated as free.
    const frozen = readFrozenTerms(booking.cancellationPolicy)
    if (frozen.kind === 'invalid') throw new ConflictException('Cancellation requires manual review: the frozen cancellation terms are unreadable')
    // A legacy booking reads the live tiers as the buyer is sold them (after the client buffer); the no-show rule never prices a cancellation (ADR 0067, F-10).
    const rules: CancellationRule[] = frozen.kind === 'frozen' ? frozen.rules : buyerRules(cancellationTiers(rulesForPlan(plan, plan.contract.cancellationPolicies).rules).map(rule => ({
      daysBeforeCheckin: rule.daysBeforeCheckin, ...(rule.penaltyPercent !== null ? { penaltyPercent: rule.penaltyPercent } : {}),
      ...(rule.penaltyMinor !== null ? { penaltyMinor: rule.penaltyMinor } : {}), ...(rule.penaltyNights !== null ? { penaltyNights: rule.penaltyNights } : {}), ...(rule.currency ? { currency: rule.currency } : {}),
    })), plan.contract.clientBufferDays)
    const stayNights = (frozen.kind === 'frozen' ? frozen.stayNights : null) ?? nightsBetween(snapshot.checkIn, snapshot.checkOut)
    const requestedAt = now.toISOString()
    const quote = this.policy.quote({ cancellableAmountMinor: booking.totalMinor, currency: booking.currency, checkIn: snapshot.checkIn, requestedAt, rules, propertyTimeZone: timeZone, ...(stayNights ? { stayNights } : {}) })
    if (quote.status !== 'quotable') throw new ConflictException(`Cancellation requires manual review: ${quote.reason}`)
    // The stay starts at hotel-local midnight of check-in: the same instant the penalty tiers are measured from.
    const starts = penaltyStartsAt(snapshot.checkIn, 0, timeZone)
    if (starts === undefined || now.getTime() >= starts) throw new ConflictException('Stay has already started')
    return {
      holdId: snapshot.inventoryHoldId, penalty: quote.penaltyMinor, refund: quote.refundMinor,
      view: { bookingId: booking.id, currency: booking.currency, totalMinor: booking.totalMinor.toString(), penaltyMinor: quote.penaltyMinor.toString(), refundMinor: quote.refundMinor.toString(), checkIn: snapshot.checkIn, evaluatedAt: requestedAt },
    }
  }
}
