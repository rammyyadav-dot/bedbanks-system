import { Injectable } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PAYABLE_AGING_BUCKETS, type PayableAgingBucketKey, type PayableAgingRow, type PayablesAgingView, type PostedPayableRow, type PostedPayablesView } from '@bedbanks/contracts'
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

  /**
   * Open balance per booking (the sum of its payable entries, when positive), aged from its first accrual and bucketed in the database. One read transaction on the
   * consumer's role under tenant RLS. Days are whole UTC-clock days since the first accrual.
   */
  async aging(tenantId: string, now = new Date()): Promise<PayablesAgingView> {
    const rows = await this.db.withTenant(tenantId, (tx) => tx.$queryRaw<Array<{ supplier_id: string; currency: string; bucket: PayableAgingBucketKey; amount: bigint; bookings: number }>>(Prisma.sql`
      SELECT s."supplier_id", s."currency",
             CASE WHEN s."age_days" <= 30 THEN 'D0_30' WHEN s."age_days" <= 60 THEN 'D31_60' WHEN s."age_days" <= 90 THEN 'D61_90' ELSE 'D91_PLUS' END AS "bucket",
             SUM(s."balance")::bigint AS "amount", COUNT(*)::int AS "bookings"
        FROM (
          SELECT e."supplier_id", e."currency", e."booking_id", SUM(e."amount_minor") AS "balance",
                 FLOOR(EXTRACT(EPOCH FROM (${now}::timestamp - MIN(e."created_at") FILTER (WHERE e."kind" = 'ACCRUAL'))) / 86400)::int AS "age_days"
            FROM "SupplierPayableEntry" e
           WHERE e."tenant_id" = ${tenantId}
           GROUP BY e."supplier_id", e."currency", e."booking_id"
          HAVING SUM(e."amount_minor") > 0 AND MIN(e."created_at") FILTER (WHERE e."kind" = 'ACCRUAL') IS NOT NULL
        ) s
       GROUP BY s."supplier_id", s."currency", 3`))
    const grouped = new Map<string, { supplierId: string; currency: string; cells: Map<PayableAgingBucketKey, { amount: bigint; bookings: number }> }>()
    for (const r of rows) {
      const key = `${r.supplier_id}\u0000${r.currency}`
      const g = grouped.get(key) ?? { supplierId: r.supplier_id, currency: r.currency, cells: new Map() }
      g.cells.set(r.bucket, { amount: BigInt(r.amount), bookings: Number(r.bookings) })
      grouped.set(key, g)
    }
    const total = (g: { cells: Map<PayableAgingBucketKey, { amount: bigint }> }) => [...g.cells.values()].reduce((n, c) => n + c.amount, 0n)
    const all = [...grouped.values()].sort((a, b) => a.currency.localeCompare(b.currency) || (total(a) === total(b) ? a.supplierId.localeCompare(b.supplierId) : total(a) > total(b) ? -1 : 1))
    const shown = all.slice(0, POSTED_PAYABLES_LIMIT)
    const ids = [...new Set(shown.map((g) => g.supplierId))]
    const suppliers = ids.length ? await this.prisma.withTenant(tenantId, (tx) => tx.supplier.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, displayName: true } })) : []
    const name = new Map(suppliers.map((s) => [s.id, s.displayName]))
    return {
      asOf: now.toISOString(), listLimit: POSTED_PAYABLES_LIMIT, truncated: all.length > shown.length,
      rows: shown.map((g): PayableAgingRow => ({
        supplierId: g.supplierId, name: name.get(g.supplierId) ?? null, currency: g.currency, totalMinor: total(g).toString(),
        bookings: [...g.cells.values()].reduce((n, c) => n + c.bookings, 0),
        buckets: PAYABLE_AGING_BUCKETS.map((b) => ({ bucket: b.key, amountMinor: (g.cells.get(b.key)?.amount ?? 0n).toString(), bookings: g.cells.get(b.key)?.bookings ?? 0 })),
      })),
    }
  }
}
