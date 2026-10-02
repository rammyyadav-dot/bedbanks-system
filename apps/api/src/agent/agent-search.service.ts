import { Inject, Injectable } from '@nestjs/common'
import { createHash, randomUUID } from 'crypto'
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface'
import { CACHE_PORT, COORDINATION_PORT, NoopCache, NoopCoordination, tenantCacheKey, type CachePort, type CoordinationPort } from '../common/cache/cache.port'
import { AgentAuditService } from './audit.service'
import { SupplierAdapter, SUPPLIER_ADAPTER, type HotelSearchCriteria } from './supplier.port'
import type { SearchPagination } from '@bedbanks/domain'
import { validateSearchHotels } from './search-offers'

const DEFAULT_SEARCH_TTL_MS = 45_000
const MIN_SEARCH_TTL_MS = 1_000
const MAX_SEARCH_TTL_MS = 120_000
const SEARCH_LOCK_TTL_MS = 12_000
const SEARCH_LOCK_WAIT_MS = 750
const SEARCH_LOCK_POLL_MS = 75

type SearchResponse = {
  version: 1
  searchId: string
  requestId: string
  generatedAt: string
  request: HotelSearchCriteria
  status: 'available' | 'partial' | 'no_availability' | 'provider_unavailable' | 'mapping_unavailable'
  hotels: unknown[]
  total: number
  pagination: SearchPagination
  providerSummary: { queried: number; succeeded: number; failed: number }
}

@Injectable()
export class AgentSearchService {
  constructor(
    @Inject(SUPPLIER_ADAPTER) private readonly supplier: SupplierAdapter,
    private readonly audit: AgentAuditService,
    @Inject(CACHE_PORT) private readonly cache: CachePort = new NoopCache(),
    @Inject(COORDINATION_PORT) private readonly coordination: CoordinationPort = new NoopCoordination(),
  ) {}

  async execute(criteria: HotelSearchCriteria, tenantId: string, requestId: string, identity: AuthenticatedUser): Promise<SearchResponse> {
    const request = this.normalize(criteria)
    const key = tenantCacheKey(tenantId, 'agent-search', this.identity(request))
    const authoritative = this.authoritativeInventory()
    const rawCached = authoritative ? null : await this.safeGet<unknown>(key)
    const cached = this.acceptCached(rawCached, tenantId, request)
    if (rawCached && !cached) await this.cache.delete(key).catch(() => undefined)
    if (cached) {
      return { ...cached, searchId: randomUUID(), requestId, generatedAt: new Date().toISOString() }
    }

    const lockKey = `${key}:lock`
    let lease = null
    try { lease = await this.coordination.acquire(lockKey, SEARCH_LOCK_TTL_MS) } catch { /* coordination is optional */ }

    if (!lease && !authoritative) {
      const coalesced = await this.waitForCached(key, tenantId, request)
      if (coalesced) return { ...coalesced, searchId: randomUUID(), requestId, generatedAt: new Date().toISOString() }
      // Lock contention/outage must not turn into false unavailability. Fall through to authoritative search.
    }

    try {
      const fresh = await this.fetchFresh(request, tenantId, requestId, identity)
      // Contracted inventory is not cached: the next search must observe stop-sell and rate edits.
      // Recheck remains the booking authority for every supplier.
      if (!authoritative && (fresh.status === 'available' || fresh.status === 'partial' || fresh.status === 'no_availability')) {
        await this.safeSet(key, fresh)
      }
      return fresh
    } finally {
      if (lease) {
        try { await this.coordination.release(lease) } catch { /* lease TTL bounds orphaned locks */ }
      }
    }
  }

  private async fetchFresh(request: HotelSearchCriteria, tenantId: string, requestId: string, identity: AuthenticatedUser): Promise<SearchResponse> {
    const searchId = randomUUID()
    const generatedAt = new Date().toISOString()
    if (this.supplier.name === 'unconfigured') {
      return { version: 1, searchId, requestId, generatedAt, request, status: 'provider_unavailable', hotels: [], total: 0,
        pagination: this.pagination(request, 0, 0),
        providerSummary: { queried: 0, succeeded: 0, failed: 0 } }
    }

    let raw: Awaited<ReturnType<SupplierAdapter['search']>>
    try {
      raw = await this.supplier.search(request, { tenantId, requestId })
    } catch {
      return { version: 1, searchId, requestId, generatedAt, request, status: 'provider_unavailable', hotels: [], total: 0,
        pagination: this.pagination(request, 0, 0),
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
        pagination: this.pagination(request, 0, 0),
        providerSummary: validSummary ? summary : { queried: 1, succeeded: 0, failed: 1 } }
    }

    const status = result.hotels.length
      ? raw.providerSummary.failed > 0 ? 'partial' : 'available'
      : raw.providerSummary.failed > 0 && raw.providerSummary.succeeded === 0 ? 'provider_unavailable' : 'no_availability'
    await this.audit.record({ tenantId, user: identity, action: 'hotel.search', entityType: 'search', entityId: searchId,
      payload: { destination: request.destination, supplier: this.supplier.name, resultCount: result.hotels.length, matchedTotal: result.matchedTotal, requestId, status } })
    return { version: 1, searchId, requestId, generatedAt, request, status,
      hotels: result.hotels, total: result.hotels.length, pagination: this.pagination(request, result.hotels.length, result.matchedTotal),
      providerSummary: raw.providerSummary }
  }

  private pagination(request: HotelSearchCriteria, pageLength: number, matchedTotal: number): SearchPagination {
    const limit = request.limit ?? 50
    const offset = request.offset ?? 0
    const hasMore = offset + pageLength < matchedTotal
    return { limit, offset, total: matchedTotal, hasMore, ...(hasMore ? { nextOffset: offset + limit } : {}) }
  }

  private normalize(criteria: HotelSearchCriteria): HotelSearchCriteria {
    const filters = criteria.filters ? {
      ...(criteria.filters.starRatings ? { starRatings: [...criteria.filters.starRatings].sort((a, b) => a - b) } : {}),
      ...(criteria.filters.boardBasisIds ? { boardBasisIds: [...criteria.filters.boardBasisIds].sort() } : {}),
      ...(criteria.filters.refundableOnly !== undefined ? { refundableOnly: criteria.filters.refundableOnly } : {}),
      ...(criteria.filters.minPriceMinor !== undefined ? { minPriceMinor: criteria.filters.minPriceMinor } : {}),
      ...(criteria.filters.maxPriceMinor !== undefined ? { maxPriceMinor: criteria.filters.maxPriceMinor } : {}),
      ...(criteria.filters.propertyTypes ? { propertyTypes: [...criteria.filters.propertyTypes].sort() } : {}),
    } : undefined
    const destinationRef = criteria.destinationRef?.type === 'city'
      ? { type: 'city' as const, id: criteria.destinationRef.id, countryCode: criteria.destinationRef.countryCode }
      : criteria.destinationRef?.type === 'hotel'
        ? { type: 'hotel' as const, id: criteria.destinationRef.id }
        : undefined
    return {
      destination: criteria.destination.trim(),
      ...(destinationRef ? { destinationRef } : {}),
      checkIn: criteria.checkIn,
      checkOut: criteria.checkOut,
      rooms: criteria.rooms,
      adults: criteria.adults,
      children: criteria.children,
      childAges: [...criteria.childAges],
      ...(criteria.roomStays ? { roomStays: criteria.roomStays.map((stay) => ({ adults: stay.adults, children: stay.children.map((child) => ({ age: child.age })) })) } : {}),
      nationality: criteria.nationality.trim().toUpperCase(),
      currency: criteria.currency?.trim().toUpperCase(),
      ...(criteria.sort && criteria.sort !== 'default' ? { sort: criteria.sort } : {}),
      ...(criteria.canonicalHotelIds ? { canonicalHotelIds: [...criteria.canonicalHotelIds].sort() } : {}),
      ...(criteria.limit ? { limit: criteria.limit } : {}),
      ...(criteria.offset ? { offset: criteria.offset } : {}),
      ...(filters ? { filters } : {}),
    }
  }

  private identity(request: HotelSearchCriteria): string {
    return createHash('sha256').update(JSON.stringify(request)).digest('hex')
  }

  private authoritativeInventory(): boolean {
    return this.supplier.name === 'contracted-inventory'
  }

  private acceptCached(value: unknown, tenantId: string, request: HotelSearchCriteria): SearchResponse | null {
    if (!value || typeof value !== 'object') return null
    const cached = value as SearchResponse
    const limit = request.limit ?? 50
    const offset = request.offset ?? 0
    if (cached.version !== 1 || !Array.isArray(cached.hotels) || !cached.pagination) return null
    if (cached.pagination.limit !== limit || cached.pagination.offset !== offset) return null
    if (!['available', 'partial', 'no_availability'].includes(cached.status)) return null
    for (const hotel of cached.hotels) {
      if (!hotel || typeof hotel !== 'object') return null
      const rooms = (hotel as { rooms?: unknown }).rooms
      if (!Array.isArray(rooms)) return null
      for (const room of rooms) {
        const rates = (room as { rates?: unknown }).rates
        if (!Array.isArray(rates)) return null
        for (const rate of rates) {
          const row = rate as { tenantId?: string; canonicalHotelId?: string; canonicalRoomTypeId?: string }
          if (row.tenantId !== tenantId || !row.canonicalHotelId || !row.canonicalRoomTypeId) return null
        }
      }
    }
    return cached
  }

  private ttlMs(): number {
    const parsed = Number(process.env.AGENT_SEARCH_CACHE_TTL_MS ?? DEFAULT_SEARCH_TTL_MS)
    if (!Number.isSafeInteger(parsed)) return DEFAULT_SEARCH_TTL_MS
    return Math.min(MAX_SEARCH_TTL_MS, Math.max(MIN_SEARCH_TTL_MS, parsed))
  }

  private async waitForCached(key: string, tenantId: string, request: HotelSearchCriteria): Promise<SearchResponse | null> {
    const deadline = Date.now() + SEARCH_LOCK_WAIT_MS
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, SEARCH_LOCK_POLL_MS))
      const cached = this.acceptCached(await this.safeGet<unknown>(key), tenantId, request)
      if (cached) return cached
    }
    return null
  }

  private async safeGet<T>(key: string): Promise<T | null> {
    try { return await this.cache.get<T>(key) } catch { return null }
  }

  private async safeSet<T>(key: string, value: T): Promise<void> {
    try { await this.cache.set(key, value, { ttlMs: this.ttlMs() }) } catch { /* cache cannot block search */ }
  }
}
