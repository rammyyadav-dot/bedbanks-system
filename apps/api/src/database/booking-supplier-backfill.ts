/**
 * Historical supplier attribution for bookings (ADR 0061 Amendment 1, D3).
 *
 * Forward-only and conservative. A booking is attributed only when ALL of these hold; otherwise it stays null and is counted under a reason:
 *   - supplier_id is still null (a set value is never rewritten; the database trigger also forbids it)
 *   - it came through the Agent portal (`channel = PORTAL`); manual and connector bookings have no supplier organization
 *   - its frozen snapshot names exactly one inventory hold, and no OTHER booking of the tenant names the same hold
 *   - that hold exists IN THE SAME TENANT and agrees with the booking on hotel, stay dates, currency and amount
 *   - any recorded supplier mutation for the booking names the same hold
 *   - hold -> rate plan -> contract -> supplier all resolve inside the tenant
 * The snapshot hold id is only a lookup key. It is corroborated field by field against the hold, so a value that does not match the real hold
 * attributes nothing. `Booking.supplier`, names and request data are never read.
 */
import type { PrismaClient } from '@prisma/client'

export const BACKFILL_CATEGORIES = [
  'already_attributed',
  'attributable',
  'skip_non_portal_channel',
  'skip_no_hold_reference',
  'skip_hold_referenced_by_multiple_bookings',
  'skip_hold_not_found_in_tenant',
  'skip_hold_disagrees_with_booking',
  'skip_supplier_mutation_hold_conflict',
  'skip_rate_plan_not_found',
  'skip_contract_not_found',
  'skip_supplier_not_found',
] as const
export type BackfillCategory = (typeof BACKFILL_CATEGORIES)[number]

export interface TenantBackfillReport {
  tenantId: string
  total: number
  counts: Record<BackfillCategory, number>
  /** Rows changed by this run (0 on a dry run). */
  applied: number
  /** Up to 20 booking ids per skipped reason, for owner review. Ids only: no reference, guest or amount. */
  samples: Partial<Record<BackfillCategory, string[]>>
}

export interface BackfillReport {
  mode: 'dry-run' | 'apply'
  generatedAt: string
  tenants: TenantBackfillReport[]
  totals: { total: number; counts: Record<BackfillCategory, number>; applied: number }
  reconciliation: { categoriesSumToTotal: boolean; attributableBefore: number; appliedEqualsAttributable: boolean; alreadyAttributedAfter: number }
}

type Tx = Pick<PrismaClient, '$queryRawUnsafe' | '$executeRawUnsafe'>

// Tenant id is the only bind parameter. Everything else is a fixed statement.
const CLASSIFY_SQL = `
WITH cand AS (
  SELECT b."id", b."tenant_id", b."supplier_id", b."channel"::text AS channel, b."hotel_id", b."check_in", b."check_out", b."currency", b."total_minor",
         NULLIF(b."search_snapshot"->>'inventoryHoldId', '') AS hold_id
  FROM "Booking" b WHERE b."tenant_id" = $1
), refs AS (
  SELECT "hold_id", count(*) AS n FROM cand WHERE "hold_id" IS NOT NULL GROUP BY "hold_id"
), joined AS (
  SELECT c.*, r.n AS refs, h."id" AS h_id, h."canonical_hotel_id" AS h_hotel, h."check_in" AS h_in, h."check_out" AS h_out, h."currency" AS h_cur, h."sell_amount_minor" AS h_amount,
         rp."id" AS rp_id, k."supplier_id" AS k_supplier, s."id" AS s_id,
         EXISTS (SELECT 1 FROM "SupplierMutation" m WHERE m."tenant_id" = c."tenant_id" AND m."booking_id" = c."id" AND m."hold_id" <> c."hold_id") AS mutation_conflict
  FROM cand c
  LEFT JOIN refs r ON r."hold_id" = c."hold_id"
  LEFT JOIN "InventoryHold" h ON h."tenant_id" = c."tenant_id" AND h."id" = c."hold_id"
  LEFT JOIN "RatePlan" rp ON rp."tenant_id" = c."tenant_id" AND rp."id" = h."rate_plan_id"
  LEFT JOIN "Contract" k ON k."tenant_id" = c."tenant_id" AND k."id" = rp."contract_id"
  LEFT JOIN "Supplier" s ON s."tenant_id" = c."tenant_id" AND s."id" = k."supplier_id"
)
SELECT "id", k_supplier AS supplier_id, CASE
  WHEN "supplier_id" IS NOT NULL THEN 'already_attributed'
  WHEN channel <> 'PORTAL' THEN 'skip_non_portal_channel'
  WHEN "hold_id" IS NULL THEN 'skip_no_hold_reference'
  WHEN refs > 1 THEN 'skip_hold_referenced_by_multiple_bookings'
  WHEN h_id IS NULL THEN 'skip_hold_not_found_in_tenant'
  WHEN h_hotel IS DISTINCT FROM "hotel_id" OR h_in IS DISTINCT FROM "check_in" OR h_out IS DISTINCT FROM "check_out"
    OR h_cur IS DISTINCT FROM "currency" OR h_amount IS DISTINCT FROM "total_minor" THEN 'skip_hold_disagrees_with_booking'
  WHEN mutation_conflict THEN 'skip_supplier_mutation_hold_conflict'
  WHEN rp_id IS NULL THEN 'skip_rate_plan_not_found'
  WHEN k_supplier IS NULL THEN 'skip_contract_not_found'
  WHEN s_id IS NULL THEN 'skip_supplier_not_found'
  ELSE 'attributable' END AS category
FROM joined`

const emptyCounts = (): Record<BackfillCategory, number> => Object.fromEntries(BACKFILL_CATEGORIES.map((c) => [c, 0])) as Record<BackfillCategory, number>

/** Classifies every booking of one tenant. Must run in a transaction where app.current_tenant_id is set (forced row-level security). */
export async function classifyTenant(tx: Tx, tenantId: string): Promise<{ id: string; supplier_id: string | null; category: BackfillCategory }[]> {
  return tx.$queryRawUnsafe(CLASSIFY_SQL, tenantId) as Promise<{ id: string; supplier_id: string | null; category: BackfillCategory }[]>
}

function summarise(tenantId: string, rows: { id: string; category: BackfillCategory }[], applied: number): TenantBackfillReport {
  const counts = emptyCounts()
  const samples: TenantBackfillReport['samples'] = {}
  for (const row of rows) {
    counts[row.category] += 1
    if (row.category.startsWith('skip_')) {
      const list = (samples[row.category] ??= [])
      if (list.length < 20) list.push(row.id)
    }
  }
  return { tenantId, total: rows.length, counts, applied, samples }
}

/**
 * Runs the backfill for the given tenants (all tenants when omitted). `apply: false` is a pure read. With `apply: true` each tenant is processed in
 * its own transaction: classify, update only the `attributable` rows that are STILL null, re-classify, and roll back that tenant if the result does
 * not reconcile.
 */
export async function runBookingSupplierBackfill(prisma: PrismaClient, options: { apply: boolean; tenantIds?: string[] }): Promise<BackfillReport> {
  const tenants = options.tenantIds ?? (await prisma.$queryRawUnsafe<{ id: string }[]>('SELECT "id" FROM "tenants" ORDER BY "id"')).map((t) => t.id)
  const reports: TenantBackfillReport[] = []
  let attributableBefore = 0
  let alreadyAfter = 0
  for (const tenantId of tenants) {
    const report = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_tenant_id', $1, true)`, tenantId)
      const before = await classifyTenant(tx, tenantId)
      const attributable = before.filter((row) => row.category === 'attributable')
      attributableBefore += attributable.length
      let applied = 0
      if (options.apply && attributable.length > 0) {
        applied = await tx.$executeRawUnsafe(
          `UPDATE "Booking" b SET "supplier_id" = x."supplier_id" FROM (SELECT unnest($2::text[]) AS "id", unnest($3::text[]) AS "supplier_id") x WHERE b."tenant_id" = $1 AND b."id" = x."id" AND b."supplier_id" IS NULL`,
          tenantId, attributable.map((row) => row.id), attributable.map((row) => row.supplier_id as string),
        )
        const after = await classifyTenant(tx, tenantId)
        const stillAttributable = after.filter((row) => row.category === 'attributable').length
        const attributedNow = after.filter((row) => row.category === 'already_attributed').length
        const alreadyBefore = before.filter((row) => row.category === 'already_attributed').length
        if (applied !== attributable.length || stillAttributable !== 0 || attributedNow !== alreadyBefore + applied) throw new Error(`Backfill did not reconcile for tenant ${tenantId}; rolled back`)
        alreadyAfter += attributedNow
        return summarise(tenantId, after, applied)
      }
      alreadyAfter += before.filter((row) => row.category === 'already_attributed').length
      return summarise(tenantId, before, applied)
    })
    reports.push(report)
  }
  const counts = emptyCounts()
  let total = 0
  let applied = 0
  for (const r of reports) { total += r.total; applied += r.applied; for (const c of BACKFILL_CATEGORIES) counts[c] += r.counts[c] }
  return {
    mode: options.apply ? 'apply' : 'dry-run',
    generatedAt: new Date().toISOString(),
    tenants: reports,
    totals: { total, counts, applied },
    reconciliation: {
      categoriesSumToTotal: BACKFILL_CATEGORIES.reduce((n, c) => n + counts[c], 0) === total,
      attributableBefore,
      appliedEqualsAttributable: options.apply ? applied === attributableBefore : true,
      alreadyAttributedAfter: alreadyAfter,
    },
  }
}
