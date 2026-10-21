import { Injectable, Logger } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import type { BookingFinanceEventType } from '@bedbanks/contracts'
import { accountLockKey } from '../agent/agency-account'
import { appendLedgerEntry, referenceSumMinor } from '../ledger/ledger-core'
import { BookingFinancePostingDatabase } from './booking-finance-posting.database'
import { agencyEffect, bookingReference, holdKey, refundsOf, salesOf, planPosting, releaseKey, settleDebitKey, settleReleaseKey, type PaymentMode, type PostingEvent, type PostingFacts, type PostingPlan, type ReviewReason } from './posting-plan'

/** A REVIEW_REQUIRED event is retried after this long (the due-tenants function uses the same interval). */
export const REVIEW_RETRY_MS = 5 * 60 * 1000
/** How many unfinished events one pass reads per tenant. */
export const POSTING_BATCH = 200

export type PostingOutcome = 'POSTED' | 'SKIPPED' | 'REVIEW_REQUIRED' | 'BLOCKED' | 'ALREADY_FINAL' | 'NOT_FOUND'
export interface PostingDrainSummary { tenantId: string; examined: number; posted: number; skipped: number; reviewRequired: number; blocked: number }

/** The columns of `BookingFinanceEvent` the role may read (never the payload or the actor). */
const EVENT_SELECT = { id: true, bookingId: true, type: true, seq: true, currency: true, sellMinor: true, netMinor: true, penaltyMinor: true, refundMinor: true, adjustmentMinor: true, paymentMode: true, createdAt: true } as const

const earlier = (a: { createdAt: Date; id: string }, b: { createdAt: Date; id: string }) => a.createdAt.getTime() < b.createdAt.getTime() || (a.createdAt.getTime() === b.createdAt.getTime() && a.id < b.id)

/**
 * The Finance consumer of `BookingFinanceEvent` (ADR 0076; booking audit release gate 2). It turns each money fact the booking module recorded into the ledger entries of the
 * agency account and the supplier payable entries the accounting rules in `posting-plan.ts` prescribe.
 *
 * Single writer: every ledger entry goes through `appendLedgerEntry` (ADR 0062); this file never calls `ledgerEntry.create` or sums the ledger itself.
 * One transaction per event: the ledger entries, payable entry, posting row and audit event commit together or not at all. The booking module's role never sees the ledger and this
 * role never writes a booking, so neither side can do the other's job.
 * Ordered: a booking's events post in the order they happened. A booking whose earlier event needs review does not post its later events (a refund must not outrun the charge it refunds).
 * Idempotent: a posting row is unique per event, and the ledger keys are the Agent flow's, so a retry, a second worker or the Agent path itself can never charge, hold or refund twice.
 */
@Injectable()
export class BookingFinancePostingService {
  private readonly logger = new Logger(BookingFinancePostingService.name)

  constructor(private readonly db: BookingFinancePostingDatabase) {}

  /** Posts the unfinished events of one tenant, oldest first. Never throws for one bad event: that event becomes REVIEW_REQUIRED or is retried on the next pass. */
  async drain(tenantId: string, options: { now?: Date; limit?: number } = {}): Promise<PostingDrainSummary> {
    const now = options.now ?? new Date()
    const retryBefore = new Date(now.getTime() - REVIEW_RETRY_MS)
    const pending = await this.db.withTenant(tenantId, (tx) => tx.bookingFinanceEvent.findMany({
      where: { tenantId, OR: [{ posting: { is: null } }, { posting: { is: { status: 'REVIEW_REQUIRED', updatedAt: { lt: retryBefore } } } }] },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: options.limit ?? POSTING_BATCH, select: { id: true, bookingId: true },
    }))
    const summary: PostingDrainSummary = { tenantId, examined: pending.length, posted: 0, skipped: 0, reviewRequired: 0, blocked: 0 }
    const stalled = new Set<string>()
    for (const { id, bookingId } of pending) {
      if (stalled.has(bookingId)) { summary.blocked += 1; continue }
      let outcome: PostingOutcome
      try { outcome = await this.postEvent(tenantId, id) } catch (error) {
        // The transaction rolled back, so nothing was posted. Stop this booking for the pass; the next pass retries from the same event.
        this.logger.error(`Finance posting failed tenant=${tenantId} event=${id} error=${error instanceof Error ? error.name : 'UnknownError'}`)
        stalled.add(bookingId)
        summary.blocked += 1
        continue
      }
      if (outcome === 'POSTED') summary.posted += 1
      else if (outcome === 'SKIPPED') summary.skipped += 1
      else if (outcome === 'REVIEW_REQUIRED') { summary.reviewRequired += 1; stalled.add(bookingId) }
      else if (outcome === 'BLOCKED') { summary.blocked += 1; stalled.add(bookingId) }
    }
    return summary
  }

  /** Posts one event in one transaction. Safe to call twice and from two instances at once. */
  async postEvent(tenantId: string, eventId: string): Promise<PostingOutcome> {
    try {
      return await this.db.withTenant(tenantId, (tx) => this.apply(tx, tenantId, eventId))
    } catch (error) {
      // A unique violation here means another instance finished this event first, or a ledger key already exists that the facts did not show. Re-read once, then decide.
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error
      return this.db.withTenant(tenantId, async (tx) => {
        const done = await tx.bookingFinancePosting.findUnique({ where: { tenantId_eventId: { tenantId, eventId } }, select: { status: true } })
        if (done && done.status !== 'REVIEW_REQUIRED') return 'ALREADY_FINAL' as const
        return this.recordReview(tx, tenantId, eventId, 'EVENT_INCONSISTENT')
      })
    }
  }

  private async apply(tx: Prisma.TransactionClient, tenantId: string, eventId: string): Promise<PostingOutcome> {
    const found = await tx.bookingFinanceEvent.findFirst({ where: { id: eventId, tenantId }, select: EVENT_SELECT })
    if (!found) return 'NOT_FOUND'
    // One booking at a time: two events of one booking are never posted concurrently, so the ordering check below and the facts read after it are not racing anyone.
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`booking-finance-posting:${found.bookingId}`}, 0))`)
    const existing = await tx.bookingFinancePosting.findUnique({ where: { tenantId_eventId: { tenantId, eventId } }, select: { status: true } })
    if (existing && existing.status !== 'REVIEW_REQUIRED') return 'ALREADY_FINAL'

    const history = await tx.bookingFinanceEvent.findMany({ where: { tenantId, bookingId: found.bookingId }, select: { id: true, type: true, createdAt: true, sellMinor: true, netMinor: true, posting: { select: { status: true } } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
    const before = history.filter((h) => h.id !== found.id && earlier(h, found))
    if (before.some((h) => h.posting === null || h.posting.status === 'REVIEW_REQUIRED')) return 'BLOCKED'

    const booking = await tx.booking.findFirst({ where: { id: found.bookingId, tenantId }, select: { id: true, currency: true, agencyId: true, supplierId: true, paymentMode: true, netMinor: true } })
    if (!booking || booking.currency !== found.currency) return this.recordReview(tx, tenantId, eventId, 'EVENT_INCONSISTENT', found)

    // The event is the fact as it was recorded and never changes. When it did not record the payment mode or the net, the booking's current value is used, so Finance can
    // complete a booking (set its payment mode or its cost) and the retry then posts; an event that stays unknown stays in review.
    const event: PostingEvent = { ...found, type: found.type as BookingFinanceEventType, paymentMode: (found.paymentMode ?? booking.paymentMode) as PaymentMode | null, netMinor: found.netMinor ?? booking.netMinor }
    // The agency account: found by its agency and currency, or the one an earlier entry of this booking already used. Never opened here (ADR 0028).
    const [hold, released, settleReleased, debit, account] = await Promise.all([
      tx.ledgerEntry.findFirst({ where: { tenantId, idempotencyKey: holdKey(booking.id), type: 'HOLD' }, select: { walletId: true, amountMinor: true } }),
      tx.ledgerEntry.findFirst({ where: { tenantId, idempotencyKey: releaseKey(booking.id), type: 'RELEASE' }, select: { id: true } }),
      tx.ledgerEntry.findFirst({ where: { tenantId, idempotencyKey: settleReleaseKey(booking.id), type: 'RELEASE' }, select: { id: true } }),
      tx.ledgerEntry.findFirst({ where: { tenantId, idempotencyKey: settleDebitKey(booking.id), type: 'DEBIT' }, select: { walletId: true, amountMinor: true } }),
      booking.agencyId ? tx.wallet.findFirst({ where: { tenantId, agencyId: booking.agencyId, currency: booking.currency }, select: { id: true } }) : null,
    ])
    const walletId = debit?.walletId ?? hold?.walletId ?? account?.id ?? null
    if (booking.agencyId && walletId) {
      // The same two locks, in the same order, as the Agent flow's account paths: the account advisory lock, then the wallet row.
      await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${accountLockKey(booking.agencyId, booking.currency)}, 0))`)
      const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT "id" FROM "Wallet" WHERE "id" = ${walletId} AND "tenant_id" = ${tenantId} FOR UPDATE`)
      if (locked.length !== 1) return this.recordReview(tx, tenantId, eventId, 'NO_WALLET', found)
    }

    const [refunded, payable, cancellation] = await Promise.all([
      walletId ? referenceSumMinor(tx, tenantId, walletId, bookingReference(booking.id), 'REFUND') : Promise.resolve(0n),
      tx.supplierPayableEntry.aggregate({ where: { tenantId, bookingId: booking.id }, _sum: { amountMinor: true } }),
      tx.cancellation.findUnique({ where: { bookingId: booking.id }, select: { refundMinor: true } }),
    ])

    const facts: PostingFacts = {
      bookingId: booking.id, agencyId: booking.agencyId, supplierId: booking.supplierId, walletId,
      heldMinor: hold ? -hold.amountMinor : null, holdReleased: Boolean(released || settleReleased),
      chargedMinor: debit ? -debit.amountMinor : null, refundedMinor: refunded, payableMinor: payable._sum.amountMinor ?? 0n,
      cancellationRefundMinor: cancellation ? cancellation.refundMinor ?? 0n : null,
      cancelledBefore: before.some((h) => h.type === 'CANCELLED'),
      laterAmendments: history.filter((h) => h.type === 'AMENDED' && earlier(found, h)).map((h) => ({ sellMinor: h.sellMinor, netMinor: h.netMinor ?? booking.netMinor })),
    }
    const plan = planPosting(event, facts)
    if (plan.kind === 'REVIEW') return this.recordReview(tx, tenantId, eventId, plan.reason, found, walletId)
    if (plan.kind === 'SKIP') return this.record(tx, { tenantId, event: found, status: 'SKIPPED', reason: plan.reason, walletId, agencyEffect: 0n, payableEffect: 0n })
    return this.post(tx, { tenantId, event: found, bookingId: booking.id, supplierId: booking.supplierId, walletId, plan })
  }

  private async post(tx: Prisma.TransactionClient, input: { tenantId: string; event: PostedEvent; bookingId: string; supplierId: string | null; walletId: string | null; plan: Extract<PostingPlan, { kind: 'POST' }> }): Promise<PostingOutcome> {
    const { tenantId, event, plan, walletId } = input
    for (const leg of plan.legs) {
      if (!walletId) throw new Error('A ledger leg needs an account')
      await appendLedgerEntry(tx, { tenantId, walletId, type: leg.type, amountMinor: leg.amountMinor, currency: event.currency, reference: leg.reference, idempotencyKey: leg.idempotencyKey })
    }
    if (plan.payable) {
      if (!input.supplierId) throw new Error('A payable entry needs a supplier')
      await tx.supplierPayableEntry.create({ data: { tenantId, bookingId: input.bookingId, supplierId: input.supplierId, eventId: event.id, kind: plan.payable.kind, currency: event.currency, amountMinor: plan.payable.amountMinor }, select: { id: true } })
    }
    if (plan.cancellationRefundMinor !== null) {
      // The Cancellation record is what the ledger integrity monitor ties a cancelled, charged booking to (ADR 0068); the API-side settlement writes the same record and finds it settled.
      const record = await tx.cancellation.findUnique({ where: { bookingId: input.bookingId }, select: { id: true } })
      if (record) await tx.cancellation.update({ where: { bookingId: input.bookingId }, data: { refundMinor: plan.cancellationRefundMinor }, select: { id: true } })
      else await tx.cancellation.create({ data: { bookingId: input.bookingId, reason: 'Settled by finance (booking finance posting)', refundMinor: plan.cancellationRefundMinor }, select: { id: true } })
    }
    const effect = agencyEffect(plan.legs)
    return this.record(tx, { tenantId, event, status: 'POSTED', reason: null, walletId, agencyEffect: effect, payableEffect: plan.payable?.amountMinor ?? 0n, sales: salesOf(plan.legs), refunds: refundsOf(plan.legs), legs: plan.legs.map((l) => ({ type: l.type, amountMinor: l.amountMinor.toString(), idempotencyKey: l.idempotencyKey })), notes: plan.notes, cancellationRefundMinor: plan.cancellationRefundMinor })
  }

  private async recordReview(tx: Prisma.TransactionClient, tenantId: string, eventId: string, reason: ReviewReason, known?: PostedEvent, walletId: string | null = null): Promise<PostingOutcome> {
    const event = known ?? await tx.bookingFinanceEvent.findFirst({ where: { id: eventId, tenantId }, select: EVENT_SELECT })
    if (!event) return 'NOT_FOUND'
    return this.record(tx, { tenantId, event, status: 'REVIEW_REQUIRED', reason, walletId, agencyEffect: 0n, payableEffect: 0n })
  }

  /** Writes (or, for a posting under review, updates) the posting row and, for a final outcome, the audit event. */
  private async record(tx: Prisma.TransactionClient, input: { tenantId: string; event: PostedEvent; status: 'POSTED' | 'SKIPPED' | 'REVIEW_REQUIRED'; reason: string | null; walletId: string | null; agencyEffect: bigint; payableEffect: bigint; sales?: bigint; refunds?: bigint; legs?: unknown[]; notes?: string[]; cancellationRefundMinor?: bigint | null }): Promise<PostingOutcome> {
    const { tenantId, event, status } = input
    const data = { status, reason: input.reason, walletId: input.walletId, agencyEffectMinor: input.agencyEffect, payableEffectMinor: input.payableEffect, salesMinor: input.sales ?? 0n, refundsMinor: input.refunds ?? 0n }
    const prior = await tx.bookingFinancePosting.findUnique({ where: { tenantId_eventId: { tenantId, eventId: event.id } }, select: { id: true, status: true, reason: true } })
    if (prior) await tx.bookingFinancePosting.update({ where: { id: prior.id, tenantId }, data: { ...data, attempts: { increment: 1 } }, select: { id: true } })
    else await tx.bookingFinancePosting.create({ data: { tenantId, bookingId: event.bookingId, eventId: event.id, currency: event.currency, ...data }, select: { id: true } })
    // Audit a posting (a financial mutation) always, and a review only when it starts or its cause changes, so a stuck event does not write a row every retry.
    if (status === 'POSTED' || (status === 'REVIEW_REQUIRED' && (!prior || prior.reason !== input.reason))) {
      await tx.auditEvent.createMany({ data: [{
        tenantId, userId: null, actorType: 'SYSTEM', action: status === 'POSTED' ? 'booking.finance.posted' : 'booking.finance.review_required', entityType: 'booking', entityId: event.bookingId,
        payload: { eventId: event.id, eventType: event.type, seq: event.seq, currency: event.currency, reason: input.reason, walletId: input.walletId, agencyEffectMinor: input.agencyEffect.toString(), payableEffectMinor: input.payableEffect.toString(), legs: (input.legs ?? []) as Prisma.InputJsonValue[], notes: input.notes ?? [], cancellationRefundMinor: input.cancellationRefundMinor?.toString() ?? null },
      }] })
    }
    return status
  }
}

type PostedEvent = { id: string; bookingId: string; type: string; seq: number; currency: string }
