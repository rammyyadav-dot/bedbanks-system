import { BadRequestException, ConflictException, Injectable, ServiceUnavailableException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import type { FinancePeriodClose } from '@prisma/client'
import {
  FINANCE_PERIOD_FAILURE, type FinancePeriodCloseRequest, type FinancePeriodCurrencyTotals, type FinancePeriodPreview, type FinancePeriodView, type Paged,
} from '@bedbanks/contracts'
import { buildPeriodTotals, monthRange, periodBlockers, type PeriodCurrencyTotals, type PeriodRange } from '@bedbanks/money'
import { PrismaService } from '../database/prisma.service'
import { OperationsLedgerIntegrityService } from '../admin-operations/operations-ledger-integrity.service'
import { sanitizeAuditPayload } from '../agent/audit-payload'
import { pageParams, paged } from '../admin-operations/query-params'

const CONTROL = /[\u0000-\u001f\u007f]/
const refuse = (status: 400 | 409 | 503, message: string, code: string, details?: Record<string, unknown>) => {
  const body = { message, code, ...(details && { details }) }
  if (status === 409) return new ConflictException(body)
  if (status === 503) return new ServiceUnavailableException(body)
  return new BadRequestException(body)
}
const day = (d: Date) => d.toISOString().slice(0, 10)
const monthOf = (d: Date) => d.toISOString().slice(0, 7)

const totalsView = (totals: readonly PeriodCurrencyTotals[]): FinancePeriodCurrencyTotals[] => totals.map(t => ({
  currency: t.currency, entries: t.entries, openingMinor: t.openingMinor.toString(), movementMinor: t.movementMinor.toString(), closingMinor: t.closingMinor.toString(),
  byType: t.byType.map(b => ({ type: b.type, entries: b.entries, sumMinor: b.sumMinor.toString() })),
}))

/**
 * Finance period close (ADR 0101). Reads need finance.read; closing needs finance.period.close and FINANCE_PERIOD_CLOSE_ENABLED=true (else 503).
 *
 * Closing runs the ledger integrity report (R1 to R4), refuses on a critical finding or an incomplete scan, then in one transaction under a per-tenant advisory lock re-checks that
 * the month is still the next to close, computes the per-currency control totals from the ledger (opening + movement = closing, or it refuses), and stores them with the hash chain
 * heads. The database then refuses any ledger entry dated inside the period. Nothing is posted and no balance changes; a closed period is never reopened.
 */
@Injectable()
export class FinancePeriodService {
  /** Overridable in tests; never injected. */
  clock: () => Date = () => new Date()
  private readonly integrity: OperationsLedgerIntegrityService

  constructor(private readonly prisma: PrismaService) {
    this.integrity = new OperationsLedgerIntegrityService(prisma)
  }

  private assertEnabled(env: NodeJS.ProcessEnv = process.env) {
    if (env.FINANCE_PERIOD_CLOSE_ENABLED !== 'true') throw refuse(503, 'Finance period close is not enabled on this deployment.', FINANCE_PERIOD_FAILURE.disabled)
  }

  private rangeOf(month: unknown): PeriodRange {
    const range = typeof month === 'string' ? monthRange(month.trim()) : null
    if (!range) throw refuse(400, 'month must be a calendar month written YYYY-MM', FINANCE_PERIOD_FAILURE.invalid)
    return range
  }

  private view(r: FinancePeriodClose): FinancePeriodView {
    return {
      id: r.id, month: monthOf(r.periodStart), periodStart: day(r.periodStart), periodEnd: day(r.periodEnd), integrityVerdict: r.integrityVerdict as 'CLEAN' | 'WARNINGS', warningCount: r.warningCount,
      totals: r.totals as unknown as FinancePeriodCurrencyTotals[], chainHeads: r.chainHeads as unknown as FinancePeriodView['chainHeads'], note: r.note, closedById: r.closedById, closedAt: r.closedAt.toISOString(),
    }
  }

  async list(tenantId: string, query: Record<string, unknown>): Promise<Paged<FinancePeriodView>> {
    const page = pageParams(query)
    return this.prisma.withTenant(tenantId, async (tx) => {
      const [rows, total] = await Promise.all([
        tx.financePeriodClose.findMany({ where: { tenantId }, orderBy: { periodStart: 'desc' }, skip: page.skip, take: page.take }),
        tx.financePeriodClose.count({ where: { tenantId } }),
      ])
      return paged(rows.map(r => this.view(r)), page, total)
    })
  }

  /** The control totals of a range, read from the ledger inside the caller's transaction. */
  private async totals(tx: Prisma.TransactionClient, tenantId: string, range: PeriodRange): Promise<PeriodCurrencyTotals[]> {
    const [opening, closing, movements] = await Promise.all([
      tx.ledgerEntry.groupBy({ by: ['currency'], where: { tenantId, immutableAt: { lt: range.start } }, _sum: { amountMinor: true } }),
      tx.ledgerEntry.groupBy({ by: ['currency'], where: { tenantId, immutableAt: { lt: range.end } }, _sum: { amountMinor: true } }),
      tx.ledgerEntry.groupBy({ by: ['currency', 'type'], where: { tenantId, immutableAt: { gte: range.start, lt: range.end } }, _sum: { amountMinor: true }, _count: { _all: true } }),
    ])
    return buildPeriodTotals({
      opening: opening.map(g => ({ currency: g.currency, sumMinor: g._sum.amountMinor ?? 0n })),
      closing: closing.map(g => ({ currency: g.currency, sumMinor: g._sum.amountMinor ?? 0n })),
      movements: movements.map(g => ({ currency: g.currency, type: g.type, entries: g._count._all, sumMinor: g._sum.amountMinor ?? 0n })),
    })
  }

  private async state(tx: Prisma.TransactionClient, tenantId: string, range: PeriodRange) {
    const [last, existing, earliest] = await Promise.all([
      tx.financePeriodClose.findFirst({ where: { tenantId }, orderBy: { periodEnd: 'desc' }, select: { periodEnd: true } }),
      tx.financePeriodClose.findFirst({ where: { tenantId, periodStart: range.start }, select: { id: true } }),
      tx.ledgerEntry.findFirst({ where: { tenantId }, orderBy: { immutableAt: 'asc' }, select: { immutableAt: true } }),
    ])
    return { lastClosedEnd: last?.periodEnd ?? null, alreadyClosed: existing !== null, earliestEntryAt: earliest?.immutableAt ?? null }
  }

  async preview(tenantId: string, query: Record<string, unknown>): Promise<FinancePeriodPreview> {
    const range = this.rangeOf(query.month)
    const now = this.clock()
    const report = await this.integrity.report(tenantId, {})
    return this.prisma.withTenant(tenantId, async (tx) => {
      const state = await this.state(tx, tenantId, range)
      const blockers = periodBlockers({ range, now, verdict: report.verdict, ...state })
      return {
        month: range.month, periodStart: day(range.start), periodEnd: day(range.end), closable: blockers.length === 0, blockers, integrityVerdict: report.verdict,
        integrityCriticalCount: report.counts.critical, integrityWarningCount: report.counts.warning, totals: totalsView(await this.totals(tx, tenantId, range)), generatedAt: now.toISOString(),
      }
    })
  }

  async close(tenantId: string, userId: string, body: unknown): Promise<FinancePeriodView> {
    this.assertEnabled()
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw refuse(400, 'A request body is required', FINANCE_PERIOD_FAILURE.invalid)
    const b = body as Partial<FinancePeriodCloseRequest>
    const range = this.rangeOf(b.month)
    const note = b.note === undefined || b.note === null ? null : typeof b.note === 'string' ? b.note.trim() : ''
    if (note !== null && (note.length < 3 || note.length > 500 || CONTROL.test(note))) throw refuse(400, 'note must be 3 to 500 printable characters', FINANCE_PERIOD_FAILURE.invalid)

    const now = this.clock()
    const report = await this.integrity.report(tenantId, {})
    if (report.verdict === 'ISSUES' || report.verdict === 'INCOMPLETE') {
      throw refuse(409, `The ledger integrity report is ${report.verdict}; resolve it before closing a period.`, FINANCE_PERIOD_FAILURE.blocked, { blockers: [report.verdict === 'ISSUES' ? 'INTEGRITY_ISSUES' : 'INTEGRITY_INCOMPLETE'] })
    }
    try {
      return await this.prisma.withTenant(tenantId, async (tx) => {
        await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`period-close:${tenantId}`}, 0))`)
        const state = await this.state(tx, tenantId, range)
        const blockers = periodBlockers({ range, now, verdict: report.verdict, ...state })
        if (blockers.length > 0) throw refuse(409, `This month cannot be closed: ${blockers.join(', ')}`, FINANCE_PERIOD_FAILURE.blocked, { blockers })
        let totals: PeriodCurrencyTotals[]
        try { totals = await this.totals(tx, tenantId, range) } catch { throw refuse(409, 'The ledger changed while the period was being closed; try again.', FINANCE_PERIOD_FAILURE.changed) }
        const view = totalsView(totals)
        const created = await tx.financePeriodClose.create({ data: {
          tenantId, periodStart: range.start, periodEnd: range.end, integrityVerdict: report.verdict, warningCount: report.counts.warning, totals: view as unknown as Prisma.InputJsonValue,
          chainHeads: report.chainHeads as unknown as Prisma.InputJsonValue, note, closedById: userId,
        } })
        await tx.auditEvent.create({ data: { tenantId, userId, actorType: 'USER', action: 'finance.period.closed', entityType: 'finance_period_close', entityId: created.id, payload: sanitizeAuditPayload({
          month: range.month, integrityVerdict: report.verdict, warningCount: report.counts.warning, totals: view.map(t => ({ currency: t.currency, entries: t.entries, openingMinor: t.openingMinor, movementMinor: t.movementMinor, closingMinor: t.closingMinor })),
        }) } })
        return this.view(created)
      })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw refuse(409, 'This month is already closed', FINANCE_PERIOD_FAILURE.blocked, { blockers: ['PERIOD_ALREADY_CLOSED'] })
      throw error
    }
  }
}
