import { Inject, Injectable } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { applyDestinationAlias, type DestinationResolution, type SearchCriteria } from '@bedbanks/domain'
import { PrismaService } from '../database/prisma.service'
import { CACHE_PORT, NoopCache, tenantCacheKey, type CachePort } from '../common/cache/cache.port'
import { CacheAside } from '../common/cache/cache-aside'
import { cityDestinationId } from './search-offers'

const QUERY_LIMIT = 8
/** Boards and property types change only when staff edit the catalogue; a minute of staleness is acceptable and Redis absorbs agent traffic. */
const FACETS_TTL_MS = 60_000
/** Typeahead answers are static catalogue content: a minute of staleness after a publication is acceptable (ADR 0065). */
const DESTINATIONS_TTL_MS = 60_000
/** pg_trgm word similarity at which a misspelt word still matches ("Dubia" -> "Dubai"). Below it, results become noise. */
const FUZZY_THRESHOLD = 0.35
const isResolutions = (value: unknown): value is DestinationResolution[] => Array.isArray(value) && value.every((item) => !!item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string')

type Facets = { boards: { id: string; name: string }[]; propertyTypes: string[]; brands: string[] }
const isFacets = (value: unknown): value is Facets => {
  const candidate = value as Partial<Facets> | null
  return !!candidate && Array.isArray(candidate.boards) && Array.isArray(candidate.propertyTypes) && Array.isArray(candidate.brands)
}

type HotelRow = { id: string; name: string; city: string; countryCode: string; citySim: number; nameSim: number }
type PrefixCityRow = { city: string; countryCode: string }

/** "key >= p AND key < p || U+10FFFF" under COLLATE "C" is exactly "key starts with p". Both operands are leakproof, so the runtime login may use the index. */
const prefixBounds = (folded: string) => ({ low: folded, high: `${folded}\u{10FFFF}` })

/** Distinct cities that start with the term, shortest (closest) first, from "Hotel_tenant_id_city_prefix_idx". */
function prefixCitiesSql(tenantId: string, folded: string): Prisma.Sql {
  const { low, high } = prefixBounds(folded)
  return Prisma.sql`
    SELECT min("city") AS "city", "country_code" AS "countryCode"
      FROM "Hotel"
     WHERE "tenant_id" = ${tenantId} AND "content_status" = 'COMPLETE'
       AND ("city_key" COLLATE "C") >= ${low} AND ("city_key" COLLATE "C") < ${high}
     GROUP BY "city_key", "country_code"
     ORDER BY length("city_key") ASC, "city_key" ASC, "country_code" ASC
     LIMIT ${QUERY_LIMIT}`
}

/** Hotels whose name starts with the term, shortest (closest) first, from "Hotel_tenant_id_name_prefix_idx". */
function prefixHotelsSql(tenantId: string, folded: string): Prisma.Sql {
  const { low, high } = prefixBounds(folded)
  return Prisma.sql`
    SELECT "id", "name", "city", "country_code" AS "countryCode"
      FROM "Hotel"
     WHERE "tenant_id" = ${tenantId} AND "content_status" = 'COMPLETE'
       AND ("name_key" COLLATE "C") >= ${low} AND ("name_key" COLLATE "C") < ${high}
     ORDER BY length("name_key") ASC, "name_key" ASC, "id" ASC
     LIMIT ${QUERY_LIMIT}`
}

const matchesTerm = (value: string, similarity: number, folded: string) => value.toLocaleLowerCase('en-US').includes(folded) || similarity >= FUZZY_THRESHOLD
/** Substring hits lead, then the closest fuzzy hits; ties keep the database order. */
const rankTerm = (value: string, similarity: number, folded: string) => (value.toLocaleLowerCase('en-US').startsWith(folded) ? 2 : value.toLocaleLowerCase('en-US').includes(folded) ? 1 : 0) + similarity

function citiesFrom(hotels: HotelRow[], folded: string): DestinationResolution[] {
  const cities: DestinationResolution[] = []
  const seen = new Set<string>()
  for (const hotel of [...hotels].sort((a, b) => rankTerm(b.city, b.citySim, folded) - rankTerm(a.city, a.citySim, folded))) {
    if (!matchesTerm(hotel.city, hotel.citySim, folded)) continue
    const id = cityDestinationId(hotel.countryCode, hotel.city)
    if (!id || seen.has(id)) continue
    seen.add(id)
    cities.push({ type: 'city', id, name: hotel.city.trim(), countryCode: hotel.countryCode })
    if (cities.length === QUERY_LIMIT) break
  }
  return cities
}

function propertiesFrom(hotels: HotelRow[], folded: string): DestinationResolution[] {
  const properties: DestinationResolution[] = []
  for (const hotel of [...hotels].sort((a, b) => rankTerm(b.name, b.nameSim, folded) - rankTerm(a.name, a.nameSim, folded))) {
    if (!matchesTerm(hotel.name, hotel.nameSim, folded)) continue
    const cityId = cityDestinationId(hotel.countryCode, hotel.city)
    if (!cityId) continue
    properties.push({ type: 'hotel', id: hotel.id, name: hotel.name, cityId, cityName: hotel.city.trim(), countryCode: hotel.countryCode })
    if (properties.length === QUERY_LIMIT) break
  }
  return properties
}

@Injectable()
export class DestinationResolverService {
  private readonly staticContent: CacheAside

  constructor(private readonly prisma: PrismaService, @Inject(CACHE_PORT) cache: CachePort = new NoopCache()) {
    this.staticContent = new CacheAside(cache)
  }

  /**
   * Typeahead over the tenant's published catalogue (ADR 0065). The query is rewritten through the reviewed alias table, then matched by
   * substring or by trigram word similarity (typo tolerance), ranked by similarity. Results are real catalogue cities and hotels only.
   */
  async search(tenantId: string, query: string): Promise<DestinationResolution[]> {
    const trimmed = applyDestinationAlias(query.trim().replace(/\s+/g, ' '))
    if (trimmed.length < 2 || trimmed.length > 80) return []
    const folded = trimmed.toLocaleLowerCase('en-US')
    return this.staticContent.read(tenantCacheKey(tenantId, 'agent-destinations', folded), DESTINATIONS_TTL_MS, () => this.loadDestinations(tenantId, folded), { accept: isResolutions })
  }

  /**
   * Prefix hits come first from the "city_key"/"name_key" range indexes (ADR 0099): the runtime login is under forced row-level security, which refuses
   * the trigram indexes (ADR 0074), so only a range comparison avoids scanning the tenant. A category with no prefix hit ("Dubia", "palm") falls back to
   * the substring and word-similarity scan of ADR 0072, so typo tolerance and mid-string matches are unchanged when nothing starts with the term.
   */
  private async loadDestinations(tenantId: string, folded: string): Promise<DestinationResolution[]> {
    const { prefixCities, prefixHotels, scanned } = await this.prisma.withTenant(tenantId, async (tx) => {
      const prefixCities = await tx.$queryRaw<PrefixCityRow[]>(prefixCitiesSql(tenantId, folded))
      const prefixHotels = await tx.$queryRaw<HotelRow[]>(prefixHotelsSql(tenantId, folded))
      const scanned = prefixCities.length && prefixHotels.length ? null : await this.scanDestinations(tx, tenantId, folded)
      return { prefixCities, prefixHotels, scanned }
    })
    const cities = prefixCities.length ? citiesFrom(prefixCities.map((row) => ({ ...row, id: '', name: row.city, citySim: 0, nameSim: 0 })), folded) : citiesFrom(scanned ?? [], folded)
    const properties = prefixHotels.length ? propertiesFrom(prefixHotels.map((row) => ({ ...row, citySim: 0, nameSim: 0 })), folded) : propertiesFrom(scanned ?? [], folded)
    return [...cities, ...properties]
  }

  private async scanDestinations(tx: Prisma.TransactionClient, tenantId: string, folded: string): Promise<HotelRow[]> {
    const pattern = `%${folded.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    // `term <% column` is word_similarity(term, column) >= pg_trgm.word_similarity_threshold. Unlike the function form it can use the
    // Hotel_*_lower_trgm GIN indexes (migration 202610180001). The threshold is transaction-local, so it is safe behind a pooler.
    await tx.$executeRaw`SELECT set_config('pg_trgm.word_similarity_threshold', ${String(FUZZY_THRESHOLD)}, true)`
    return tx.$queryRaw<HotelRow[]>(Prisma.sql`
      SELECT "id", "name", "city", "country_code" AS "countryCode",
             word_similarity(${folded}, lower("city"))::float8 AS "citySim",
             word_similarity(${folded}, lower("name"))::float8 AS "nameSim"
        FROM "Hotel"
       WHERE "tenant_id" = ${tenantId} AND "content_status" = 'COMPLETE'
         AND (lower("city") LIKE ${pattern} OR lower("name") LIKE ${pattern}
              OR ${folded} <% lower("city") OR ${folded} <% lower("name"))
       ORDER BY GREATEST(word_similarity(${folded}, lower("city")), word_similarity(${folded}, lower("name"))) DESC, "city" ASC, "name" ASC
       LIMIT 50`)
  }

  /** Tenant-keyed static content (cache-aside). A cache fault falls through to the database; see CacheAside. */
  async facets(tenantId: string): Promise<Facets> {
    return this.staticContent.read(tenantCacheKey(tenantId, 'agent-facets', 'all'), FACETS_TTL_MS, () => this.loadFacets(tenantId), { accept: isFacets })
  }

  private async loadFacets(tenantId: string): Promise<Facets> {
    const [boards, hotels, profiles] = await Promise.all([
      this.prisma.withTenant(tenantId, (tx) => tx.boardBasis.findMany({
        where: { tenantId, isActive: true },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
        take: 40,
      })),
      this.prisma.withTenant(tenantId, (tx) => tx.hotel.findMany({
        where: { tenantId, contentStatus: 'COMPLETE' },
        select: { propertyType: true },
        distinct: ['propertyType'],
        take: 40,
      })),
      // ADR 0021: only the catalogue brand name is read here, never contacts.
      this.prisma.withTenant(tenantId, (tx) => tx.hotelProfile.findMany({
        where: { tenantId, brandName: { not: null }, hotel: { contentStatus: 'COMPLETE' } },
        select: { brandName: true },
        distinct: ['brandName'],
        take: 100,
      })),
    ])
    return {
      boards: boards.filter((board) => board.id && board.name).map((board) => ({ id: board.id, name: board.name })),
      propertyTypes: [...new Set(hotels.map((hotel) => hotel.propertyType).filter((value) => value.trim().length > 0))].sort(),
      brands: [...new Set(profiles.map((profile) => profile.brandName).filter((value): value is string => !!value && value.trim().length > 0))].sort(),
    }
  }

  /** Overwrites destination from the tenant catalogue. Returns null when the canonical id no longer resolves. */
  async apply(tenantId: string, criteria: SearchCriteria): Promise<SearchCriteria | null> {
    const ref = criteria.destinationRef
    if (!ref) return criteria
    if (ref.type === 'hotel') {
      const hotel = await this.prisma.withTenant(tenantId, (tx) => tx.hotel.findFirst({
        where: { id: ref.id, tenantId, contentStatus: 'COMPLETE' },
        select: { id: true, city: true },
      }))
      if (!hotel || !hotel.city.trim()) return null
      return {
        ...criteria,
        destination: hotel.city.trim(),
        canonicalHotelIds: [hotel.id],
        destinationRef: { type: 'hotel', id: hotel.id },
      }
    }
    if (ref.type !== 'city') return null
    const rows = await this.prisma.withTenant(tenantId, (tx) => tx.hotel.findMany({
      where: { tenantId, contentStatus: 'COMPLETE', countryCode: ref.countryCode },
      select: { city: true, countryCode: true },
      distinct: ['city'],
    }))
    const match = rows.find((row) => cityDestinationId(row.countryCode, row.city) === ref.id)
    if (!match) return null
    const next = { ...criteria, destination: match.city.trim(), destinationRef: { type: 'city' as const, id: ref.id, countryCode: match.countryCode } }
    delete next.canonicalHotelIds
    return next
  }
}
