import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common'
import { BOOKING_CLOSABLE_STATUSES, CLOSE_ACTION_BY_STATUS, evaluateBookingOps, parseCloseAfterDays } from '@bedbanks/contracts'
import { currentPenalty } from './booking-finance-events'
import { BookingOpsDatabase } from './booking-ops-database'
import { loadOpsFacts, OPS_BOOKING_SELECT } from './booking-ops-facts'
import { slaPolicy } from './booking-ops-queue.service'
import { transitionBooking } from './booking-transition'
import { BOOKING_SUPPLIER_RESOLVER, type BookingSupplierResolver } from './supplier/booking-supplier.port'

const BATCH = 200
const MIN_INTERVAL_MS = 60_000
const DEFAULT_INTERVAL_MS = 3_600_000

/** The UTC calendar day a pass is run for. A booking is checked out when its check-out date is BEFORE this day, i.e. from the day after check-out (spec workflow G). */
export const checkoutCutoffDay = (now: Date): string => now.toISOString().slice(0, 10)

export interface LifecyclePassResult { checkedOut: number; closed: number; skipped: number; failed: number }
const DAY_MS = 86_400_000

/**
 * The scheduled lifecycle jobs of the Admin booking module (ADR 0039, Phase 6E). Today: automatic Checked-out. Off unless `BOOKING_LIFECYCLE_JOB_ENABLED=true`, and it then
 * needs the booking module's own database credential and nothing broader.
 *
 * It decides nothing about status itself: every move goes through `transitionBooking` (the one writer), as the named system action `markCheckedOut`, so the move is
 * compare-and-set, leaves an immutable `BookingEvent` (actor SYSTEM) and is idempotent per booking. A booking that changed between the read and the move (a person cancelled it,
 * an amendment was requested) is a stale status, which is skipped, never forced. It moves no money (a Checked-out booking emits no finance event) and sends nothing.
 *
 * Close after the dispute window (Phase 6G): off unless `BOOKING_CLOSE_AFTER_DAYS` is set to a whole number of days. The spec leaves the length as an open owner question, so no default
 * is invented: unset, nothing is ever closed. A booking in a closable status (Checked out, No-show, Cancelled, Rejected, Failed) that has not changed for that many days is locked
 * (`closedAt`), through the named system action for its status. It is skipped, never forced, when anything about it still needs a person: it is an Operations queue case by the
 * queue's own ruleset (an unresolved supplier answer, a follow-up, an active job, ...), or it is Cancelled with a penalty nobody has decided yet.
 */
@Injectable()
export class BookingLifecycleJobs implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BookingLifecycleJobs.name)
  private timer?: NodeJS.Timeout
  private running = false

  private closeAfterDays: number | null = null

  constructor(private readonly db: BookingOpsDatabase, @Optional() private readonly env: Record<string, string | undefined> = process.env, @Optional() @Inject(BOOKING_SUPPLIER_RESOLVER) private readonly suppliers?: BookingSupplierResolver) {}

  onModuleInit(): void {
    if (this.env.BOOKING_LIFECYCLE_JOB_ENABLED !== 'true') return
    if (!this.db.configured()) throw new Error('BOOKING_LIFECYCLE_JOB_ENABLED requires BOOKING_OPS_DATABASE_URL (a different credential from DATABASE_URL)')
    const interval = Number(this.env.BOOKING_LIFECYCLE_JOB_INTERVAL_MS ?? DEFAULT_INTERVAL_MS)
    if (!Number.isInteger(interval) || interval < MIN_INTERVAL_MS) throw new Error(`BOOKING_LIFECYCLE_JOB_INTERVAL_MS must be an integer >= ${MIN_INTERVAL_MS}`)
    const close = parseCloseAfterDays(this.env.BOOKING_CLOSE_AFTER_DAYS)
    if (!close.ok) throw new Error(`BOOKING_CLOSE_AFTER_DAYS ${close.error}`)
    if (close.days !== null && !this.suppliers) throw new Error('BOOKING_CLOSE_AFTER_DAYS needs the supplier resolver, to judge whether a booking is still an operations case')
    this.closeAfterDays = close.days
    this.timer = setInterval(() => { void this.runOnce() }, interval)
    this.timer.unref()
    this.logger.log(`Booking lifecycle job enabled every ${interval}ms${this.closeAfterDays === null ? ' (close after the dispute window: off, BOOKING_CLOSE_AFTER_DAYS is not set)' : `, closing after ${this.closeAfterDays} days`}`)
  }
  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined }

  /** One pass over every tenant with a booking due. Never overlaps itself. A tenant's failure never stops the others. */
  async runOnce(clock: () => Date = () => new Date()): Promise<LifecyclePassResult> {
    const total: LifecyclePassResult = { checkedOut: 0, closed: 0, skipped: 0, failed: 0 }
    if (this.running) return total
    this.running = true
    try {
      const now = clock()
      for (const tenantId of await this.db.checkoutDueTenants(checkoutCutoffDay(now))) {
        try {
          const r = await this.checkOutTenant(tenantId, now)
          total.checkedOut += r.checkedOut; total.skipped += r.skipped; total.failed += r.failed
        } catch (error) { total.failed += 1; this.logger.error(`Checked-out job failed for a tenant: ${error instanceof Error ? error.name : 'unknown error'}`) }
      }
      if (this.closeAfterDays !== null) {
        const cutoff = new Date(now.getTime() - this.closeAfterDays * DAY_MS)
        for (const tenantId of await this.db.closeDueTenants(cutoff)) {
          try {
            const r = await this.closeTenant(tenantId, now, cutoff)
            total.closed += r.closed; total.skipped += r.skipped; total.failed += r.failed
          } catch (error) { total.failed += 1; this.logger.error(`Close job failed for a tenant: ${error instanceof Error ? error.name : 'unknown error'}`) }
        }
      }
    } catch (error) { this.logger.error(`Checked-out job could not list due tenants: ${error instanceof Error ? error.name : 'unknown error'}`) } finally { this.running = false }
    if (total.checkedOut || total.closed || total.failed) this.logger.log(`Lifecycle pass: ${total.checkedOut} checked out, ${total.closed} closed, ${total.skipped} skipped (changed meanwhile or still needs a person), ${total.failed} failed`)
    return total
  }

  /** Up to a batch for one tenant; the rest are picked up by the next pass. One transaction per booking, so one failure never rolls back or blocks another. */
  private async checkOutTenant(tenantId: string, now: Date): Promise<LifecyclePassResult> {
    const today = new Date(`${checkoutCutoffDay(now)}T00:00:00.000Z`)
    const due = await this.db.withTenant(tenantId, (tx) => tx.booking.findMany({ where: { tenantId, status: 'CONFIRMED', closedAt: null, checkOut: { lt: today } }, orderBy: [{ checkOut: 'asc' }, { id: 'asc' }], take: BATCH, select: { id: true } }))
    const result: LifecyclePassResult = { checkedOut: 0, closed: 0, skipped: 0, failed: 0 }
    for (const { id } of due) {
      try {
        const out = await this.db.withTenantWrite(tenantId, (tx) => transitionBooking(tx, {
          tenantId, bookingId: id, action: 'markCheckedOut', expectedStatus: 'CONFIRMED', actor: { type: 'SYSTEM' }, level: 'SYSTEM', now, idempotencyKey: `lifecycle:checkout:${id}`,
        }))
        if (out.replayed) result.skipped += 1; else result.checkedOut += 1
      } catch (error) {
        const code = (error as { getResponse?: () => { code?: string } }).getResponse?.()?.code
        // Someone moved or locked it between our read and our move: leave it alone.
        if (code === 'STALE_STATUS' || code === 'ILLEGAL_TRANSITION' || code === 'BOOKING_CLOSED') result.skipped += 1
        else { result.failed += 1; this.logger.error(`Checked-out move failed (${code ?? (error instanceof Error ? error.name : 'unknown')})`) }
      }
    }
    return result
  }
  /**
   * Up to a batch for one tenant. Each booking is judged again under its own row lock, in its own transaction: still open, still unchanged since the cutoff, not an operations case,
   * and (for Cancelled) its penalty decided. Anything else is skipped and looked at again next pass; one failure never blocks another.
   */
  private async closeTenant(tenantId: string, now: Date, cutoff: Date): Promise<LifecyclePassResult> {
    const result: LifecyclePassResult = { checkedOut: 0, closed: 0, skipped: 0, failed: 0 }
    const policy = slaPolicy() // an invalid policy throws: the queue would not guess, so neither does a close
    const due = await this.db.withTenant(tenantId, (tx) => tx.booking.findMany({ where: { tenantId, closedAt: null, status: { in: [...BOOKING_CLOSABLE_STATUSES] }, updatedAt: { lt: cutoff } }, orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }], take: BATCH, select: { id: true } }))
    for (const { id } of due) {
      try {
        const outcome = await this.db.withTenantWrite(tenantId, async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "Booking" WHERE "id" = ${id} AND "tenant_id" = ${tenantId} FOR UPDATE`
          const row = await tx.booking.findFirst({ where: { id, tenantId }, select: { ...OPS_BOOKING_SELECT, currency: true, totalMinor: true, netMinor: true, paymentMode: true } })
          const action = row ? CLOSE_ACTION_BY_STATUS[row.status] : undefined
          if (!row || !action || row.closedAt !== null || row.updatedAt >= cutoff) return 'skipped' as const
          const facts = (await loadOpsFacts(tx, tenantId, [row], this.suppliers!)).get(id)
          if (!facts || evaluateBookingOps(facts, now, policy).inQueue) return 'skipped' as const
          if (row.status === 'CANCELLED') {
            const { penalty } = await currentPenalty(tx, { id, tenantId, currency: row.currency, totalMinor: row.totalMinor, netMinor: row.netMinor, paymentMode: row.paymentMode }, true)
            if (penalty.state !== 'QUOTED' && penalty.state !== 'DECIDED' && penalty.state !== 'WAIVED') return 'skipped' as const // a person must decide the penalty first
          }
          const out = await transitionBooking(tx, {
            tenantId, bookingId: id, action, expectedStatus: row.status, actor: { type: 'SYSTEM' }, level: 'SYSTEM', now, idempotencyKey: `lifecycle:close:${id}`,
            reason: `Closed automatically: no change for ${Math.round((now.getTime() - cutoff.getTime()) / DAY_MS)} days (dispute window)`,
          })
          return out.replayed ? 'skipped' as const : 'closed' as const
        })
        if (outcome === 'closed') result.closed += 1; else result.skipped += 1
      } catch (error) {
        const code = (error as { getResponse?: () => { code?: string } }).getResponse?.()?.code
        if (code === 'STALE_STATUS' || code === 'ILLEGAL_TRANSITION' || code === 'BOOKING_CLOSED') result.skipped += 1
        else { result.failed += 1; this.logger.error(`Close move failed (${code ?? (error instanceof Error ? error.name : 'unknown')})`) }
      }
    }
    return result
  }
}
