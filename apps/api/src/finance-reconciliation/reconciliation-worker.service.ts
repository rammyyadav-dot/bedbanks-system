import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common'
import { ReconciliationRunner } from './reconciliation-runner.service'
import { ReconciliationStore } from './reconciliation-store'

const MIN_INTERVAL_MS = 5_000
const DEFAULT_INTERVAL_MS = 30_000

type Env = Record<string, string | undefined>

/**
 * The background worker of the reconciliation engine (ADR 0070). Disabled unless FINANCE_RECONCILIATION_WORKER_ENABLED=true.
 *
 * It polls `fbeds_reconciliation_due_tenants()` (tenant ids only, SECURITY DEFINER) and drains each tenant's queued runs through ReconciliationRunner, which
 * does all tenant-scoped work under that tenant's RLS context. A run is also kicked right after it is requested, so an operator does not wait a full interval.
 * Overlap is impossible: a pass never starts while one is running, and the claim is a conditional update, so a second API instance cannot double-process a run.
 * Why not BullMQ or Temporal: the repository has no Redis job infrastructure and the run table is already the durable, tenant-isolated, audited queue; adding a
 * second queue would add an unreviewed dependency and a second source of truth for "did this run happen". The decision is recorded in ADR 0070.
 */
@Injectable()
export class ReconciliationWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReconciliationWorker.name)
  private timer?: NodeJS.Timeout
  private running = false
  private readonly pendingKicks = new Set<string>()

  constructor(private readonly store: ReconciliationStore, private readonly runner: ReconciliationRunner, @Optional() private readonly env: Env = process.env) {}

  private enabled = () => this.env.FINANCE_RECONCILIATION_WORKER_ENABLED === 'true' && this.env.FINANCE_RECONCILIATION_ENABLED === 'true'

  onModuleInit(): void {
    if (!this.enabled()) return
    const interval = Number(this.env.FINANCE_RECONCILIATION_WORKER_INTERVAL_MS ?? DEFAULT_INTERVAL_MS)
    if (!Number.isInteger(interval) || interval < MIN_INTERVAL_MS) throw new Error(`FINANCE_RECONCILIATION_WORKER_INTERVAL_MS must be an integer >= ${MIN_INTERVAL_MS}`)
    this.timer = setInterval(() => { void this.runOnce() }, interval)
    this.timer.unref()
    this.logger.log(`Reconciliation worker enabled every ${interval}ms`)
  }

  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined }

  /** Drain one tenant soon. A no-op when the worker is disabled. */
  kick(tenantId: string): void {
    if (!this.enabled() || this.pendingKicks.has(tenantId)) return
    this.pendingKicks.add(tenantId)
    setImmediate(() => {
      this.runner.drain(tenantId).catch((error) => this.logger.error(`Reconciliation kick failed for tenant ${tenantId}: ${error instanceof Error ? error.name : 'unknown error'}`)).finally(() => this.pendingKicks.delete(tenantId))
    })
  }

  /** One pass over tenants with work; never overlaps itself. A failing tenant is logged and does not stop the others. Returns runs processed. */
  async runOnce(): Promise<number> {
    if (this.running) return 0
    this.running = true
    let processed = 0
    try {
      for (const tenantId of await this.store.dueTenantIds()) {
        try { processed += await this.runner.drain(tenantId) } catch (error) {
          this.logger.error(`Reconciliation pass failed for tenant ${tenantId}: ${error instanceof Error ? error.name : 'unknown error'}`)
        }
      }
    } catch (error) {
      this.logger.error(`Reconciliation worker could not list due tenants: ${error instanceof Error ? error.name : 'unknown error'}`)
    } finally { this.running = false }
    if (processed > 0) this.logger.log(`Reconciliation pass: processed=${processed}`)
    return processed
  }
}
