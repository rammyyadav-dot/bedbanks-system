import { Injectable } from '@nestjs/common'
import { type PostedPayableRow, type PostedPayablesView } from '@bedbanks/contracts'
import { PrismaService } from '../database/prisma.service'
import { BookingFinancePostingDatabase } from './booking-finance-posting.database'

/** Suppliers shown; the rest are counted by `truncated`. */
export const POSTED_PAYABLES_LIMIT = 500

/**
 * What is owed to each supplier according to the Finance consumer's payable entries (ADR 0076), per supplier and currency, by kind. A plain aggregation of
 * `SupplierPayableEntry`, read through the consumer's own role (typed 503 when unavailable, never an empty list). It posts and changes nothing, adds no
 * currencies together, and is not an amount to pay: no supplier invoice or settlement exists. Names come from the API connection.
 */
@Injectable()
export class BookingPayablesService {
  constructor(private readonly db: BookingFinancePostingDatabase, private readonly prisma: PrismaService) {}

  async payables(tenantId: string, now = new Date()): Promise<PostedPayablesView> {
    const groups = await this.db.withTenant(tenantId, (tx) => tx.supplierPayableEntry.groupBy({ by: ['supplierId', 'currency', 'kind'], where: { tenantId }, _sum: { amountMinor: true }, _count: { _all: true } }))
    const rows = new Map<string, { supplierId: string; currency: string; accruals: bigint; adjustments: bigint; reversals: bigint; entries: number }>()
    for (const g of groups) {
      const key = `${g.supplierId}\u0000${g.currency}`
      const r = rows.get(key) ?? { supplierId: g.supplierId, currency: g.currency, accruals: 0n, adjustments: 0n, reversals: 0n, entries: 0 }
      const sum = g._sum.amountMinor ?? 0n
      if (g.kind === 'ACCRUAL') r.accruals += sum
      else if (g.kind === 'ADJUSTMENT') r.adjustments += sum
      else r.reversals += sum
      r.entries += g._count._all
      rows.set(key, r)
    }
    const all = [...rows.values()].sort((a, b) => a.currency.localeCompare(b.currency) || (a.accruals + a.adjustments + a.reversals === b.accruals + b.adjustments + b.reversals ? a.supplierId.localeCompare(b.supplierId) : a.accruals + a.adjustments + a.reversals > b.accruals + b.adjustments + b.reversals ? -1 : 1))
    const shown = all.slice(0, POSTED_PAYABLES_LIMIT)
    const ids = [...new Set(shown.map((r) => r.supplierId))]
    const suppliers = ids.length ? await this.prisma.withTenant(tenantId, (tx) => tx.supplier.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, displayName: true } })) : []
    const name = new Map(suppliers.map((s) => [s.id, s.displayName]))
    return {
      generatedAt: now.toISOString(), listLimit: POSTED_PAYABLES_LIMIT, truncated: all.length > shown.length,
      rows: shown.map((r): PostedPayableRow => ({
        supplierId: r.supplierId, name: name.get(r.supplierId) ?? null, currency: r.currency, accrualsMinor: r.accruals.toString(), adjustmentsMinor: r.adjustments.toString(),
        reversalsMinor: r.reversals.toString(), balanceMinor: (r.accruals + r.adjustments + r.reversals).toString(), entries: r.entries,
      })),
    }
  }
}
