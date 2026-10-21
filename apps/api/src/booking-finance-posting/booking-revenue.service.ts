import { BadRequestException, Injectable } from '@nestjs/common'
import { POSTING_BACKLOG_LIST_LIMIT, REVENUE_REPORT_INVALID_RANGE, REVENUE_REPORT_MAX_DAYS, type RevenueAgencyRow, type RevenueCurrencyBlock, type RevenueReportView, type RevenueSupplierRow } from '@bedbanks/contracts'
import { PrismaService } from '../database/prisma.service'
import { BookingFinancePostingDatabase } from './booking-finance-posting.database'

const DAY_MS = 86_400_000
const DATE = /^\d{4}-\d{2}-\d{2}$/
const bad = (message: string) => new BadRequestException({ message, code: REVENUE_REPORT_INVALID_RANGE })

/** Inclusive UTC calendar dates in, a half-open instant window out. The default is the current UTC month to date. */
export function revenueWindow(query: Record<string, unknown>, now: Date): { from: string; to: string; start: Date; end: Date } {
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  const fromRaw = query.from === undefined ? iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))) : query.from
  const toRaw = query.to === undefined ? iso(now) : query.to
  if (typeof fromRaw !== 'string' || typeof toRaw !== 'string' || !DATE.test(fromRaw) || !DATE.test(toRaw)) throw bad('from and to must be dates as YYYY-MM-DD')
  const start = new Date(`${fromRaw}T00:00:00.000Z`)
  const last = new Date(`${toRaw}T00:00:00.000Z`)
  if (Number.isNaN(start.getTime()) || Number.isNaN(last.getTime()) || iso(start) !== fromRaw || iso(last) !== toRaw) throw bad('from and to must be real calendar dates')
  if (last < start) throw bad('to must not be before from')
  if ((last.getTime() - start.getTime()) / DAY_MS + 1 > REVENUE_REPORT_MAX_DAYS) throw bad(`The range may cover at most ${REVENUE_REPORT_MAX_DAYS} days`)
  return { from: fromRaw, to: toRaw, start, end: new Date(last.getTime() + DAY_MS) }
}

/**
 * Revenue of the bookings the Finance consumer posted (ADR 0076): a plain aggregation of `BookingFinancePosting` (sales and refunds per posted event) and
 * `SupplierPayableEntry` (what is owed to suppliers), per currency. It sums nothing from the ledger, converts nothing and adds no currencies together. Read through the
 * consumer's own role; when that role is unavailable the answer is the typed 503, never an empty report. Agency and supplier names come from the API connection.
 */
@Injectable()
export class BookingRevenueService {
  constructor(private readonly db: BookingFinancePostingDatabase, private readonly prisma: PrismaService) {}

  async report(tenantId: string, query: Record<string, unknown>, now = new Date()): Promise<RevenueReportView> {
    const { from, to, start, end } = revenueWindow(query, now)
    const when = { gte: start, lt: end }
    const raw = await this.db.withTenant(tenantId, async (tx) => {
      const [byWallet, charged, byPayable] = await Promise.all([
        tx.bookingFinancePosting.groupBy({ by: ['currency', 'walletId'], where: { tenantId, status: 'POSTED', createdAt: when }, _sum: { salesMinor: true, refundsMinor: true } }),
        tx.bookingFinancePosting.groupBy({ by: ['currency'], where: { tenantId, status: 'POSTED', createdAt: when, salesMinor: { gt: 0n } }, _count: { _all: true } }),
        tx.supplierPayableEntry.groupBy({ by: ['currency', 'supplierId'], where: { tenantId, createdAt: when }, _sum: { amountMinor: true } }),
      ])
      const walletIds = [...new Set(byWallet.flatMap((g) => (g.walletId ? [g.walletId] : [])))]
      const wallets = walletIds.length ? await tx.wallet.findMany({ where: { tenantId, id: { in: walletIds } }, select: { id: true, agencyId: true } }) : []
      return { byWallet, charged, byPayable, agencyOfWallet: new Map(wallets.map((w) => [w.id, w.agencyId])) }
    })

    const agencyIds = [...new Set([...raw.agencyOfWallet.values()].flatMap((a) => (a ? [a] : [])))]
    const supplierIds = [...new Set(raw.byPayable.map((g) => g.supplierId))]
    const [agencies, suppliers] = await this.prisma.withTenant(tenantId, (tx) => Promise.all([
      agencyIds.length ? tx.agency.findMany({ where: { tenantId, id: { in: agencyIds } }, select: { id: true, name: true } }) : [],
      supplierIds.length ? tx.supplier.findMany({ where: { tenantId, id: { in: supplierIds } }, select: { id: true, displayName: true } }) : [],
    ]))
    const agencyName = new Map(agencies.map((a) => [a.id, a.name]))
    const supplierName = new Map(suppliers.map((s) => [s.id, s.displayName]))

    const blocks = new Map<string, { sales: bigint; refunds: bigint; cost: bigint; charged: number; agencies: Map<string | null, { sales: bigint; refunds: bigint }>; suppliers: Map<string, bigint> }>()
    const block = (currency: string) => {
      const b = blocks.get(currency) ?? { sales: 0n, refunds: 0n, cost: 0n, charged: 0, agencies: new Map(), suppliers: new Map() }
      blocks.set(currency, b)
      return b
    }
    for (const g of raw.byWallet) {
      const b = block(g.currency)
      const sales = g._sum.salesMinor ?? 0n
      const refunds = g._sum.refundsMinor ?? 0n
      b.sales += sales
      b.refunds += refunds
      const agencyId = g.walletId ? raw.agencyOfWallet.get(g.walletId) ?? null : null
      const row = b.agencies.get(agencyId) ?? { sales: 0n, refunds: 0n }
      row.sales += sales
      row.refunds += refunds
      b.agencies.set(agencyId, row)
    }
    for (const g of raw.charged) block(g.currency).charged = g._count._all
    for (const g of raw.byPayable) {
      const b = block(g.currency)
      const cost = g._sum.amountMinor ?? 0n
      b.cost += cost
      b.suppliers.set(g.supplierId, (b.suppliers.get(g.supplierId) ?? 0n) + cost)
    }

    const limit = POSTING_BACKLOG_LIST_LIMIT
    const currencies = [...blocks.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, b]): RevenueCurrencyBlock => {
      const net = b.sales - b.refunds
      const agenciesRows = [...b.agencies.entries()].map(([agencyId, r]): RevenueAgencyRow & { net: bigint } => ({ agencyId, name: agencyId ? agencyName.get(agencyId) ?? null : null, salesMinor: r.sales.toString(), refundsMinor: r.refunds.toString(), netRevenueMinor: (r.sales - r.refunds).toString(), net: r.sales - r.refunds }))
        .sort((x, y) => (x.net === y.net ? (x.agencyId ?? '').localeCompare(y.agencyId ?? '') : x.net > y.net ? -1 : 1)).slice(0, limit).map(({ net: _net, ...row }) => row)
      const supplierRows = [...b.suppliers.entries()].sort(([ia, a], [ib, c]) => (a === c ? ia.localeCompare(ib) : a > c ? -1 : 1)).slice(0, limit)
        .map(([supplierId, cost]): RevenueSupplierRow => ({ supplierId, name: supplierName.get(supplierId) ?? null, costMinor: cost.toString() }))
      return { currency, salesMinor: b.sales.toString(), refundsMinor: b.refunds.toString(), netRevenueMinor: net.toString(), supplierCostMinor: b.cost.toString(), marginMinor: (net - b.cost).toString(), chargedEvents: b.charged, byAgency: agenciesRows, bySupplier: supplierRows }
    })

    return {
      from, to, basis: 'POSTING_DATE', generatedAt: now.toISOString(), currencies, listLimit: limit,
      notes: [
        'Dated by when the Finance consumer posted the event, not by booking, stay or payment date.',
        'Covers Admin-originated bookings the consumer posted. Charges made by the Agent flow, and their supplier cost, are not included.',
        'Each currency is reported on its own; nothing is converted or added across currencies.',
        'Margin is indicative: a cancelled booking with a penalty keeps its supplier payable until the supplier\'s own fee is known.',
      ],
    }
  }
}
