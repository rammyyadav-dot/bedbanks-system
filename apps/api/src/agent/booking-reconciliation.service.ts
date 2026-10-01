import { Injectable, Logger } from '@nestjs/common'
import { PrismaService } from '../database/prisma.service'
import { AgentAuditService } from './audit.service'
import { BookingFinancialAuthorizationService } from './booking-financial-authorization.service'
import { InventoryHoldService } from './inventory-hold.service'

export const MIN_STALE_MINUTES = 5
export const DEFAULT_STALE_MINUTES = 30
export const RECONCILIATION_BATCH_SIZE = 50

export type ReconciliationOutcome =
  | 'reconciled' // wallet reservation (if any) and inventory returned, booking marked FAILED
  | 'orphan_hold_released' // claimed hold with no booking: inventory returned
  | 'prebooked_awaiting_confirmation' // supplier prebook succeeded: deliberately left alone
  | 'booking_not_pending' // booking already progressed: left alone
  | 'would_reconcile' // dry run
  | 'failed' // a step failed; safe to retry

export interface ReconciliationItem { holdId: string; bookingId: string | null; outcome: ReconciliationOutcome }
export interface ReconciliationResult { dryRun: boolean; staleMinutes: number; examined: number; items: ReconciliationItem[] }

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

  async reconcileStale(input: { tenantId: string; userId: string; requestId: string; staleMinutes?: number; dryRun?: boolean; now?: Date }): Promise<ReconciliationResult> {
    const staleMinutes = Math.max(MIN_STALE_MINUTES, Math.trunc(input.staleMinutes ?? DEFAULT_STALE_MINUTES))
    const dryRun = input.dryRun === true
    const cutoff = new Date((input.now ?? new Date()).getTime() - staleMinutes * 60_000)
    const stale = await this.prisma.withTenant(input.tenantId, tx => tx.inventoryHold.findMany({
      where: { tenantId: input.tenantId, status: 'PROCESSING', updatedAt: { lt: cutoff } },
      select: { id: true }, orderBy: { updatedAt: 'asc' }, take: RECONCILIATION_BATCH_SIZE,
    }))

    const items: ReconciliationItem[] = []
    for (const hold of stale) {
      try {
        items.push(await this.reconcileOne(input.tenantId, input.userId, input.requestId, hold.id, dryRun))
      } catch (error) {
        const errorName = error instanceof Error ? error.name : 'UnknownError'
        this.logger.error(`Booking reconciliation failed hold=${hold.id} request=${input.requestId} error=${errorName}`)
        await this.audit.record({ tenantId: input.tenantId, userId: input.userId, action: 'booking.reconciliation.failed', entityType: 'inventory_hold', entityId: hold.id, payload: { requestId: input.requestId, errorName } })
          .catch(() => this.logger.error(`Could not audit reconciliation failure hold=${hold.id}`))
        items.push({ holdId: hold.id, bookingId: null, outcome: 'failed' })
      }
    }
    return { dryRun, staleMinutes, examined: stale.length, items }
  }

  private async reconcileOne(tenantId: string, userId: string, requestId: string, holdId: string, dryRun: boolean): Promise<ReconciliationItem> {
    const booking = await this.prisma.withTenant(tenantId, tx => tx.booking.findFirst({
      where: { tenantId, searchSnapshot: { path: ['inventoryHoldId'], equals: holdId } },
    }))

    if (!booking) {
      if (dryRun) return { holdId, bookingId: null, outcome: 'would_reconcile' }
      await this.holds.release(tenantId, holdId, `${requestId}:reconcile-orphan`, { type: 'USER', userId })
      await this.audit.record({ tenantId, userId, action: 'booking.reconciled', entityType: 'inventory_hold', entityId: holdId, payload: { requestId, outcome: 'orphan_hold_released' } })
      return { holdId, bookingId: null, outcome: 'orphan_hold_released' }
    }
    if (booking.status !== 'PENDING') return { holdId, bookingId: booking.id, outcome: 'booking_not_pending' }

    const prebooked = await this.prisma.withTenant(tenantId, tx => tx.auditEvent.count({ where: { tenantId, action: 'booking.prebook.succeeded', entityType: 'booking', entityId: booking.id } }))
    if (prebooked > 0) return { holdId, bookingId: booking.id, outcome: 'prebooked_awaiting_confirmation' }
    if (dryRun) return { holdId, bookingId: booking.id, outcome: 'would_reconcile' }

    const authorizationKey = `booking:${booking.id}:authorize`
    const reservation = await this.prisma.withTenant(tenantId, tx => tx.ledgerEntry.findFirst({ where: { tenantId, idempotencyKey: authorizationKey, type: 'HOLD' } }))
    if (reservation) {
      await this.finance.release({ tenantId, userId, requestId, walletId: reservation.walletId, bookingId: booking.id, currency: booking.currency, amountMinor: booking.totalMinor, idempotencyKey: authorizationKey })
    }
    await this.holds.release(tenantId, holdId, `${requestId}:reconcile`, { type: 'USER', userId })
    await this.prisma.withTenant(tenantId, tx => tx.booking.updateMany({ where: { id: booking.id, tenantId, status: 'PENDING' }, data: { status: 'FAILED' } }))
    await this.audit.record({ tenantId, userId, action: 'booking.reconciled', entityType: 'booking', entityId: booking.id,
      payload: { requestId, inventoryHoldId: holdId, outcome: 'reconciled', walletReleased: Boolean(reservation) } })
    return { holdId, bookingId: booking.id, outcome: 'reconciled' }
  }
}
