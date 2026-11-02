/**
 * Seeds a disposable HotelSearchIndex corpus for tools/load/hybrid-search-load.ts.
 * Owner connection only (bypasses RLS). Refuses non-loopback hosts.
 *
 *   LOADTEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/fbeds_ci \
 *   LOADTEST_ROWS=30000 node --import tsx tools/load/seed-hotel-search-corpus.ts
 */
import { PrismaClient } from '@prisma/client'
import { HashedTokenEmbeddingProvider, hotelEmbeddingText } from '../../apps/api/src/mapping/embedding'
import { normalizeHotelIdentity } from '../../apps/api/src/mapping/normalize'

const url = process.env.LOADTEST_DATABASE_URL
if (!url) {
  console.error('LOADTEST_DATABASE_URL is required')
  process.exit(2)
}
const host = new URL(url).hostname
if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
  console.error(`refusing non-loopback host '${host}'`)
  process.exit(2)
}

const rows = Number(process.env.LOADTEST_ROWS ?? 30_000)
const batchSize = 500
const embedder = new HashedTokenEmbeddingProvider()
const prisma = new PrismaClient({ datasources: { db: { url } }, log: ['error'] })

function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function vectorLiteral(values: number[]): string {
  return `[${values.map((value) => value.toFixed(8)).join(',')}]`
}

async function main() {
  const tenant = await prisma.tenant.create({ data: { name: `loadtest-${Date.now()}`, slug: `loadtest-${Date.now()}` } })
  const started = Date.now()
  for (let offset = 0; offset < rows; offset += batchSize) {
    const n = Math.min(batchSize, rows - offset)
    const hotels = Array.from({ length: n }, (_, i) => {
      const index = offset + i
      const city = index % 3 === 0 ? 'Abu Dhabi' : 'Dubai'
      const name = index % 17 === 0 ? `DoubleTree by Hilton Dubai Al Jadaf ${index}` : `Benchmark Hotel ${index} ${city}`
      const address = `${index} Benchmark Street`
      const hotelId = `h_${tenant.id}_${index}`
      const normalized = normalizeHotelIdentity({ name, address, city, countryCode: 'AE' })
      return { hotelId, name, city, address, normalized, embedding: vectorLiteral(embedder.embed(hotelEmbeddingText(normalized))) }
    })
    // raw-sql: load-test corpus seed on loopback owner connection; identifiers are generated, strings are quoted.
    const hotelValues = hotels
      .map((h) => `(${quote(h.hotelId)},${quote(tenant.id)},${quote(h.name)},'HOTEL',${quote(h.city)},'AE',${quote(h.address)},'Asia/Dubai','DRAFT',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`)
      .join(',')
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Hotel" ("id","tenant_id","name","property_type","city","country_code","address","time_zone","content_status","created_at","updated_at") VALUES ${hotelValues}`,
    )
    const indexValues = hotels
      .map(
        (h) =>
          `(${quote(`hsi_${h.hotelId}`)},${quote(tenant.id)},${quote(h.hotelId)},${quote(h.normalized.normalizedName)},${quote(h.normalized.normalizedAddress)},${quote(h.normalized.normalizedCity)},${quote(h.normalized.normalizedCountryCode)},'${h.embedding}'::vector,${quote(embedder.model)},CURRENT_TIMESTAMP)`,
      )
      .join(',')
    await prisma.$executeRawUnsafe(
      `INSERT INTO "HotelSearchIndex" ("id","tenant_id","hotel_id","normalized_name","normalized_address","normalized_city","normalized_country_code","embedding","embedding_model","updated_at") VALUES ${indexValues}`,
    )
    if (offset === 0 || (offset / batchSize) % 10 === 0) console.error(`seeded ${Math.min(offset + n, rows)}/${rows}`)
  }
  console.log(JSON.stringify({ tenantId: tenant.id, rows, seedMs: Date.now() - started }))
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 2
  })
  .finally(() => prisma.$disconnect())
