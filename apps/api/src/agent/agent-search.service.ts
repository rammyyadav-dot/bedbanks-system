import { Inject, Injectable } from '@nestjs/common'
import { createHash, randomUUID } from 'crypto'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { CACHE_PORT, NoopCache, tenantCacheKey, type CachePort } from '../common/cache/cache.port'
import { AgentAuditService } from './audit.service'
import { SupplierAdapter, SUPPLIER_ADAPTER, type HotelSearchCriteria } from './supplier.port'
import { validateSearchHotels } from '@bedbanks/domain/search-offers'

const DEFAULT_SEARCH_TTL_MS = 45_000
const MIN_SEARCH_TTL_MS = 1_000
const MAX_SEARCH_TTL_MS = 120_000

type SearchResponse = {
  version: 1
  searchId: string
  requestId: string
  generatedAt: string
  request: HotelSearchCriteria
  status: 'available' | 'partial' | 'no_availability' | 'provider_unavailable' | 'mapping_unavailable'
  hotels: unknown[]
  total: number
  providerSummary: { queried: number; succeeded: number; failed: number }
}

@Injectable()
export class AgentSearchService {
  constructor(
    @Inject(SUPPLIER_ADAPTER) private readonly supplier: SupplierAdapter,
    private readonly audit: AgentAuditService,
    @Inject(CACHE_PORT) private readonly cache: CachePort = new NoopCache(),
  ) {}

  async execute(criteria: HotelSearchCriteria, tenantId: string, requestId: string, identity: AuthenticatedUser): Promise<SearchResponse> {
    const request = this.normalize(criteria)
    const key = tenantCacheKey(tenantId, 'agent-search', this.identity(request))
    const cached = await this.safeGet<SearchResponse>(key)
    if (cached) {
      return { ...cached, searchId: randomUUID(), requestId, generatedAt: new Date().toISOString() }
    }

    const fresh = await this.fetchFresh(request, tenantId, requestId, identity)
    if (fresh.status === 'available' || fresh.status === 'partial' || fresh.status === 'no_availability') {
      await this.safeSet(key, fresh)
    }
    return fresh
  }

  private async fetchFresh(request: HotelSearchCriteria, tenantId: string, requestId: string, identity: AuthenticatedUser): Promise<SearchResponse> {
    const searchId = randomUUID()
    const generatedAt = new Date().toISOString()
    if (this.supplier.name === 'unconfigured') {
      return { version: 1, searchId, requestId, generatedAt, request, status: 'provider_unavailable', hotels: [], total: 0,
        providerSummary: { queried: 0, succeeded: 0, failed: 0 } }
    }

    let raw: Awaited<ReturnType<SupplierAdapter['search']>>
    try {
      raw = await this.supplier.search(request, { tenantId, requestId })
    } catch {
      return { version: 1, searchId, requestId, generatedAt, request, status: 'provider_unavailable', hotels: [], total: 0,
        providerSummary: { queried: 1, succeeded: 0, failed: 1 } }
    }

    const summary = raw.providerSummary
    const validSummary = summary && Number.isSafeInteger(summary.queried) && Number.isSafeInteger(summary.succeeded) &&
      Number.isSafeInteger(summary.failed) && summary.queried >= 0 && summary.succeeded >= 0 && summary.failed >= 0 &&
      summary.succeeded + summary.failed <= summary.queried
    const result = validSummary ? validateSearchHotels(raw.offers, request, Date.now(), tenantId) : { ok: false as const, reason: 'mapping_unavailable' as const }

    if (!result.ok) {
      await this.audit.record({ tenantId, user: identity, action: 'hotel.search.mapping_unavailable',
        entityType: 'search', entityId: searchId, payload: { destination: request.destination, requestId } })
      return { version: 1, searchId, requestId, generatedAt, request, status: 'mapping_unavailable', hotels: [], total: 0,
        providerSummary: validSummary ? summary : { queried: 1, succeeded: 0, failed: 1 } }
    }

    const status = result.hotels.length
      ? raw.providerSummary.failed > 0 ? 'partial' : 'available'
      : raw.providerSummary.failed > 0 && raw.providerSummary.succeeded === 0 ? 'provider_unavailable' : 'no_availability'
    await this.audit.record({ tenantId, user: identity, action: 'hotel.search', entityType: 'search', entityId: searchId,
      payload: { destination: request.destination, supplier: this.supplier.name, resultCount: result.hotels.length, requestId, status } })
    return { version: 1, searchId, requestId, generatedAt, request, status,
      hotels: result.hotels, total: result.hotels.length, providerSummary: raw.providerSummary }
  }

  private normalize(criteria: HotelSearchCriteria): HotelSearchCriteria {
    const filters = criteria.filters ? {
      ...(criteria.filters.starRatings ? { starRatings: [...criteria.filters.starRatings].sort((a, b) => a - b) } : {}),
      ...(criteria.filters.boardBasisIds ? { boardBasisIds: [...criteria.filters.boardBasisIds].sort() } : {}),
      ...(criteria.filters.refundableOnly !== undefined ? { refundableOnly: criteria.filters.refundableOnly } : {}),
      ...(criteria.filters.minPriceMinor !== undefined ? { minPriceMinor: criteria.filters.minPriceMinor } : {}),
      ...(criteria.filters.maxPriceMinor !== undefined ? { maxPriceMinor: criteria.filters.maxPriceMinor } : {}),
    } : undefined
    return {
      destination: criteria.destination.trim(),
      checkIn: criteria.checkIn,
      checkOut: criteria.checkOut,
      rooms: criteria.rooms,
      adults: criteria.adults,
      children: criteria.children,
      childAges: [...criteria.childAges],
      nationality: criteria.nationality.trim().toUpperCase(),
      currency: criteria.currency?.trim().toUpperCase(),
      ...(criteria.canonicalHotelIds ? { canonicalHotelIds: [...criteria.canonicalHotelIds].sort() } : {}),
      ...(criteria.limit ? { limit: criteria.limit } : {}),
      ...(filters ? { filters } : {}),
    }
  }

  private identity(request: HotelSearchCriteria): string {
    return createHash('sha256').update(JSON.stringify(request)).digest('hex')
  }

  private ttlMs(): number {
    const parsed = Number(process.env.AGENT_SEARCH_CACHE_TTL_MS ?? DEFAULT_SEARCH_TTL_MS)
    if (!Number.isSafeInteger(parsed)) return DEFAULT_SEARCH_TTL_MS
    return Math.min(MAX_SEARCH_TTL_MS, Math.max(MIN_SEARCH_TTL_MS, parsed))
  }

  private async safeGet<T>(key: string): Promise<T | null> {
    try { return await this.cache.get<T>(key) } catch { return null }
  }

  private async safeSet<T>(key: string, value: T): Promise<void> {
    try { await this.cache.set(key, value, { ttlMs: this.ttlMs() }) } catch { /* cache cannot block search */ }
  }
}
