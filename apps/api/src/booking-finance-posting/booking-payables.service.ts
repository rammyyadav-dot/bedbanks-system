import { Injectable } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PAYABLE_AGING_BUCKETS, PAYABLE_DUE_BUCKETS, type PayableDueBucketKey, type PayableDueRow, type PayablesDueView, type SupplierTermsBasis, type PayableAgingBucketKey, type PayableAgingRow, type PayablesAgingView, type PostedPayableRow, type PostedPayablesView } from '@bedbanks/contracts'
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
    const [groups, paidGroups] = await this.db.withTenant(tenantId, (tx) => Promise.all([
      tx.supplierPayableEntry.groupBy({ by: ['supplierId', 'currency', 'kind'], where: { tenantId }, _sum: { amountMinor: true }, _count: { _all: true } }),
      tx.supplierSettlement.groupBy({ by: ['supplierId', 'currency'], where: { tenantId, status: 'APPROVED' }, _sum: { amountMinor: true } }),
    ]))
    const paid = new Map(paidGroups.map((g) => [`${g.supplierId}\u0000${g.currency}`, g._sum.amountMinor ?? 0n]))
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
        paidMinor: (paid.get(`${r.supplierId}\u0000${r.currency}`) ?? 0n).toString(), outstandingMinor: (r.accruals + r.adjustments + r.reversals - (paid.get(`${r.supplierId}\u0000${r.currency}`) ?? 0n)).toString(),
      })),
    }
  }

  /**
   * Open balance per booking (the sum of its payable entries, when positive), aged from its first accrual and bucketed in the database. One read transaction on the
   * consumer's role under tenant RLS. Days are whole UTC-clock days since the first accrual.
   */
  async aging(tenantId: string, now = new Date()): Promise<PayablesAgingView> {
    const rows = await this.db.withTenant(tenantId, (tx) => tx.$queryRaw<Array<{ supplier_id: string; currency: string; bucket: PayableAgingBucketKey; amount: bigint; bookings: number }>>(Prisma.sql`
      WITH per_booking AS (
        SELECT e."supplier_id", e."currency", e."booking_id", SUM(e."amount_minor") AS "balance",
               MIN(e."created_at") FILTER (WHERE e."kind" = 'ACCRUAL') AS "first_accrual"
          FROM "SupplierPayableEntry" e
         WHERE e."tenant_id" = ${tenantId}
         GROUP BY e."supplier_id", e."currency", e."booking_id"
        HAVING SUM(e."amount_minor") > 0 AND MIN(e."created_at") FILTER (WHERE e."kind" = 'ACCRUAL') IS NOT NULL
      ), paid AS (
        SELECT "supplier_id", "currency", SUM("amount_minor") AS "paid" FROM "SupplierSettlement" WHERE "tenant_id" = ${tenantId} AND "status" = 'APPROVED' GROUP BY "supplier_id", "currency"
      ), running AS (
        SELECT b.*, SUM(b."balance") OVER (PARTITION BY b."supplier_id", b."currency" ORDER BY b."first_accrual", b."booking_id") AS "cumulative"
          FROM per_booking b
      ), open_amounts AS (
        -- Approved payments are applied to the oldest bookings first.
        SELECT r."supplier_id", r."currency", r."first_accrual", GREATEST(0, LEAST(r."balance", r."cumulative" - COALESCE(p."paid", 0))) AS "open"
          FROM running r LEFT JOIN paid p ON p."supplier_id" = r."supplier_id" AND p."currency" = r."currency"
      )
      SELECT o."supplier_id", o."currency",
             CASE WHEN FLOOR(EXTRACT(EPOCH FROM (${now}::timestamp - o."first_accrual")) / 86400) <= 30 THEN 'D0_30'
                  WHEN FLOOR(EXTRACT(EPOCH FROM (${now}::timestamp - o."first_accrual")) / 86400) <= 60 THEN 'D31_60'
                  WHEN FLOOR(EXTRACT(EPOCH FROM (${now}::timestamp - o."first_accrual")) / 86400) <= 90 THEN 'D61_90' ELSE 'D91_PLUS' END AS "bucket",
             SUM(o."open")::bigint AS "amount", COUNT(*)::int AS "bookings"
        FROM open_amounts o WHERE o."open" > 0
       GROUP BY o."supplier_id", o."currency", 3`))
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

  /**
   * Open balance per booking against the supplier's payment terms (ADR 0078). The due date is the booking's check-out, check-in or confirmation date plus the supplier's current
   * terms; a booking with no terms or no date for the basis has no due date (never overdue). Approved payments (ADR 0077) are applied to the earliest-due bookings first. Bucketed in
   * SQL under tenant RLS on the consumer's role. Days are whole UTC calendar days between the as-of date and the due date.
   */
  async due(tenantId: string, now = new Date()): Promise<PayablesDueView> {
    const rows = await this.db.withTenant(tenantId, (tx) => tx.$queryRaw<Array<{ supplier_id: string; currency: string; basis: SupplierTermsBasis | null; days: number | null; bucket: PayableDueBucketKey; amount: bigint; bookings: number }>>(Prisma.sql`
      WITH terms AS (
        SELECT DISTINCT ON ("supplier_id") "supplier_id", "basis", "days" FROM "SupplierPaymentTerms" WHERE "tenant_id" = ${tenantId} ORDER BY "supplier_id", "created_at" DESC, "id" DESC
      ), per_booking AS (
        SELECT e."supplier_id", e."currency", e."booking_id", SUM(e."amount_minor") AS "balance",
               MIN(e."created_at") FILTER (WHERE e."kind" = 'ACCRUAL') AS "first_accrual"
          FROM "SupplierPayableEntry" e
         WHERE e."tenant_id" = ${tenantId}
         GROUP BY e."supplier_id", e."currency", e."booking_id"
        HAVING SUM(e."amount_minor") > 0
      ), dated AS (
        SELECT p.*, t."basis", t."days",
               CASE t."basis" WHEN 'CHECK_OUT' THEN b."check_out" + t."days" WHEN 'CHECK_IN' THEN b."check_in" + t."days" WHEN 'CONFIRMATION' THEN (p."first_accrual"::date + t."days") END AS "due_date"
          FROM per_booking p
          LEFT JOIN terms t ON t."supplier_id" = p."supplier_id"
          LEFT JOIN "Booking" b ON b."id" = p."booking_id" AND b."tenant_id" = ${tenantId}
      ), paid AS (
        SELECT "supplier_id", "currency", SUM("amount_minor") AS "paid" FROM "SupplierSettlement" WHERE "tenant_id" = ${tenantId} AND "status" = 'APPROVED' GROUP BY "supplier_id", "currency"
      ), running AS (
        SELECT d.*, SUM(d."balance") OVER (PARTITION BY d."supplier_id", d."currency" ORDER BY d."due_date" NULLS LAST, d."booking_id") AS "cumulative" FROM dated d
      ), open_amounts AS (
        -- Approved payments are applied to the earliest-due bookings first.
        SELECT r."supplier_id", r."currency", r."basis", r."days", r."due_date", GREATEST(0, LEAST(r."balance", r."cumulative" - COALESCE(p."paid", 0))) AS "open"
          FROM running r LEFT JOIN paid p ON p."supplier_id" = r."supplier_id" AND p."currency" = r."currency"
      )
      SELECT o."supplier_id", o."currency", o."basis", o."days",
             CASE WHEN o."due_date" IS NULL THEN 'NO_DUE_DATE'
                  WHEN ${now}::date - o."due_date" <= 0 THEN 'NOT_DUE'
                  WHEN ${now}::date - o."due_date" <= 30 THEN 'OVERDUE_1_30'
                  WHEN ${now}::date - o."due_date" <= 60 THEN 'OVERDUE_31_60'
                  WHEN ${now}::date - o."due_date" <= 90 THEN 'OVERDUE_61_90' ELSE 'OVERDUE_91_PLUS' END AS "bucket",
             SUM(o."open")::bigint AS "amount", COUNT(*)::int AS "bookings"
        FROM open_amounts o WHERE o."open" > 0
       GROUP BY o."supplier_id", o."currency", o."basis", o."days", 5`))
    const grouped = new Map<string, { supplierId: string; currency: string; basis: SupplierTermsBasis | null; days: number | null; cells: Map<PayableDueBucketKey, { amount: bigint; bookings: number }> }>()
    for (const r of rows) {
      const key = `${r.supplier_id}\u0000${r.currency}`
      const g = grouped.get(key) ?? { supplierId: r.supplier_id, currency: r.currency, basis: r.basis, days: r.days === null ? null : Number(r.days), cells: new Map() }
      g.cells.set(r.bucket, { amount: BigInt(r.amount), bookings: Number(r.bookings) })
      grouped.set(key, g)
    }
    const total = (g: { cells: Map<PayableDueBucketKey, { amount: bigint }> }) => [...g.cells.values()].reduce((n, c) => n + c.amount, 0n)
    const overdue = (g: { cells: Map<PayableDueBucketKey, { amount: bigint }> }) => [...g.cells.entries()].filter(([k]) => k.startsWith('OVERDUE')).reduce((n, [, c]) => n + c.amount, 0n)
    const all = [...grouped.values()].sort((a, b) => a.currency.localeCompare(b.currency) || (overdue(a) === overdue(b) ? a.supplierId.localeCompare(b.supplierId) : overdue(a) > overdue(b) ? -1 : 1))
    const shown = all.slice(0, POSTED_PAYABLES_LIMIT)
    const ids = [...new Set(shown.map((g) => g.supplierId))]
    const suppliers = ids.length ? await this.prisma.withTenant(tenantId, (tx) => tx.supplier.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, displayName: true } })) : []
    const name = new Map(suppliers.map((s) => [s.id, s.displayName]))
    return {
      asOf: now.toISOString().slice(0, 10), listLimit: POSTED_PAYABLES_LIMIT, truncated: all.length > shown.length,
      rows: shown.map((g): PayableDueRow => ({
        supplierId: g.supplierId, name: name.get(g.supplierId) ?? null, currency: g.currency, basis: g.basis, days: g.days, totalMinor: total(g).toString(), overdueMinor: overdue(g).toString(),
        bookings: [...g.cells.values()].reduce((n, c) => n + c.bookings, 0),
        buckets: PAYABLE_DUE_BUCKETS.map((b) => ({ bucket: b.key, amountMinor: (g.cells.get(b.key)?.amount ?? 0n).toString(), bookings: g.cells.get(b.key)?.bookings ?? 0 })),
      })),
    }
  }
}
