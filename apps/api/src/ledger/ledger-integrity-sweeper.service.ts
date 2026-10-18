import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common'
import { LedgerAuditDatabase } from './ledger-audit-database'
import { DEFAULT_RUN_HOUR_UTC, assertRunHour, isRunDue, runDateUtc } from './integrity-schedule'
import { LedgerIntegrityRunsService, type RunOutcome } from './ledger-integrity-runs.service'

const MIN_INTERVAL_MS = 5_000
const DEFAULT_INTERVAL_MS = 300_000

type Env = Record<string, string | undefined>

/**
 * Takes the nightly ledger integrity report for every active tenant (ADR 0064).
 *
 * Disabled unless `LEDGER_INTEGRITY_SWEEP_ENABLED=true`. It then requires `LEDGER_AUDIT_DATABASE_URL`, the credential of the restricted ledger-audit
 * role, and refuses to start if it equals the HTTP `DATABASE_URL` or is not a restricted login. Every few minutes it checks each tenant: from the
 * configured UTC hour, a tenant with no run for today's date gets one, so a missed night is caught up when the service returns. Passes never overlap,
 * a failing tenant is logged (error name only) and does not stop the others, and several API instances are safe (advisory lock plus unique key).
 * A FAIL result is logged as an error line; the result itself is in Admin, Finance, Ledger integrity.
 */
@Injectable()
export class LedgerIntegritySweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LedgerIntegritySweeper.name)
  private timer?: NodeJS.Timeout
  private running = false
  private enabled = false
  private hour = DEFAULT_RUN_HOUR_UTC
  /** Tenants already covered for `doneDate`, so a tick costs no query for them. Reset when the UTC date changes. */
  private doneDate = ''
  private done = new Set<string>()
  private readonly env: Env

  constructor(private readonly audit: LedgerAuditDatabase, private readonly runs: LedgerIntegrityRunsService, @Optional() env?: Env) { this.env = env ?? process.env }

  async onModuleInit(): Promise<void> {
    if (this.env.LEDGER_INTEGRITY_SWEEP_ENABLED !== 'true') return
    if (!this.env.LEDGER_AUDIT_DATABASE_URL) throw new Error('LEDGER_INTEGRITY_SWEEP_ENABLED requires LEDGER_AUDIT_DATABASE_URL')
    if (this.env.LEDGER_AUDIT_DATABASE_URL === this.env.DATABASE_URL) throw new Error('LEDGER_AUDIT_DATABASE_URL must be a different credential from the HTTP DATABASE_URL')
    this.hour = assertRunHour(Number(this.env.LEDGER_INTEGRITY_RUN_HOUR_UTC ?? DEFAULT_RUN_HOUR_UTC))
    const interval = Number(this.env.LEDGER_INTEGRITY_CHECK_INTERVAL_MS ?? DEFAULT_INTERVAL_MS)
    if (!Number.isInteger(interval) || interval < MIN_INTERVAL_MS) throw new Error(`LEDGER_INTEGRITY_CHECK_INTERVAL_MS must be an integer >= ${MIN_INTERVAL_MS}`)
    await this.audit.assertReady() // a privileged credential stops startup (P0-01)
    this.enabled = true
    this.timer = setInterval(() => { void this.runOnce() }, interval)
    this.timer.unref()
    this.logger.log(`Nightly ledger integrity run enabled: daily from ${String(this.hour).padStart(2, '0')}:00 UTC, checked every ${interval}ms`)
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.enabled = false
  }

  /** One pass over active tenants. Returns how many runs were recorded; never overlaps itself. */
  async runOnce(now = new Date()): Promise<number> {
    if (!this.enabled || this.running) return 0
    const date = runDateUtc(now)
    if (this.doneDate !== date) { this.doneDate = date; this.done = new Set() }
    if (!isRunDue(now, this.hour, false)) return 0
    this.running = true
    let recorded = 0
    let failedTenants = 0
    try {
      for (const tenantId of await this.audit.listActiveTenantIds()) {
        if (this.done.has(tenantId)) continue
        try {
          const outcome: RunOutcome = await this.runs.recordRun(tenantId, now)
          if (outcome === 'busy') continue // another instance is taking it; look again next tick
          this.done.add(tenantId)
          if (outcome === 'recorded') {
            recorded += 1
            const latest = (await this.runs.list(tenantId, now)).latest
            if (latest && latest.status !== 'PASS') this.logger[latest.status === 'FAIL' ? 'error' : 'warn'](`Ledger integrity ${latest.status} for tenant ${tenantId}: errors=${latest.errors} warnings=${latest.warnings}`)
          }
        } catch (error) {
          failedTenants += 1
          this.logger.error(`Ledger integrity run failed for tenant ${tenantId}: ${error instanceof Error ? error.name : 'unknown error'}`)
        }
      }
    } catch (error) {
      this.logger.error(`Ledger integrity run could not list tenants: ${error instanceof Error ? error.name : 'unknown error'}`)
      return recorded
    } finally {
      this.running = false
    }
    if (recorded > 0 || failedTenants > 0) this.logger.log(`Ledger integrity pass: recorded=${recorded} failedTenants=${failedTenants}`)
    return recorded
  }
}
