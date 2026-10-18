// Smoke test for ADR 0072: hotel trigram/tsvector indexes, typeahead typo tolerance and hybrid (RRF) candidate retrieval.
// Needs a migrated PostgreSQL with pgvector and pg_trgm. Writes to a DISPOSABLE local database only and removes its own tenants.
// Run: DATABASE_URL=postgresql://user:pw@localhost:5432/fbeds_ci pnpm --filter @bedbanks/api exec node --no-experimental-strip-types -r @swc-node/register ../../tools/hotel-search-smoke.ts
import { PrismaService } from '../apps/api/src/database/prisma.service'
import { DestinationResolverService } from '../apps/api/src/agent/destination-resolver.service'
import { retrieveHotelCandidates, upsertHotelSearchIndex } from '../apps/api/src/mapping/hotel-search-index'

const url = process.env.DATABASE_URL ?? ''
if (!/@(localhost|127\.0\.0\.1):\d+\/(fbeds_ci|p0\d_[a-z0-9_]+)(\?schema=public)?$/.test(url)) throw new Error('refusing: DATABASE_URL must be a disposable local database (fbeds_ci or p0N_*)')

// The planner rightly prefers the tenant b-tree on small tenants; the trigram indexes matter at catalogue scale.
const FILLER_HOTELS = 200000
const check = (ok: boolean, message: string) => { if (!ok) throw new Error(`FAIL: ${message}`); console.log(`ok   ${message}`) }

async function main() {
  const prisma = new PrismaService(); await prisma.$connect()
  const stamp = Date.now().toString(36)
  const tenants = await Promise.all(['a', 'b'].map((k) => prisma.tenant.create({ data: { name: `Search smoke ${k}`, slug: `search-smoke-${k}-${stamp}` } })))
  const [a, b] = tenants
  try {
    const seed = async (tenantId: string, name: string, city: string, countryCode: string, address: string) => {
      const hotel = await prisma.hotel.create({ data: { tenantId, name, city, countryCode, address, propertyType: 'HOTEL', contentStatus: 'COMPLETE' } })
      await prisma.withTenant(tenantId, (tx) => upsertHotelSearchIndex(tx, tenantId, { hotelId: hotel.id, name, address, city, countryCode }))
      return hotel
    }
    const target = await seed(a.id, 'Atlantis The Palm', 'Dubai', 'AE', 'Crescent Road, Palm Jumeirah')
    await seed(a.id, 'Atlantis Paradise Island', 'Nassau', 'BS', 'Casino Drive')
    await seed(a.id, 'Jumeirah Beach Hotel', 'Dubai', 'AE', 'Jumeirah Street')
    const foreign = await seed(b.id, 'Atlantis The Palm', 'Dubai', 'AE', 'Crescent Road, Palm Jumeirah')
    await prisma.$executeRaw`
      INSERT INTO "Hotel" ("id", "tenant_id", "name", "property_type", "city", "country_code", "content_status", "updated_at")
      SELECT ${`filler_${stamp}_`} || g, ${a.id}, 'Resort ' || md5(g::text), 'HOTEL', 'City ' || substr(md5((g % 500)::text), 1, 8), 'AE', 'COMPLETE', now()
        FROM generate_series(1, ${FILLER_HOTELS}) g`
    await prisma.$executeRaw`ANALYZE "Hotel"`

    // 1. Hybrid retrieval.
    const rows = await prisma.withTenant(a.id, (tx) => retrieveHotelCandidates(tx, a.id, { name: 'Atlantis Palm', city: 'Dubai', countryCode: 'ae' }))
    check(rows.length > 0 && rows[0].hotelId === target.id, 'hybrid retrieval ranks the matching hotel first')
    check(rows.every((r) => r.hotelId !== foreign.id), "hybrid retrieval never returns another tenant's hotel")
    check(rows.every((r, i) => i === 0 || rows[i - 1].fusedScore >= r.fusedScore), 'results are ordered by fused score')
    check(rows[0].textRank > 0 && rows[0].vectorSimilarity > 0, 'top hit carries lexical and vector signals')
    const anyCountry = await prisma.withTenant(a.id, (tx) => retrieveHotelCandidates(tx, a.id, { name: 'Atlantis' }))
    check(anyCountry.length >= 2, 'empty country code searches every country')

    // 2. Typeahead: typo tolerance with the transaction-local threshold.
    const resolver = new DestinationResolverService(prisma)
    const typo = await resolver.search(a.id, 'dubia')
    check(typo.some((r) => r.type === 'city' && r.name === 'Dubai'), 'typo "dubia" still resolves Dubai')
    const unrelated = await resolver.search(a.id, 'zzzzqq')
    check(unrelated.length === 0, 'unrelated text returns nothing')

    // 3. Index use at catalogue scale: the resolver's real predicate must be answered from the trigram indexes.
    const plan = await prisma.withTenant(a.id, async (tx) => {
      await tx.$executeRaw`SELECT set_config('pg_trgm.word_similarity_threshold', '0.35', true)`
      const lines = await tx.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(`EXPLAIN ANALYZE SELECT "id" FROM "Hotel" WHERE "tenant_id" = '${a.id}' AND "content_status" = 'COMPLETE' AND (lower("city") LIKE '%dubia%' OR lower("name") LIKE '%dubia%' OR 'dubia' <% lower("city") OR 'dubia' <% lower("name"))`)
      return lines.map((l) => l['QUERY PLAN']).join('\n')
    })
    check(/Hotel_(city|name)_lower_trgm/.test(plan) && !/Seq Scan/.test(plan), `typeahead plan uses the Hotel trigram indexes (${plan.match(/Execution Time: [\d.]+ ms/)?.[0] ?? 'no timing'})`)
    console.log('hotel search smoke test passed')
  } finally {
    await prisma.tenant.deleteMany({ where: { id: { in: tenants.map((t) => t.id) } } })
    await prisma.$disconnect()
  }
}

main().catch((error) => { console.error(error); process.exit(1) })
