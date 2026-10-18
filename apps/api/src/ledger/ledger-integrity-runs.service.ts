import { Injectable, NotFoundException, Optional } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import type { LedgerIntegrityRunDetail, LedgerIntegrityRunsView, LedgerIntegrityRunSummary, LedgerIntegrityStatus, LedgerIntegrityView } from '@bedbanks/contracts'
import { PrismaService } from '../database/prisma.service'
import { guardedRead } from '../admin-operations/operations-read'
import { idParam } from '../admin-operations/query-params'
import { LedgerAuditDatabase } from './ledger-audit-database'
import { buildLedgerIntegrityReport } from './ledger-integrity-report'
import { DEFAULT_RUN_HOUR_UTC, OVERDUE_GRACE_HOURS, assertRunHour, expectedRunDate, runDateUtc, scheduleState } from './integrity-schedule'

export const RUN_HISTORY_LIMIT = 60
export type RunOutcome = 'recorded' | 'exists' | 'busy'

type Tx = Prisma.TransactionClient
type RunRow = { id: string; runDate: Date; status: string; errors: number; warnings: number; truncated: boolean; accountsScanned: number; bookingsScanned: number; entriesScanned: number; createdAt: Date }

const SUMMARY = { id: true, runDate: true, status: true, errors: true, warnings: true, truncated: true, accountsScanned: true, bookingsScanned: true, entriesScanned: true, createdAt: true } as const

export const summaryOf = (r: RunRow): LedgerIntegrityRunSummary => ({
  id: r.id, runDate: r.runDate.toISOString().slice(0, 10), status: r.status as LedgerIntegrityStatus, errors: r.errors, warnings: r.warnings, truncated: r.truncated,
  accountsScanned: r.accountsScanned, bookingsScanned: r.bookingsScanned, entriesScanned: r.entriesScanned, createdAt: r.createdAt.toISOString(),
})

/**
 * Nightly ledger integrity runs (ADR 0064): records one immutable result per tenant per UTC date, and serves the history to Admin.
 *
 * Writing needs the restricted ledger-audit credential, so `recordRun` is only ever called by the scheduler. Reading uses the same credential
 * when configured (the strict API role has no ledger access) and otherwise the ordinary client, which answers the typed 503 when not readable.
 */
@Injectable()
export class LedgerIntegrityRunsService {
  private readonly env: Record<string, string | undefined>

  constructor(private readonly prisma: PrismaService, private readonly audit: LedgerAuditDatabase, @Optional() env?: Record<string, string | undefined>) { this.env = env ?? process.env }

  runHourUtc(): number { return assertRunHour(Number(this.env.LEDGER_INTEGRITY_RUN_HOUR_UTC ?? DEFAULT_RUN_HOUR_UTC)) }
  schedulerEnabled(): boolean { return this.env.LEDGER_INTEGRITY_SWEEP_ENABLED === 'true' && this.audit.configured() }

  private read<T>(tenantId: string, work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.audit.configured() ? this.audit.withTenant(tenantId, work) : guardedRead(() => this.prisma.withTenant(tenantId, work))
  }

  /** Whether tonight's run already exists for the tenant (cheap check the scheduler makes each tick). */
  hasRun(tenantId: string, runDate: string): Promise<boolean> {
    return this.audit.withTenant(tenantId, async tx => (await tx.ledgerIntegrityRun.count({ where: { tenantId, runDate: new Date(`${runDate}T00:00:00.000Z`) } })) > 0)
  }

  /**
   * Takes the report and stores it, once per tenant per date. Idempotent and safe across several API instances: a per-tenant-date advisory lock
   * makes a second instance skip ('busy'), and the unique key makes a repeat a no-op ('exists'). The run and its SYSTEM audit event are one transaction.
   */
  async recordRun(tenantId: string, now: Date): Promise<RunOutcome> {
    const runDate = runDateUtc(now)
    try {
      return await this.audit.withTenant(tenantId, async tx => {
        const [{ locked }] = await tx.$queryRaw<Array<{ locked: boolean }>>(Prisma.sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${`ledger-integrity:${tenantId}:${runDate}`}, 0)) AS locked`)
        if (!locked) return 'busy' as const
        if (await tx.ledgerIntegrityRun.findUnique({ where: { tenantId_runDate: { tenantId, runDate: new Date(`${runDate}T00:00:00.000Z`) } }, select: { id: true } })) return 'exists' as const
        const report = await buildLedgerIntegrityReport(tx, tenantId, now)
        const run = await tx.ledgerIntegrityRun.create({
          data: {
            tenantId, runDate: new Date(`${runDate}T00:00:00.000Z`), status: report.status, errors: report.counts.errors, warnings: report.counts.warnings, truncated: report.truncated,
            accountsScanned: report.scanned.accounts, bookingsScanned: report.scanned.bookings, entriesScanned: report.scanned.entries, report: report as unknown as Prisma.InputJsonValue,
          },
          select: { id: true },
        })
        await tx.auditEvent.create({
          data: {
            tenantId, actorType: 'SYSTEM', action: 'finance.integrity.run', entityType: 'ledger_integrity_run', entityId: run.id,
            payload: { runDate, status: report.status, errors: report.counts.errors, warnings: report.counts.warnings, truncated: report.truncated },
          },
        })
        return 'recorded' as const
      })
    } catch (error) {
      // Lost a race on the unique key, or the snapshot could not be taken because another writer got there first: the night is covered either way.
      if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === 'P2002' || error.code === 'P2034')) return 'exists'
      throw error
    }
  }

  async list(tenantId: string, now = new Date()): Promise<LedgerIntegrityRunsView> {
    const hour = this.runHourUtc()
    const rows = await this.read(tenantId, tx => tx.ledgerIntegrityRun.findMany({ where: { tenantId }, orderBy: { runDate: 'desc' }, take: RUN_HISTORY_LIMIT, select: SUMMARY }))
    const runs = rows.map(summaryOf)
    return {
      scheduler: { enabled: this.schedulerEnabled(), runHourUtc: hour, overdueAfterHours: OVERDUE_GRACE_HOURS },
      schedule: scheduleState(now, hour, runs[0]?.runDate ?? null), expectedRunDate: expectedRunDate(now, hour), latest: runs[0] ?? null, runs,
    }
  }

  async get(tenantId: string, runId: string): Promise<LedgerIntegrityRunDetail> {
    const id = idParam('runId', runId)
    if (!id) throw new NotFoundException('Run not found')
    const row = await this.read(tenantId, tx => tx.ledgerIntegrityRun.findFirst({ where: { id, tenantId }, select: { ...SUMMARY, report: true } }))
    if (!row) throw new NotFoundException('Run not found')
    return { run: summaryOf(row), report: row.report as unknown as LedgerIntegrityView }
  }
}
