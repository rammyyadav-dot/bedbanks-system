import { Injectable } from '@nestjs/common'
import type { DestinationResolution, SearchCriteria } from '@bedbanks/domain'
import { PrismaService } from '../database/prisma.service'
import { cityDestinationId } from './search-offers'

const QUERY_LIMIT = 8

@Injectable()
export class DestinationResolverService {
  constructor(private readonly prisma: PrismaService) {}

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

  async facets(tenantId: string): Promise<{ boards: { id: string; name: string }[]; propertyTypes: string[] }> {
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
