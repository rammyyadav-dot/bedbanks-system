import { Prisma, type PrismaClient } from '@prisma/client'
import { EMBEDDING_MODEL } from './embedding'
import { upsertHotelSearchIndex } from './hotel-search-index'
import { normalizeHotelIdentity } from './normalize'

/**
 * Operator reindex of HotelSearchIndex (the runtime role only reads it; see runtime-role-contract). A hotel is stale when it has no
 * index row, the row was built by another embedding model, or the hotel changed after the row was written. Re-running is idempotent
 * and converges: a written row's updated_at is later than the hotel's. Dry run by default.
 */
export interface TenantReindexReport {
  tenantId: string
  stale: number
  /** Rows written by this run (0 on a dry run). */
  applied: number
  /** Hotels whose identity cannot be indexed (no country code). Ids only. */
  skippedInvalid: string[]
}

export interface ReindexReport {
  mode: 'dry-run' | 'apply'
  embeddingModel: string
  tenants: TenantReindexReport[]
  totals: { stale: number; applied: number; skippedInvalid: number }
  reconciliation: { appliedEqualsIndexable: boolean }
}

interface StaleHotel { id: string; name: string; address: string | null; city: string; countryCode: string; latitude: number | null; longitude: number | null }

const DEFAULT_BATCH = 200

export async function runHotelSearchReindex(
  prisma: PrismaClient,
  options: { apply: boolean; tenantIds?: string[]; batchSize?: number },
): Promise<ReindexReport> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH
  const tenantIds = options.tenantIds ?? (await prisma.tenant.findMany({ select: { id: true }, orderBy: { id: 'asc' } })).map((tenant) => tenant.id)
  const tenants: TenantReindexReport[] = []
  for (const tenantId of tenantIds) tenants.push(await reindexTenant(prisma, tenantId, options.apply, batchSize))
  const totals = {
    stale: tenants.reduce((sum, t) => sum + t.stale, 0),
    applied: tenants.reduce((sum, t) => sum + t.applied, 0),
    skippedInvalid: tenants.reduce((sum, t) => sum + t.skippedInvalid.length, 0),
  }
  return {
    mode: options.apply ? 'apply' : 'dry-run',
    embeddingModel: EMBEDDING_MODEL,
    tenants,
    totals,
    reconciliation: { appliedEqualsIndexable: !options.apply || totals.applied === totals.stale - totals.skippedInvalid },
  }
}

async function reindexTenant(prisma: PrismaClient, tenantId: string, apply: boolean, batchSize: number): Promise<TenantReindexReport> {
  const report: TenantReindexReport = { tenantId, stale: 0, applied: 0, skippedInvalid: [] }
  let cursor = ''
  for (;;) {
    const batch = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`
      const rows = await tx.$queryRaw<StaleHotel[]>(Prisma.sql`
        SELECT h."id", h."name", h."address", h."city", h."country_code" AS "countryCode",
               h."latitude"::float8 AS "latitude", h."longitude"::float8 AS "longitude"
          FROM "Hotel" h
          LEFT JOIN "HotelSearchIndex" s ON s."tenant_id" = h."tenant_id" AND s."hotel_id" = h."id"
         WHERE h."tenant_id" = ${tenantId} AND h."id" > ${cursor}
           AND (s."id" IS NULL OR s."embedding_model" <> ${EMBEDDING_MODEL} OR s."updated_at" < h."updated_at")
         ORDER BY h."id"
         LIMIT ${batchSize}`)
      const indexable = rows.filter((row) => normalizeHotelIdentity({ name: row.name, address: row.address, city: row.city, countryCode: row.countryCode }).normalizedCountryCode)
      if (apply) {
        for (const row of indexable) {
          await upsertHotelSearchIndex(tx, tenantId, { hotelId: row.id, name: row.name, address: row.address, city: row.city, countryCode: row.countryCode, latitude: row.latitude, longitude: row.longitude })
        }
      }
      return { rows, indexable: indexable.length }
    })
    if (batch.rows.length === 0) return report
    report.stale += batch.rows.length
    report.applied += apply ? batch.indexable : 0
    for (const row of batch.rows) {
      if (!normalizeHotelIdentity({ name: row.name, address: row.address, city: row.city, countryCode: row.countryCode }).normalizedCountryCode) report.skippedInvalid.push(row.id)
    }
    cursor = batch.rows[batch.rows.length - 1].id
  }
}
