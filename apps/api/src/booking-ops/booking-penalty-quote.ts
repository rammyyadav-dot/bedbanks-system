import { Injectable } from '@nestjs/common'
import { parseFrozenRules, type StoredPenaltyQuote } from '@bedbanks/contracts'
import { CancellationPolicyService, type CancellationRule } from '../agent/cancellation-policy.service'
import { PrismaService } from '../database/prisma.service'
import { BookingOpsDatabase } from './booking-ops-database'

export interface PenaltyQuoteInput { sellMinor: bigint; currency: string; isRefundable: boolean | null; checkIn: string | null; rules: unknown; requestedAt: Date; timeZone: string }

/**
 * The cancellation penalty for a booking at a moment, from the rules frozen with it (ADR 0039, Phase 5). Pure and BigInt-only; the rule maths is the one
 * `CancellationPolicyService` already uses for the Agent flow. Anything it cannot answer with certainty is `needs_decision`, never zero and never the full price by default.
 */
export function buildPenaltyQuote(input: PenaltyQuoteInput, policy = new CancellationPolicyService()): StoredPenaltyQuote {
  const evaluatedAt = input.requestedAt.toISOString()
  const sell = input.sellMinor.toString()
  if (input.isRefundable === null) return { status: 'needs_decision', reason: 'refundability_unknown', detail: 'It is not known whether this booking is refundable.', evaluatedAt }
  if (input.isRefundable === false) return { status: 'quotable', currency: input.currency, sellMinor: sell, penaltyMinor: sell, refundMinor: '0', ruleDaysBeforeCheckin: null, basis: 'NON_REFUNDABLE', evaluatedAt }
  const frozen = parseFrozenRules(input.rules)
  if (!frozen) return { status: 'needs_decision', reason: 'policy_unavailable', detail: 'No readable cancellation terms were stored with this booking.', evaluatedAt }
  if (!input.checkIn) return { status: 'needs_decision', reason: 'manual_review_required', detail: 'The check-in date is not known.', evaluatedAt }
  const rules: CancellationRule[] = frozen.map((r) => r.penaltyPercent !== undefined ? { daysBeforeCheckin: r.daysBeforeCheckin, penaltyPercent: r.penaltyPercent } : { daysBeforeCheckin: r.daysBeforeCheckin, penaltyMinor: BigInt(r.penaltyMinor as string), currency: input.currency })
  const quote = policy.quote({ cancellableAmountMinor: input.sellMinor, currency: input.currency, checkIn: input.checkIn, requestedAt: evaluatedAt, rules, propertyTimeZone: input.timeZone })
  if (quote.status !== 'quotable') return { status: 'needs_decision', reason: quote.status, detail: `The cancellation terms could not be applied (${quote.reason}).`, evaluatedAt }
  return { status: 'quotable', currency: quote.currency, sellMinor: sell, penaltyMinor: quote.penaltyMinor.toString(), refundMinor: quote.refundMinor.toString(), ruleDaysBeforeCheckin: quote.effectiveRule?.daysBeforeCheckin ?? null, basis: 'RULE', evaluatedAt }
}

@Injectable()
export class BookingPenaltyQuoter {
  constructor(private readonly db: BookingOpsDatabase, private readonly prisma: PrismaService) {}

  /** Reads the booking as the booking role and the hotel's time zone as the API role (the booking role cannot read hotels), then evaluates. Runs outside any write transaction. */
  async quote(tenantId: string, bookingId: string, now: Date): Promise<StoredPenaltyQuote> {
    const booking = await this.db.withTenant(tenantId, (tx) => tx.booking.findFirst({ where: { id: bookingId, tenantId }, select: { totalMinor: true, currency: true, isRefundable: true, checkIn: true, hotelId: true, cancellationPolicy: true } }))
    if (!booking) return { status: 'needs_decision', reason: 'manual_review_required', detail: 'Booking not found.', evaluatedAt: now.toISOString() }
    const hotel = await this.prisma.withTenant(tenantId, (t) => t.hotel.findFirst({ where: { id: booking.hotelId, tenantId }, select: { timeZone: true } }))
    return buildPenaltyQuote({ sellMinor: booking.totalMinor, currency: booking.currency, isRefundable: booking.isRefundable, checkIn: booking.checkIn ? booking.checkIn.toISOString().slice(0, 10) : null, rules: booking.cancellationPolicy, requestedAt: now, timeZone: hotel?.timeZone ?? 'UTC' })
  }
}
