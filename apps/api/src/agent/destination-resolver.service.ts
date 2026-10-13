import { Inject, Injectable } from '@nestjs/common'
import type { DestinationResolution, SearchCriteria } from '@bedbanks/domain'
import { PrismaService } from '../database/prisma.service'
import { CACHE_PORT, NoopCache, tenantCacheKey, type CachePort } from '../common/cache/cache.port'
import { CacheAside } from '../common/cache/cache-aside'
import { cityDestinationId } from './search-offers'

const QUERY_LIMIT = 8
/** Boards and property types change only when staff edit the catalogue; a minute of staleness is acceptable and Redis absorbs agent traffic. */
const FACETS_TTL_MS = 60_000

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

  async search(tenantId: string, query: string): Promise<DestinationResolution[]> {
    const trimmed = query.trim().replace(/\s+/g, ' ')
    if (trimmed.length < 2 || trimmed.length > 80) return []
    const hotels = await this.prisma.withTenant(tenantId, (tx) => tx.hotel.findMany({
      where: {
        tenantId,
        contentStatus: 'COMPLETE',
        OR: [
          { city: { contains: trimmed, mode: 'insensitive' } },
          { name: { contains: trimmed, mode: 'insensitive' } },
        ],
      },
      select: { id: true, name: true, city: true, countryCode: true },
      orderBy: [{ city: 'asc' }, { name: 'asc' }],
      take: 50,
    }))
    const folded = trimmed.toLocaleLowerCase('en-US')
    const cities: DestinationResolution[] = []
    const seen = new Set<string>()
    for (const hotel of hotels) {
      if (!hotel.city.toLocaleLowerCase('en-US').includes(folded)) continue
      const id = cityDestinationId(hotel.countryCode, hotel.city)
      if (!id || seen.has(id)) continue
      seen.add(id)
      cities.push({ type: 'city', id, name: hotel.city.trim(), countryCode: hotel.countryCode })
      if (cities.length === QUERY_LIMIT) break
    }
    const properties: DestinationResolution[] = []
    for (const hotel of hotels) {
      if (!hotel.name.toLocaleLowerCase('en-US').includes(folded)) continue
      const cityId = cityDestinationId(hotel.countryCode, hotel.city)
      if (!cityId) continue
      properties.push({
        type: 'hotel',
        id: hotel.id,
        name: hotel.name,
        cityId,
        cityName: hotel.city.trim(),
        countryCode: hotel.countryCode,
      })
      if (properties.length === QUERY_LIMIT) break
    }
    return [...cities, ...properties]
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
