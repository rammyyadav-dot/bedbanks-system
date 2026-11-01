import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common'
import { BookingFinancePostingDatabase } from './booking-finance-posting.database'
import { BookingFinancePostingService } from './booking-finance-posting.service'

const MIN_INTERVAL_MS = 5_000
const DEFAULT_INTERVAL_MS = 30_000

type Env = Record<string, string | undefined>

/**
 * The background worker of the booking Finance consumer (ADR 0076). Disabled unless BOOKING_FINANCE_POSTING_ENABLED=true and BOOKING_FINANCE_POSTING_WORKER_ENABLED=true.
 *
 * It polls `fbeds_finance_posting_due_tenants()` (tenant ids only, SECURITY DEFINER) and drains each tenant under that tenant's RLS context. Overlap is impossible inside
 * one process (a pass never starts while one is running) and harmless across processes: a posting is unique per event, a booking's events are serialized by an advisory lock,
 * and every ledger key is unique per account. The event table is already the durable, tenant-isolated, ordered queue, so no second queue is added (as for ADR 0070).
 */
@Injectable()
export class BookingFinancePostingWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BookingFinancePostingWorker.name)
  private timer?: NodeJS.Timeout
  private running = false

  constructor(private readonly db: BookingFinancePostingDatabase, private readonly service: BookingFinancePostingService, @Optional() private readonly env: Env = process.env) {}

  private enabled = () => this.env.BOOKING_FINANCE_POSTING_WORKER_ENABLED === 'true' && this.env.BOOKING_FINANCE_POSTING_ENABLED === 'true'

  onModuleInit(): void {
    if (!this.enabled()) return
    if (!this.db.configured()) throw new Error('BOOKING_FINANCE_POSTING_DATABASE_URL must be set (and differ from DATABASE_URL) when the booking finance posting worker is enabled')
    const interval = Number(this.env.BOOKING_FINANCE_POSTING_WORKER_INTERVAL_MS ?? DEFAULT_INTERVAL_MS)
    if (!Number.isInteger(interval) || interval < MIN_INTERVAL_MS) throw new Error(`BOOKING_FINANCE_POSTING_WORKER_INTERVAL_MS must be an integer >= ${MIN_INTERVAL_MS}`)
    this.timer = setInterval(() => { void this.runOnce() }, interval)
    this.timer.unref()
    this.logger.log(`Booking finance posting worker enabled every ${interval}ms`)
  }

  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined }

  /** One pass over tenants with unfinished events; never overlaps itself. A failing tenant is logged and does not stop the others. Returns events posted. */
  async runOnce(): Promise<number> {
    if (this.running) return 0
    this.running = true
    let posted = 0
    let review = 0
    try {
      for (const tenantId of await this.db.dueTenantIds()) {
        try {
          const summary = await this.service.drain(tenantId)
          posted += summary.posted
          review += summary.reviewRequired
        } catch (error) {
          this.logger.error(`Booking finance posting pass failed for tenant ${tenantId}: ${error instanceof Error ? error.name : 'unknown error'}`)
        }
      }
    } catch (error) {
      this.logger.error(`Booking finance posting worker could not list due tenants: ${error instanceof Error ? error.name : 'unknown error'}`)
    } finally { this.running = false }
    if (posted > 0 || review > 0) this.logger.log(`Booking finance posting pass: posted=${posted} reviewRequired=${review}`)
    return posted
  }
}
