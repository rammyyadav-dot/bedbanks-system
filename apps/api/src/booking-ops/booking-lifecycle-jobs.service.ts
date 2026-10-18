import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common'
import { BookingOpsDatabase } from './booking-ops-database'
import { transitionBooking } from './booking-transition'

const BATCH = 200
const MIN_INTERVAL_MS = 60_000
const DEFAULT_INTERVAL_MS = 3_600_000

/** The UTC calendar day a pass is run for. A booking is checked out when its check-out date is BEFORE this day, i.e. from the day after check-out (spec workflow G). */
export const checkoutCutoffDay = (now: Date): string => now.toISOString().slice(0, 10)

export interface LifecyclePassResult { checkedOut: number; skipped: number; failed: number }

/**
 * The scheduled lifecycle jobs of the Admin booking module (ADR 0039, Phase 6E). Today: automatic Checked-out. Off unless `BOOKING_LIFECYCLE_JOB_ENABLED=true`, and it then
 * needs the booking module's own database credential and nothing broader.
 *
 * It decides nothing about status itself: every move goes through `transitionBooking` (the one writer), as the named system action `markCheckedOut`, so the move is
 * compare-and-set, leaves an immutable `BookingEvent` (actor SYSTEM) and is idempotent per booking. A booking that changed between the read and the move (a person cancelled it,
 * an amendment was requested) is a stale status, which is skipped, never forced. It moves no money (a Checked-out booking emits no finance event) and sends nothing.
 *
 * Not built here: closing terminal bookings after the dispute window. The window length is an open owner question (spec "Open questions"), so no default is invented.
 */
@Injectable()
export class BookingLifecycleJobs implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BookingLifecycleJobs.name)
  private timer?: NodeJS.Timeout
  private running = false

  constructor(private readonly db: BookingOpsDatabase, @Optional() private readonly env: Record<string, string | undefined> = process.env) {}

  onModuleInit(): void {
    if (this.env.BOOKING_LIFECYCLE_JOB_ENABLED !== 'true') return
    if (!this.db.configured()) throw new Error('BOOKING_LIFECYCLE_JOB_ENABLED requires BOOKING_OPS_DATABASE_URL (a different credential from DATABASE_URL)')
    const interval = Number(this.env.BOOKING_LIFECYCLE_JOB_INTERVAL_MS ?? DEFAULT_INTERVAL_MS)
    if (!Number.isInteger(interval) || interval < MIN_INTERVAL_MS) throw new Error(`BOOKING_LIFECYCLE_JOB_INTERVAL_MS must be an integer >= ${MIN_INTERVAL_MS}`)
    this.timer = setInterval(() => { void this.runOnce() }, interval)
    this.timer.unref()
    this.logger.log(`Booking lifecycle job enabled every ${interval}ms`)
  }
  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined }

  /** One pass over every tenant with a booking due. Never overlaps itself. A tenant's failure never stops the others. */
  async runOnce(clock: () => Date = () => new Date()): Promise<LifecyclePassResult> {
    const total: LifecyclePassResult = { checkedOut: 0, skipped: 0, failed: 0 }
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
    } catch (error) { this.logger.error(`Checked-out job could not list due tenants: ${error instanceof Error ? error.name : 'unknown error'}`) } finally { this.running = false }
    if (total.checkedOut || total.failed) this.logger.log(`Checked-out pass: ${total.checkedOut} moved, ${total.skipped} skipped (changed meanwhile), ${total.failed} failed`)
    return total
  }

  /** Up to a batch for one tenant; the rest are picked up by the next pass. One transaction per booking, so one failure never rolls back or blocks another. */
  private async checkOutTenant(tenantId: string, now: Date): Promise<LifecyclePassResult> {
    const today = new Date(`${checkoutCutoffDay(now)}T00:00:00.000Z`)
    const due = await this.db.withTenant(tenantId, (tx) => tx.booking.findMany({ where: { tenantId, status: 'CONFIRMED', closedAt: null, checkOut: { lt: today } }, orderBy: [{ checkOut: 'asc' }, { id: 'asc' }], take: BATCH, select: { id: true } }))
    const result: LifecyclePassResult = { checkedOut: 0, skipped: 0, failed: 0 }
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
}
