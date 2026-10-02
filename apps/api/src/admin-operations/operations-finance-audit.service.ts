import { Injectable } from '@nestjs/common'
import {
  SUMMARY_WINDOW_DEFAULT_DAYS, SUMMARY_WINDOW_MAX_DAYS,
  type AuditSummary, type FinanceCurrencySummary, type FinanceSummary, type LedgerEntryType, type LedgerWindowSummary, type SummaryWindow,
} from '@bedbanks/contracts'
import { PrismaService } from '../database/prisma.service'
import { day, iso, sectionRead } from './operations-read'
import { endOfDay, intParam } from './query-params'

const LEDGER_TYPES: readonly LedgerEntryType[] = ['CREDIT', 'DEBIT', 'HOLD', 'RELEASE', 'REFUND']
const DAY_MS = 86_400_000

/**
 * Finance and audit summaries for the Admin dashboard. Read-only, tenant-scoped, a fixed number of aggregate queries.
 * Money is never summed across currencies. The runtime database role may not read the ledger or audit events (ADR 0013):
 * that is reported as an explicit unavailable section, never as zeros.
 */
@Injectable()
export class OperationsFinanceAuditService {
  /** Overridable in tests; never injected. */
  clock: () => Date = () => new Date()

  constructor(private readonly prisma: PrismaService) {}

  private window(query: Record<string, unknown>): SummaryWindow & { start: Date; end: Date } {
    const days = intParam('days', query.days, 1, SUMMARY_WINDOW_MAX_DAYS) ?? SUMMARY_WINDOW_DEFAULT_DAYS
    const now = this.clock()
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    const start = new Date(today.getTime() - (days - 1) * DAY_MS)
    return { from: day(start), to: day(today), days, start, end: endOfDay(today) }
  }

  async financeSummary(tenantId: string, query: Record<string, unknown>): Promise<FinanceSummary> {
    const win = this.window(query)
    const [wallets, ledger] = await Promise.all([this.walletSection(tenantId), this.ledgerSection(tenantId, win)])
    return {
      generatedAt: this.clock().toISOString(),
      window: { from: win.from, to: win.to, days: win.days },
      definitions: {
        balance: 'The sum of every ledger entry for the wallet, as the finance service computes it.',
        availableCredit: 'Credit limit plus balance. Currencies are reported separately and never added together.',
        overdrawn: 'A wallet whose available credit is below zero. This should not happen; investigate any.',
        ledgerWindow: 'Ledger entries whose immutable timestamp falls in the window; amounts are the stored signed values per entry type.',
      },
      wallets, ledger,
    }
  }

  private walletSection(tenantId: string): Promise<FinanceSummary['wallets']> {
    return sectionRead(() => this.prisma.withTenant(tenantId, async (tx) => {
      const [wallets, sums] = await Promise.all([
        tx.wallet.findMany({ where: { tenantId }, orderBy: [{ currency: 'asc' }, { id: 'asc' }] }),
        tx.ledgerEntry.groupBy({ by: ['walletId'], where: { tenantId }, _sum: { amountMinor: true } }),
      ])
      const balance = new Map(sums.map((s) => [s.walletId, s._sum.amountMinor ?? 0n]))
      const byCurrency = new Map<string, { wallets: number; limit: bigint; balance: bigint; overdrawn: number }>()
      for (const w of wallets) {
        const b = balance.get(w.id) ?? 0n
        const row = byCurrency.get(w.currency) ?? { wallets: 0, limit: 0n, balance: 0n, overdrawn: 0 }
        row.wallets += 1; row.limit += w.creditLimit; row.balance += b
        if (w.creditLimit + b < 0n) row.overdrawn += 1
        byCurrency.set(w.currency, row)
      }
      const currencies: FinanceCurrencySummary[] = [...byCurrency.entries()].map(([currency, r]) => ({
        currency, wallets: r.wallets, creditLimitMinor: r.limit.toString(), balanceMinor: r.balance.toString(), availableCreditMinor: (r.limit + r.balance).toString(), overdrawnWallets: r.overdrawn,
      }))
      return { total: wallets.length, currencies }
    }))
  }

  private ledgerSection(tenantId: string, win: { start: Date; end: Date }): Promise<FinanceSummary['ledger']> {
    return sectionRead(() => this.prisma.withTenant(tenantId, async (tx) => {
      const groups = await tx.ledgerEntry.groupBy({
        by: ['currency', 'type'], where: { tenantId, immutableAt: { gte: win.start, lte: win.end } }, _sum: { amountMinor: true }, _count: { _all: true },
      })
      const out = new Map<string, LedgerWindowSummary['byCurrency'][number]>()
      const net = new Map<string, bigint>()
      for (const g of groups) {
        const currency = g.currency.trim()
        const row = out.get(currency) ?? { currency, entries: 0, netMinor: '0', byType: [] }
        const sum = g._sum.amountMinor ?? 0n
        row.entries += g._count._all
        row.byType.push({ type: g.type as LedgerEntryType, entries: g._count._all, sumMinor: sum.toString() })
        net.set(currency, (net.get(currency) ?? 0n) + sum)
        out.set(currency, row)
      }
      const byCurrency = [...out.values()].sort((a, b) => a.currency.localeCompare(b.currency)).map((row) => ({
        ...row, netMinor: (net.get(row.currency) ?? 0n).toString(), byType: row.byType.sort((a, b) => LEDGER_TYPES.indexOf(a.type) - LEDGER_TYPES.indexOf(b.type)),
      }))
      return { entries: byCurrency.reduce((n, r) => n + r.entries, 0), byCurrency }
    }))
  }

  async auditSummary(tenantId: string, query: Record<string, unknown>): Promise<AuditSummary> {
    const win = this.window(query)
    const range = { gte: win.start, lte: win.end }
    const events = await sectionRead(() => this.prisma.withTenant(tenantId, async (tx) => {
      const [byAction, byActor, last] = await Promise.all([
        tx.auditEvent.groupBy({ by: ['action'], where: { tenantId, createdAt: range }, _count: { _all: true } }),
        tx.auditEvent.groupBy({ by: ['actorType'], where: { tenantId, createdAt: range }, _count: { _all: true } }),
        tx.auditEvent.aggregate({ where: { tenantId, createdAt: range }, _max: { createdAt: true } }),
      ])
      const domains = new Map<string, number>()
      let denied = 0, unknownSupplierOutcomes = 0, selfApprovalAttempts = 0, total = 0
      for (const a of byAction) {
        const n = a._count._all
        total += n
        const domain = a.action.split('.')[0] || 'other'
        domains.set(domain, (domains.get(domain) ?? 0) + n)
        if (a.action.endsWith('.denied')) denied += n
        if (a.action === 'supplier.mutation.unknown') unknownSupplierOutcomes += n
        if (a.action === 'approval.denied') selfApprovalAttempts += n
      }
      return {
        total, lastEventAt: iso(last._max.createdAt),
        byActorType: byActor.map((a) => ({ actorType: a.actorType as string, events: a._count._all })).sort((x, y) => y.events - x.events),
        byDomain: [...domains.entries()].map(([domain, events]) => ({ domain, events })).sort((x, y) => y.events - x.events || x.domain.localeCompare(y.domain)),
        attention: { denied, unknownSupplierOutcomes, selfApprovalAttempts },
      }
    }))
    return {
      generatedAt: this.clock().toISOString(),
      window: { from: win.from, to: win.to, days: win.days },
      definitions: {
        total: 'Audit events for the tenant whose creation time falls in the window.',
        domain: 'The first dot-separated segment of the audit action, for example booking, supplier or approval.',
        denied: 'Events whose action ends in .denied, such as a refused self-approval.',
        unknownSupplierOutcomes: 'supplier.mutation.unknown events: a supplier call whose outcome was not observed. Resolve through reconciliation.',
      },
      events,
    }
  }
}
