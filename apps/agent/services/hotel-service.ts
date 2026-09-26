import type { Hotel, HotelSearchCriteria, HotelSearchResult, OfferHoldResult } from '../types/hotel.ts'
import type { SearchRateOffer } from '@bedbanks/domain'
import { agentApiBase } from '../lib/api-config.mjs'
import { validSearchCriteria, validateAgentSearchResponse } from '@bedbanks/domain/search-offers'

// Sample inventory is isolated here. It is never a response to a failed live request.
export const DEMO_HOTELS: Hotel[] = [
  { id: 'demo-dubai-1', name: 'One&Only Royal Mirage', city: 'Dubai', country: 'United Arab Emirates', stars: 5, rating: 4.9, price: 820, rack: 1260, rooms: 12, supplier: 'Demo inventory', board: 'Breakfast included', image: 'https://images.unsplash.com/photo-1564501049412-61c2a3083791?auto=format&fit=crop&w=900&q=80', amenities: ['Private beach', 'Spa', 'WiFi'], distance: '0.5 km from City Center', reviews: 4927, cancellation: 'Free cancellation until 07 Sep', mappingStatus: 'mapped', availabilityStatus: 'available' },
  { id: 'demo-dubai-2', name: 'Palace Downtown', city: 'Dubai', country: 'United Arab Emirates', stars: 5, rating: 4.9, price: 760, rack: 1160, rooms: 14, supplier: 'Demo inventory', board: 'Bed & breakfast', image: 'https://images.unsplash.com/photo-1582719478250-c89cae4dc85b?auto=format&fit=crop&w=900&q=80', amenities: ['Rooftop pool', 'Dining', 'WiFi'], distance: '3.5 km from City Center', reviews: 5341, cancellation: 'Free cancellation until 08 Sep', mappingStatus: 'mapped', availabilityStatus: 'available' },
  { id: 'demo-dubai-3', name: 'Nikki Beach Resort & Spa', city: 'Dubai', country: 'United Arab Emirates', stars: 5, rating: 4.8, price: 690, rack: 1080, rooms: 8, supplier: 'Demo inventory', board: 'Room only', image: 'https://images.unsplash.com/photo-1540541338287-41700207dee6?auto=format&fit=crop&w=900&q=80', amenities: ['Beach club', 'Spa', 'WiFi'], distance: '2.1 km from City Center', reviews: 3421, cancellation: 'Free cancellation until 06 Sep', mappingStatus: 'mapped', availabilityStatus: 'limited' },
]

export interface HotelService {
  search(criteria: HotelSearchCriteria, tenantId: string): Promise<HotelSearchResult>
  holdOffer(rate: SearchRateOffer, searchId: string, tenantId: string, idempotencyKey: string): Promise<OfferHoldResult>
  getById(id: string): Promise<Hotel | null>
}

export class ApiHotelService implements HotelService {
  private readonly baseUrl: string
  constructor(baseUrl = agentApiBase) { this.baseUrl = baseUrl }

  async search(criteria: HotelSearchCriteria, tenantId: string): Promise<HotelSearchResult> {
    const empty = (status: HotelSearchResult['status']): HotelSearchResult =>
      ({ hotels: [], liveHotels: [], total: 0, isDemo: false, source: 'api', status, request: criteria })
    if (!validSearchCriteria(criteria)) return empty('mapping_unavailable')
    if (process.env.NEXT_PUBLIC_ENABLE_DEMO_INVENTORY === 'true' && process.env.NODE_ENV !== 'production') {
      const hotels = DEMO_HOTELS.filter((hotel) =>
        !criteria.destination || `${hotel.name} ${hotel.city}`.toLowerCase().includes(criteria.destination.toLowerCase()),
      )
      return { hotels, liveHotels: [], total: hotels.length, isDemo: true, source: 'mock', status: 'demo', request: criteria }
    }
    if (!this.baseUrl) return empty('provider_unavailable')
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 10_000)
      let response: Response
      try {
        response = await fetch(`${this.baseUrl}/agent/search`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-fbeds-tenant-id': tenantId },
          credentials: 'include',
          body: JSON.stringify(criteria),
          signal: controller.signal,
        })
      } finally {
        clearTimeout(timeout)
      }
      if (response.status === 401) return empty('auth_required')
      if (response.status === 403) return empty('access_denied')
      if (!response.ok) return empty('provider_unavailable')
      const envelope: unknown = await response.json()
      const data: unknown = typeof envelope === 'object' && envelope !== null && 'data' in envelope ? envelope.data : envelope
      const validated = validateAgentSearchResponse(data, criteria)
      if (!validated.ok) return empty('mapping_unavailable')
      const { status, hotels, request } = validated.response
      return { hotels: [], liveHotels: hotels, total: hotels.length, isDemo: false, source: 'api',
        status: status === 'no_availability' ? 'empty' : status, request,
        searchId: validated.response.searchId, requestId: validated.response.requestId,
        generatedAt: validated.response.generatedAt, providerSummary: validated.response.providerSummary }
    } catch {
      return empty('provider_unavailable')
    }
  }

  async getById(id: string): Promise<Hotel | null> {
    if (process.env.NEXT_PUBLIC_ENABLE_DEMO_INVENTORY === 'true' && process.env.NODE_ENV !== 'production')
      return DEMO_HOTELS.find((hotel) => hotel.id === id) ?? null
    return null
  }

  async holdOffer(rate: SearchRateOffer, searchId: string, tenantId: string, idempotencyKey: string): Promise<OfferHoldResult> {
    const fallback = (status: OfferHoldResult['status']): OfferHoldResult => ({ offerId: rate.offerId, searchId, requestId: 'unavailable', status })
    if (!this.baseUrl || !rate.offerId || !searchId || !tenantId) return fallback('provider_unavailable')
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 7_000)
      let response: Response
      try {
        response = await fetch(`${this.baseUrl}/agent/offers/${encodeURIComponent(rate.offerId)}/hold`, {
          method: 'POST', credentials: 'include', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', 'x-fbeds-tenant-id': tenantId },
          body: JSON.stringify({ searchId, expectedCurrency: rate.total.currency,
            expectedSellAmountMinor: rate.sellAmountMinor, idempotencyKey }),
        })
      } finally { clearTimeout(timeout) }
      if (response.status === 401) return fallback('auth_required')
      if (response.status === 403) return fallback('access_denied')
      const envelope: unknown = await response.json().catch(() => null)
      const data: unknown = typeof envelope === 'object' && envelope !== null && 'data' in envelope ? envelope.data : envelope
      return validateHoldResult(data, rate.offerId, searchId) ?? fallback('provider_unavailable')
    } catch { return fallback('provider_unavailable') }
  }
}

function validateHoldResult(value: unknown, offerId: string, searchId: string): OfferHoldResult | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  const statuses: OfferHoldResult['status'][] = ['held', 'unavailable', 'price_changed', 'offer_expired', 'mapping_invalid', 'provider_unavailable', 'rejected']
  if (row.offerId !== offerId || row.searchId !== searchId || typeof row.requestId !== 'string' || !row.requestId ||
      typeof row.status !== 'string' || !statuses.includes(row.status as OfferHoldResult['status'])) return null
  const result: OfferHoldResult = { offerId, searchId, requestId: row.requestId, status: row.status as OfferHoldResult['status'] }
  if (row.currency !== undefined) { if (typeof row.currency !== 'string' || !/^[A-Z]{3}$/.test(row.currency)) return null; result.currency = row.currency }
  if (row.sellAmountMinor !== undefined) { if (!Number.isSafeInteger(row.sellAmountMinor) || Number(row.sellAmountMinor) < 0) return null; result.sellAmountMinor = Number(row.sellAmountMinor) }
  if (row.holdId !== undefined) { if (typeof row.holdId !== 'string' || !row.holdId) return null; result.holdId = row.holdId }
  if (row.expiresAt !== undefined) { if (typeof row.expiresAt !== 'string' || !Number.isFinite(Date.parse(row.expiresAt))) return null; result.expiresAt = row.expiresAt }
  if (result.status === 'held' && (!result.holdId || !result.expiresAt || !result.currency || result.sellAmountMinor === undefined)) return null
  return result
}
