import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import type { LedgerIntegrityReport } from '@bedbanks/contracts'
import { PrismaService } from '../database/prisma.service'
import { OperationsLedgerIntegrityService } from './operations-ledger-integrity.service'

const DAY_MS = 86_400_000
const MIN_INTERVAL_MS = 3_600_000

export interface LedgerIntegrityRuntime {
  listActiveTenantIds(): Promise<string[]>
  report(tenantId: string): Promise<LedgerIntegrityReport>
  close(): Promise<void>
  verify?(): Promise<void>
}
export interface LedgerIntegrityPass { tenants: number; clean: number; warnings: number; issues: number; incomplete: number; failed: number }

type Env = Record<string, string | undefined>

/**
 * The daily ledger reconciliation run (ADR 0069), as a bedbank finance team runs it: every active tenant, every day, with every break raised.
 * Read-only: it writes nothing (no finding, no audit event, no correction), so a failure here can never move money.
 *
 * It runs only when explicitly enabled AND given its own credential (`LEDGER_INTEGRITY_DATABASE_URL`, a restricted login that can read the
 * ledger, wallets, funding receipts, bookings and cancellations under RLS). Same rules as the hold-expiry sweeper (ADR 0005): disabled by
 * default, never the HTTP credential, identity-checked at startup, never overlapping itself. ISSUES is logged at error level with tenant id,
 * counts and rule codes only (no amounts, names or references), which is what the log alarm watches; WARNINGS and INCOMPLETE at warn level.
 */
@Injectable()
export class LedgerIntegrityMonitor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LedgerIntegrityMonitor.name)
  private runtime?: LedgerIntegrityRuntime
  private timer?: NodeJS.Timeout
  private running = false

  constructor(
    private readonly env: Env = process.env,
    private readonly createRuntime: (databaseUrl: string) => LedgerIntegrityRuntime = defaultRuntime,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.env.LEDGER_INTEGRITY_MONITOR_ENABLED !== 'true') return
    const url = this.env.LEDGER_INTEGRITY_DATABASE_URL
    if (!url) throw new Error('LEDGER_INTEGRITY_MONITOR_ENABLED requires LEDGER_INTEGRITY_DATABASE_URL')
    if (url === this.env.DATABASE_URL) throw new Error('LEDGER_INTEGRITY_DATABASE_URL must be a different credential from the HTTP DATABASE_URL')
    const interval = Number(this.env.LEDGER_INTEGRITY_MONITOR_INTERVAL_MS ?? DAY_MS)
    if (!Number.isInteger(interval) || interval < MIN_INTERVAL_MS) throw new Error(`LEDGER_INTEGRITY_MONITOR_INTERVAL_MS must be an integer >= ${MIN_INTERVAL_MS}`)
    this.runtime = this.createRuntime(url)
    try { await this.runtime.verify?.() } catch (error) { await this.runtime.close().catch(() => undefined); this.runtime = undefined; throw error }
    this.timer = setInterval(() => { void this.runOnce() }, interval)
    this.timer.unref()
    this.logger.log(`Ledger integrity monitor enabled every ${interval}ms`)
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    await this.runtime?.close()
    this.runtime = undefined
  }

  /** One pass over every active tenant. Never overlaps itself; one tenant failing does not stop the others. */
  async runOnce(): Promise<LedgerIntegrityPass> {
    const pass: LedgerIntegrityPass = { tenants: 0, clean: 0, warnings: 0, issues: 0, incomplete: 0, failed: 0 }
    const runtime = this.runtime
    if (!runtime || this.running) return pass
    this.running = true
    try {
      for (const tenantId of await runtime.listActiveTenantIds()) {
        pass.tenants += 1
        try {
          const r = await runtime.report(tenantId)
          const codes = r.counts.byCode.map(c => `${c.code}:${c.count}`).join(',')
          if (r.verdict === 'ISSUES') { pass.issues += 1; this.logger.error(`Ledger integrity ISSUES tenant=${tenantId} critical=${r.counts.critical} warning=${r.counts.warning} codes=${codes}`) }
          else if (r.verdict === 'WARNINGS') { pass.warnings += 1; this.logger.warn(`Ledger integrity WARNINGS tenant=${tenantId} warning=${r.counts.warning} codes=${codes}`) }
          else if (r.verdict === 'INCOMPLETE') { pass.incomplete += 1; this.logger.warn(`Ledger integrity INCOMPLETE tenant=${tenantId} entries>${r.scan.entryLimit}`) }
          else pass.clean += 1
        } catch (error) {
          pass.failed += 1
          this.logger.error(`Ledger integrity check failed tenant=${tenantId} error=${error instanceof Error ? error.name : 'UnknownError'}`)
        }
      }
    } catch (error) {
      pass.failed += 1
      this.logger.error(`Ledger integrity could not list tenants: ${error instanceof Error ? error.name : 'UnknownError'}`)
    } finally {
      this.running = false
    }
    this.logger.log(`Ledger integrity pass: tenants=${pass.tenants} clean=${pass.clean} warnings=${pass.warnings} issues=${pass.issues} incomplete=${pass.incomplete} failed=${pass.failed}`)
    return pass
  }
}

function defaultRuntime(databaseUrl: string): LedgerIntegrityRuntime {
  const prisma = new PrismaService({ datasourceUrl: databaseUrl })
  const integrity = new OperationsLedgerIntegrityService(prisma)
  return {
    listActiveTenantIds: async () => (await prisma.tenant.findMany({ where: { status: 'ACTIVE' }, select: { id: true } })).map(tenant => tenant.id),
    report: tenantId => integrity.report(tenantId, {}),
    close: () => prisma.$disconnect(),
    verify: () => prisma.assertRestrictedRuntimeRole('Ledger integrity monitor'),
  }
}
