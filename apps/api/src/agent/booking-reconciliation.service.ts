import { Injectable, Logger } from '@nestjs/common'
import { PrismaService } from '../database/prisma.service'
import { AgentAuditService } from './audit.service'
import { BookingFinancialAuthorizationService } from './booking-financial-authorization.service'
import { InventoryHoldService } from './inventory-hold.service'
import { readSupplierPrebook } from './supplier-prebook-record'
import { supplierMutationAcceptedReference } from './supplier-mutation-journal.service'

export const MIN_STALE_MINUTES = 5
export const DEFAULT_STALE_MINUTES = 30
export const RECONCILIATION_BATCH_SIZE = 50
export const MIN_PREBOOK_MAX_MINUTES = 15
export const DEFAULT_PREBOOK_MAX_MINUTES = 60

export type ReconciliationOutcome =
  | 'reconciled' // wallet reservation (if any) and inventory returned, booking marked FAILED
  | 'orphan_hold_released' // claimed hold with no booking: inventory returned
  | 'prebooked_awaiting_confirmation' // supplier prebook succeeded and is still inside its confirmation window
  | 'prebook_expired' // prebooked but never confirmed within the window: wallet and inventory returned
  | 'manual_review_required' // supplier outcome was not observed: hold and wallet reservation stay claimed
  | 'booking_not_pending' // booking already progressed: left alone
  | 'would_reconcile' // dry run
  | 'failed' // a step failed; safe to retry

export interface ReconciliationItem { holdId: string; bookingId: string | null; outcome: ReconciliationOutcome }
export interface ReconciliationResult { dryRun: boolean; staleMinutes: number; prebookMaxMinutes: number; examined: number; items: ReconciliationItem[] }

/**
 * Resolves booking attempts that were interrupted after claiming inventory (hold stuck in PROCESSING).
 *
 * It runs as an authenticated, permission-guarded operator action on the acting user's identity because the
 * ordinary database role cannot write SYSTEM audit events and the restricted background role deliberately has no
 * ledger access. Every step is idempotent, so a partially failed run is retried by running it again.
 */
@Injectable()
export class BookingReconciliationService {
  private readonly logger = new Logger(BookingReconciliationService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly finance: BookingFinancialAuthorizationService,
    private readonly holds: InventoryHoldService,
    private readonly audit: AgentAuditService,
  ) {}

  async reconcileStale(input: { tenantId: string; userId: string; requestId: string; staleMinutes?: number; prebookMaxMinutes?: number; dryRun?: boolean; now?: Date }): Promise<ReconciliationResult> {
    const staleMinutes = Math.max(MIN_STALE_MINUTES, Math.trunc(input.staleMinutes ?? DEFAULT_STALE_MINUTES))
    const prebookMaxMinutes = Math.max(MIN_PREBOOK_MAX_MINUTES, Math.trunc(input.prebookMaxMinutes ?? DEFAULT_PREBOOK_MAX_MINUTES))
    const dryRun = input.dryRun === true
    const now = input.now ?? new Date()
    const cutoff = new Date(now.getTime() - staleMinutes * 60_000)
    const stale = await this.prisma.withTenant(input.tenantId, tx => tx.inventoryHold.findMany({
      where: { tenantId: input.tenantId, status: 'PROCESSING', updatedAt: { lt: cutoff } },
      select: { id: true }, orderBy: { updatedAt: 'asc' }, take: RECONCILIATION_BATCH_SIZE,
    }))

    const items: ReconciliationItem[] = []
    for (const hold of stale) {
      try {
        items.push(await this.reconcileOne(input.tenantId, input.userId, input.requestId, hold.id, dryRun, now, prebookMaxMinutes))
      } catch (error) {
        const errorName = error instanceof Error ? error.name : 'UnknownError'
        this.logger.error(`Booking reconciliation failed hold=${hold.id} request=${input.requestId} error=${errorName}`)
        await this.audit.record({ tenantId: input.tenantId, userId: input.userId, action: 'booking.reconciliation.failed', entityType: 'inventory_hold', entityId: hold.id, payload: { requestId: input.requestId, errorName } })
          .catch(() => this.logger.error(`Could not audit reconciliation failure hold=${hold.id}`))
        items.push({ holdId: hold.id, bookingId: null, outcome: 'failed' })
      }
    }
    return { dryRun, staleMinutes, prebookMaxMinutes, examined: stale.length, items }
  }

  private async reconcileOne(tenantId: string, userId: string, requestId: string, holdId: string, dryRun: boolean, now: Date, prebookMaxMinutes: number): Promise<ReconciliationItem> {
    const booking = await this.prisma.withTenant(tenantId, tx => tx.booking.findFirst({
      where: { tenantId, searchSnapshot: { path: ['inventoryHoldId'], equals: holdId } },
    }))

    if (!booking) {
      if (dryRun) return { holdId, bookingId: null, outcome: 'would_reconcile' }
      await this.holds.release(tenantId, holdId, `${requestId}:reconcile-orphan`, { type: 'USER', userId })
      await this.audit.record({ tenantId, userId, action: 'booking.reconciled', entityType: 'inventory_hold', entityId: holdId, payload: { requestId, outcome: 'orphan_hold_released' } })
      return { holdId, bookingId: null, outcome: 'orphan_hold_released' }
    }
    // FAILED with a still-PROCESSING hold is an interrupted earlier reconciliation: finish it (every step is idempotent).
    if (booking.status !== 'PENDING_SUPPLIER' && booking.status !== 'FAILED') return { holdId, bookingId: booking.id, outcome: 'booking_not_pending' }

    const mutation = await this.prisma.withTenant(tenantId, tx => tx.supplierMutation.findFirst({
      where: { tenantId, bookingId: booking.id, operation: 'PREBOOK' },
      orderBy: { createdAt: 'desc' },
    }))

    let expiredPrebook = false
    let journalTerminal: 'not_sent' | 'rejected' | 'expired' | null = null
    if (mutation) {
      const uncertain = mutation.status === 'SENDING' || mutation.status === 'UNKNOWN' || (mutation.status === 'RESOLVED' && mutation.supplierStatus === 'unknown')
      if (uncertain) {
        if (!dryRun && mutation.status === 'SENDING') {
          await this.prisma.withTenant(tenantId, tx => tx.supplierMutation.updateMany({
            where: { id: mutation.id, tenantId, status: 'SENDING' },
            data: { status: 'UNKNOWN', failureCategory: 'crash', failureCode: 'outcome_unobserved' },
          })).catch(() => this.logger.error(`Could not mark unobserved supplier mutation unknown mutation=${mutation.id}`))
          await this.audit.record({
            tenantId, userId, action: 'supplier.mutation.unknown', entityType: 'supplier_mutation', entityId: mutation.id,
            payload: { requestId, bookingId: booking.id, mutationId: mutation.id, holdId, supplierKey: mutation.supplierKey, operation: mutation.operation, state: 'UNKNOWN', failureCategory: 'crash' },
          }).catch(() => undefined)
        }
        if (!dryRun) await this.noteManualReview(tenantId, userId, requestId, holdId, booking.id)
        return { holdId, bookingId: booking.id, outcome: 'manual_review_required' }
      }
      if (supplierMutationAcceptedReference(mutation)) {
        if (booking.status !== 'PENDING_SUPPLIER') {
          if (!dryRun) await this.noteManualReview(tenantId, userId, requestId, holdId, booking.id)
          return { holdId, bookingId: booking.id, outcome: 'manual_review_required' }
        }
        const acknowledgedAt = mutation.acknowledgedAt ?? mutation.updatedAt
        if (now.getTime() - acknowledgedAt.getTime() < prebookMaxMinutes * 60_000) return { holdId, bookingId: booking.id, outcome: 'prebooked_awaiting_confirmation' }
        expiredPrebook = true
        journalTerminal = 'expired'
      } else if (mutation.status === 'PREPARED') {
        journalTerminal = 'not_sent'
      } else if (mutation.status === 'REJECTED') {
        journalTerminal = 'rejected'
      } else if (mutation.status === 'RESOLVED' && (mutation.supplierStatus === 'not_sent' || mutation.supplierStatus === 'rejected' || mutation.supplierStatus === 'expired')) {
        journalTerminal = null
      } else if (mutation.status !== 'RESOLVED') {
        if (!dryRun) await this.noteManualReview(tenantId, userId, requestId, holdId, booking.id)
        return { holdId, bookingId: booking.id, outcome: 'manual_review_required' }
      }
    } else if (booking.status === 'PENDING_SUPPLIER') {
      const marker = await this.prisma.withTenant(tenantId, tx => tx.auditEvent.findFirst({
        where: { tenantId, action: 'booking.prebook.succeeded', entityType: 'booking', entityId: booking.id }, orderBy: { createdAt: 'asc' }, select: { createdAt: true },
      }))
      const recorded = readSupplierPrebook(booking.searchSnapshot)
      const succeededAt = marker?.createdAt ?? (recorded?.outcome === 'prebooked' && recorded.supplierReference ? booking.updatedAt : null)
      if (succeededAt) {
        if (now.getTime() - succeededAt.getTime() < prebookMaxMinutes * 60_000) return { holdId, bookingId: booking.id, outcome: 'prebooked_awaiting_confirmation' }
        expiredPrebook = true
      } else if (await this.supplierOutcomeUnknown(tenantId, booking.id, recorded?.outcome === 'unknown')) {
        if (!dryRun) await this.noteManualReview(tenantId, userId, requestId, holdId, booking.id)
        return { holdId, bookingId: booking.id, outcome: 'manual_review_required' }
      }
    }
    if (dryRun) return { holdId, bookingId: booking.id, outcome: 'would_reconcile' }

    if (booking.status === 'PENDING_SUPPLIER') {
      // Claim first: confirmation also locks the booking and requires PENDING, so exactly one of
      // "confirm" and "reconcile/expire" can win. Losing here means the booking was just confirmed.
      const claimed = await this.prisma.withTenant(tenantId, tx => tx.booking.updateMany({ where: { id: booking.id, tenantId, status: 'PENDING_SUPPLIER' }, data: { status: 'FAILED' } }))
      if (claimed.count !== 1) return { holdId, bookingId: booking.id, outcome: 'booking_not_pending' }
    }

    const authorizationKey = `booking:${booking.id}:authorize`
    const reservation = await this.prisma.withTenant(tenantId, tx => tx.ledgerEntry.findFirst({ where: { tenantId, idempotencyKey: authorizationKey, type: 'HOLD' } }))
    if (reservation) {
      await this.finance.release({ tenantId, userId, requestId, walletId: reservation.walletId, bookingId: booking.id, currency: booking.currency, amountMinor: booking.totalMinor, idempotencyKey: authorizationKey })
    }
    await this.holds.release(tenantId, holdId, `${requestId}:reconcile`, { type: 'USER', userId })
    const outcome = expiredPrebook ? 'prebook_expired' : 'reconciled'
    if (mutation && journalTerminal && mutation.status !== 'RESOLVED') {
      await this.prisma.withTenant(tenantId, tx => tx.supplierMutation.updateMany({
        where: { id: mutation.id, tenantId, status: { not: 'RESOLVED' } },
        data: { status: 'RESOLVED', supplierStatus: journalTerminal, resolvedAt: new Date() },
      }))
      await this.audit.record({
        tenantId, userId, action: 'supplier.mutation.reconciled', entityType: 'supplier_mutation', entityId: mutation.id,
        payload: { requestId, bookingId: booking.id, mutationId: mutation.id, holdId, operation: mutation.operation, state: 'RESOLVED', supplierStatus: journalTerminal },
      }).catch(() => this.logger.error(`Could not audit supplier mutation reconciliation mutation=${mutation.id}`))
    }
    await this.audit.record({ tenantId, userId, action: expiredPrebook ? 'booking.prebook.expired' : 'booking.reconciled', entityType: 'booking', entityId: booking.id,
      payload: { requestId, inventoryHoldId: holdId, outcome, walletReleased: Boolean(reservation), ...(expiredPrebook ? { prebookMaxMinutes } : {}) } })
    return { holdId, bookingId: booking.id, outcome }
  }

  private async supplierOutcomeUnknown(tenantId: string, bookingId: string, snapshotUnknown: boolean): Promise<boolean> {
    if (snapshotUnknown) return true
    const unknown = await this.prisma.withTenant(tenantId, tx => tx.auditEvent.findFirst({
      where: { tenantId, action: 'booking.prebook.unknown', entityType: 'booking', entityId: bookingId }, select: { id: true },
    }))
    return Boolean(unknown)
  }

  /** One audit row per booking. Repeating the sweep must not release inventory or append another review. */
  private async noteManualReview(tenantId: string, userId: string, requestId: string, holdId: string, bookingId: string): Promise<void> {
    const existing = await this.prisma.withTenant(tenantId, tx => tx.auditEvent.count({
      where: { tenantId, action: 'booking.reconciliation.manual_review', entityType: 'booking', entityId: bookingId },
    }))
    if (existing > 0) return
    await this.audit.record({ tenantId, userId, action: 'booking.reconciliation.manual_review', entityType: 'booking', entityId: bookingId,
      payload: { requestId, inventoryHoldId: holdId, outcome: 'manual_review_required' } })
  }
}
