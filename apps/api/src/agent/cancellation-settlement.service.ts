import { Injectable, Logger } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import type { CancellationSettlementItem, CancellationSettlementOutcome, CancellationSettlementRun } from '@bedbanks/contracts'
import { refundWithin } from '@bedbanks/money'
import { PrismaService } from '../database/prisma.service'
import { appendLedgerEntry, referenceSumMinor } from '../ledger/ledger-core'
import { currentPenalty } from '../booking-ops/booking-finance-events'

export type CancellationSettlementResult = CancellationSettlementItem

/** How many cancelled, charged, unsettled bookings one sweep settles. */
export const CANCELLATION_SETTLEMENT_BATCH = 50

/**
 * Settles the agency account of a cancelled booking (ADR 0069, audit F3), the way a bedbank credits its client on cancellation:
 * refund = booking total - the effective penalty (the latest waiver or decision, else the quote fixed when cancellation was requested).
 *
 * - An undetermined penalty (NEEDS_DECISION) credits nothing: money is never guessed. Recording the decision later settles it.
 * - A lower penalty decided after settlement (a waiver) tops the refund up to the new amount.
 * - A refund is never taken back automatically: a decision that would refund less than already posted is `review_required`.
 * - The agent cancellation path already settles in its own transaction (it writes the cancellation record), so its bookings are `already_settled`.
 *
 * One transaction under the booking row lock (shared with every cancellation path) and the wallet row lock. Idempotent: the first credit is
 * keyed `booking:<id>:cancel-refund` (the agent path's key, so the two paths can never both credit), a top-up `…:cancel-refund:<new total>`.
 * Runs on the API connection, like the agent cancellation, because the booking module's role has no ledger access (ADR 0032).
 */
@Injectable()
export class CancellationSettlementService {
  private readonly logger = new Logger(CancellationSettlementService.name)

  constructor(private readonly prisma: PrismaService) {}

  async settle(input: { tenantId: string; userId: string; requestId: string; bookingId: string; source: string }): Promise<CancellationSettlementResult> {
    const { tenantId, userId, requestId, bookingId } = input
    const result = (outcome: CancellationSettlementOutcome, refund: bigint | null = null, posted: bigint | null = null): CancellationSettlementResult =>
      ({ bookingId, outcome, refundMinor: refund === null ? null : refund.toString(), postedMinor: posted === null ? null : posted.toString() })
    return this.prisma.withTenant(tenantId, async tx => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "Booking" WHERE "id" = ${bookingId} AND "tenant_id" = ${tenantId} FOR UPDATE`)
      if (locked.length !== 1) return result('not_found')
      const booking = await tx.booking.findFirstOrThrow({ where: { id: bookingId, tenantId }, select: { id: true, tenantId: true, status: true, currency: true, totalMinor: true, netMinor: true, paymentMode: true } })
      if (booking.status !== 'CANCELLED') return result('not_cancelled')
      const debit = await tx.ledgerEntry.findFirst({ where: { tenantId, idempotencyKey: `booking:${bookingId}:authorize:settle-debit`, type: 'DEBIT' } })
      if (!debit) return result('not_ledger_charged') // a booking the agency was never charged for on the ledger (for example a manual booking)
      const charged = -debit.amountMinor
      const walletRows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "Wallet" WHERE "id" = ${debit.walletId} AND "tenant_id" = ${tenantId} FOR UPDATE`)
      if (walletRows.length !== 1) return result('review_required')

      const reference = `booking:${bookingId}`
      const posted = await referenceSumMinor(tx, tenantId, debit.walletId, reference, 'REFUND')
      const cancellation = await tx.cancellation.findUnique({ where: { bookingId } })
      const { penalty } = await currentPenalty(tx, { ...booking, paymentMode: booking.paymentMode as string | null }, true)
      if (penalty.state !== 'QUOTED' && penalty.state !== 'DECIDED' && penalty.state !== 'WAIVED') return result(cancellation ? 'already_settled' : 'awaiting_penalty_decision', cancellation?.refundMinor ?? null)

      const target = BigInt(penalty.refundMinor)
      if (!refundWithin({ refundMinor: target, authorizedRefundableMinor: charged }) || target < posted) return result('review_required', target)
      const delta = target - posted
      if (delta === 0n && cancellation && cancellation.refundMinor === target) return result('already_settled', target, 0n)

      if (delta > 0n) {
        await appendLedgerEntry(tx, {
          tenantId, walletId: debit.walletId, type: 'REFUND', amountMinor: delta, currency: debit.currency, reference,
          idempotencyKey: posted === 0n ? `booking:${bookingId}:cancel-refund` : `booking:${bookingId}:cancel-refund:${target}`,
        })
      }
      if (cancellation) await tx.cancellation.update({ where: { bookingId }, data: { refundMinor: target } })
      else await tx.cancellation.create({ data: { bookingId, reason: `Settled by finance (${input.source})`, refundMinor: target } })
      await tx.auditEvent.create({ data: { tenantId, userId, actorType: 'USER', action: 'booking.cancellation.settled', entityType: 'booking', entityId: bookingId, payload: {
        requestId, source: input.source, penaltyState: penalty.state, penaltyMinor: penalty.penaltyMinor, refundMinor: target.toString(), postedMinor: delta.toString(), walletId: debit.walletId, currency: debit.currency,
      } } })
      return result(posted === 0n ? 'settled' : 'topped_up', target, delta)
    })
  }

  /**
   * Called right after another path cancelled a booking or changed its penalty. Never throws: the cancellation has already committed, and a
   * settlement that fails here is reported by the ledger integrity check (`CANCELLED_REFUND_NOT_POSTED`) and retried by the sweep.
   */
  async settleQuietly(input: { tenantId: string; userId: string; requestId: string; bookingId: string; source: string }): Promise<CancellationSettlementResult | null> {
    try {
      return await this.settle(input)
    } catch (error) {
      this.logger.error(`Cancellation settlement failed booking=${input.bookingId} request=${input.requestId} error=${error instanceof Error ? error.name : 'UnknownError'}`)
      return null
    }
  }

  /** One sweep over the cancelled, charged, unsettled bookings of a tenant. Each settles alone; one failure does not stop the others. */
  async sweep(input: { tenantId: string; userId: string; requestId: string; dryRun?: boolean }): Promise<CancellationSettlementRun> {
    const ids = await this.pending(input.tenantId)
    if (input.dryRun) return { dryRun: true, examined: ids.length, items: ids.map(bookingId => ({ bookingId, outcome: 'would_settle', refundMinor: null, postedMinor: null })) }
    const items: CancellationSettlementItem[] = []
    for (const bookingId of ids) {
      const done = await this.settleQuietly({ tenantId: input.tenantId, userId: input.userId, requestId: input.requestId, bookingId, source: 'sweep' })
      items.push(done ?? { bookingId, outcome: 'failed', refundMinor: null, postedMinor: null })
    }
    return { dryRun: false, examined: ids.length, items }
  }

  /** The cancelled, ledger-charged bookings with no settlement yet, oldest first, for the sweep. */
  async pending(tenantId: string, take = CANCELLATION_SETTLEMENT_BATCH): Promise<string[]> {
    return this.prisma.withTenant(tenantId, async tx => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT b."id" FROM "Booking" b
         WHERE b."tenant_id" = ${tenantId} AND b."status" = 'CANCELLED'
           AND NOT EXISTS (SELECT 1 FROM "Cancellation" c WHERE c."booking_id" = b."id")
           AND EXISTS (SELECT 1 FROM "LedgerEntry" e WHERE e."tenant_id" = b."tenant_id" AND e."idempotency_key" = 'booking:' || b."id" || ':authorize:settle-debit')
         ORDER BY b."updated_at" ASC, b."id" ASC
         LIMIT ${take}`)
      return rows.map(r => r.id)
    })
  }
}
