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

type Facets = { boards: { id: string; name: string }[]; propertyTypes: string[] }
const isFacets = (value: unknown): value is Facets => {
  const candidate = value as Partial<Facets> | null
  return !!candidate && Array.isArray(candidate.boards) && Array.isArray(candidate.propertyTypes)
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

  private async loadDestinations(tenantId: string, folded: string): Promise<DestinationResolution[]> {
    const pattern = `%${folded.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    // `term <% column` is word_similarity(term, column) >= pg_trgm.word_similarity_threshold. Unlike the function form it can use the
    // Hotel_*_lower_trgm GIN indexes (migration 202610180001). The threshold is transaction-local, so it is safe behind a pooler.
    const hotels = await this.prisma.withTenant(tenantId, async (tx) => {
      await tx.$executeRaw`SELECT set_config('pg_trgm.word_similarity_threshold', ${String(FUZZY_THRESHOLD)}, true)`
      return tx.$queryRaw<Array<{ id: string; name: string; city: string; countryCode: string; citySim: number; nameSim: number }>>(Prisma.sql`
      SELECT "id", "name", "city", "country_code" AS "countryCode",
             word_similarity(${folded}, lower("city"))::float8 AS "citySim",
             word_similarity(${folded}, lower("name"))::float8 AS "nameSim"
        FROM "Hotel"
       WHERE "tenant_id" = ${tenantId} AND "content_status" = 'COMPLETE'
         AND (lower("city") LIKE ${pattern} OR lower("name") LIKE ${pattern}
              OR ${folded} <% lower("city") OR ${folded} <% lower("name"))
       ORDER BY GREATEST(word_similarity(${folded}, lower("city")), word_similarity(${folded}, lower("name"))) DESC, "city" ASC, "name" ASC
       LIMIT 50`)
    })
    const matches = (value: string, similarity: number) => value.toLocaleLowerCase('en-US').includes(folded) || similarity >= FUZZY_THRESHOLD
    // Substring hits lead, then the closest fuzzy hits; ties keep the database order.
    const rank = (value: string, similarity: number) => (value.toLocaleLowerCase('en-US').startsWith(folded) ? 2 : value.toLocaleLowerCase('en-US').includes(folded) ? 1 : 0) + similarity
    const cities: Array<DestinationResolution & { score: number }> = []
    const seen = new Set<string>()
    for (const hotel of [...hotels].sort((a, b) => rank(b.city, b.citySim) - rank(a.city, a.citySim))) {
      if (!matches(hotel.city, hotel.citySim)) continue
      const id = cityDestinationId(hotel.countryCode, hotel.city)
      if (!id || seen.has(id)) continue
      seen.add(id)
      cities.push({ type: 'city', id, name: hotel.city.trim(), countryCode: hotel.countryCode, score: rank(hotel.city, hotel.citySim) })
      if (cities.length === QUERY_LIMIT) break
    }
    const properties: DestinationResolution[] = []
    for (const hotel of [...hotels].sort((a, b) => rank(b.name, b.nameSim) - rank(a.name, a.nameSim))) {
      if (!matches(hotel.name, hotel.nameSim)) continue
      const cityId = cityDestinationId(hotel.countryCode, hotel.city)
      if (!cityId) continue
      properties.push({ type: 'hotel', id: hotel.id, name: hotel.name, cityId, cityName: hotel.city.trim(), countryCode: hotel.countryCode })
      if (properties.length === QUERY_LIMIT) break
    }
    return [...cities.map(({ score: _score, ...city }) => city as DestinationResolution), ...properties]
  }

  /** Tenant-keyed static content (cache-aside). A cache fault falls through to the database; see CacheAside. */
  async facets(tenantId: string): Promise<Facets> {
    return this.staticContent.read(tenantCacheKey(tenantId, 'agent-facets', 'all'), FACETS_TTL_MS, () => this.loadFacets(tenantId), { accept: isFacets })
  }

  private async loadFacets(tenantId: string): Promise<Facets> {
    const [boards, hotels] = await Promise.all([
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
    ])
    return {
      boards: boards.filter((board) => board.id && board.name).map((board) => ({ id: board.id, name: board.name })),
      propertyTypes: [...new Set(hotels.map((hotel) => hotel.propertyType).filter((value) => value.trim().length > 0))].sort(),
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
