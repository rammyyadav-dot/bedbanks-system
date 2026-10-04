import { PrismaClient } from '@prisma/client'
import { retrieveHotelCandidates, upsertHotelSearchIndex } from '../src/mapping/hotel-search-index'

const databaseUrl = process.env.MAPPING_DATABASE_URL
const prisma = new PrismaClient(databaseUrl ? { datasources: { db: { url: databaseUrl } } } : undefined)

describe('disposable hotel search index', () => {
  const suffix = `map-${Date.now()}`
  let tenantA = ''
  let tenantB = ''
  let hotelA = ''
  let hotelB = ''

  beforeAll(async () => {
    if (!databaseUrl) throw new Error('MAPPING_DATABASE_URL is required for the disposable vector test')
    await prisma.$connect()
    await prisma.$executeRawUnsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fbeds_map_reader') THEN CREATE ROLE fbeds_map_reader NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$`)
    // PostgreSQL 16: a non-superuser (CREATEROLE) owner needs an explicit membership to SET ROLE to a role it created.
    await prisma.$executeRawUnsafe(`GRANT fbeds_map_reader TO CURRENT_USER`)
    await prisma.$executeRawUnsafe(`GRANT SELECT ON "HotelSearchIndex" TO fbeds_map_reader`)
    const a = await prisma.tenant.create({ data: { name: `${suffix} A`, slug: `${suffix}-a` } })
    const b = await prisma.tenant.create({ data: { name: `${suffix} B`, slug: `${suffix}-b` } })
    tenantA = a.id
    tenantB = b.id
    const hotel = await prisma.hotel.create({ data: { tenantId: tenantA, name: 'DoubleTree by Hilton Dubai Al Jadaf', propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', address: 'Al Jadaf Street' } })
    const other = await prisma.hotel.create({ data: { tenantId: tenantB, name: 'DoubleTree by Hilton Dubai Al Jadaf', propertyType: 'HOTEL', city: 'Dubai', countryCode: 'AE', address: 'Al Jadaf Street' } })
    hotelA = hotel.id
    hotelB = other.id
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantA}, true)`
      await upsertHotelSearchIndex(tx, tenantA, { hotelId: hotelA, name: hotel.name, address: hotel.address, city: hotel.city, countryCode: hotel.countryCode })
    })
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantB}, true)`
      await upsertHotelSearchIndex(tx, tenantB, { hotelId: hotelB, name: other.name, address: other.address, city: other.city, countryCode: other.countryCode })
    })
  })

  afterAll(async () => {
    if (tenantA) await prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } })
    await prisma.$disconnect()
  })

  it('returns only the active tenant from the vector index', async () => {
    const started = Date.now()
    const rows = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantA}, true)`
      await tx.$executeRawUnsafe('SET LOCAL ROLE fbeds_map_reader')
      return retrieveHotelCandidates(tx, tenantA, { name: 'Double Tree Hilton Al Jaddaf', address: 'Al Jadaf Street', city: 'Dubai', countryCode: 'AE' })
    })
    const elapsed = Date.now() - started
    expect(rows.map((row) => row.hotelId)).toEqual([hotelA])
    expect(rows[0].vectorSimilarity).toBeGreaterThan(0.5)
    expect(elapsed).toBeLessThan(1_000)
  })

  it('retrieves a candidate from 100 tenant hotels without crossing tenants', async () => {
    const started = Date.now()
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantA}, true)`
      for (let index = 0; index < 100; index += 1) {
        const hotel = await tx.hotel.create({
          data: {
            tenantId: tenantA,
            name: `Benchmark Hotel ${index} Dubai`,
            propertyType: 'HOTEL',
            city: 'Dubai',
            countryCode: 'AE',
            address: `${index} Benchmark Street`,
          },
        })
        await upsertHotelSearchIndex(tx, tenantA, {
          hotelId: hotel.id,
          name: hotel.name,
          address: hotel.address,
          city: hotel.city,
          countryCode: hotel.countryCode,
        })
      }
    })
    const indexedMs = Date.now() - started
    const lookupStarted = Date.now()
    const rows = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantA}, true)`
      await tx.$executeRawUnsafe('SET LOCAL ROLE fbeds_map_reader')
      return retrieveHotelCandidates(tx, tenantA, { name: 'Double Tree Hilton Al Jaddaf', address: 'Al Jadaf Street', city: 'Dubai', countryCode: 'AE' })
    })
    const lookupMs = Date.now() - lookupStarted
    expect(rows.some((row) => row.hotelId === hotelA)).toBe(true)
    expect(rows.some((row) => row.hotelId === hotelB)).toBe(false)
    expect(lookupMs).toBeLessThan(1_000)
    const { mkdirSync, writeFileSync } = await import('fs')
    mkdirSync('/opt/cursor/artifacts', { recursive: true })
    writeFileSync('/opt/cursor/artifacts/mapping-candidate-metrics.json', JSON.stringify({ indexedHotels: 102, indexWriteMs: indexedMs, candidateLookupMs: lookupMs, returned: rows.length }, null, 2))
  })

  it('returns no rows when the restricted role has no tenant context', async () => {
    const rows = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE fbeds_map_reader')
      return tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "HotelSearchIndex"`
    })
    expect(rows).toEqual([])
  })
})
