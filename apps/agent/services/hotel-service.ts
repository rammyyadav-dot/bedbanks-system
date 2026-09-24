import type { Hotel, HotelSearchCriteria, HotelSearchResult } from '../types/hotel.ts'
import { agentApiBase } from '../lib/api-config.ts'

// Sample inventory is isolated here. It is never a response to a failed live request.
export const DEMO_HOTELS: Hotel[] = [
  { id: 'demo-dubai-1', name: 'One&Only Royal Mirage', city: 'Dubai', country: 'United Arab Emirates', stars: 5, rating: 4.9, price: 820, rack: 1260, rooms: 12, supplier: 'Demo inventory', board: 'Breakfast included', image: 'https://images.unsplash.com/photo-1564501049412-61c2a3083791?auto=format&fit=crop&w=900&q=80', amenities: ['Private beach', 'Spa', 'WiFi'], distance: '0.5 km from City Center', reviews: 4927, cancellation: 'Free cancellation until 07 Sep', mappingStatus: 'mapped', availabilityStatus: 'available' },
  { id: 'demo-dubai-2', name: 'Palace Downtown', city: 'Dubai', country: 'United Arab Emirates', stars: 5, rating: 4.9, price: 760, rack: 1160, rooms: 14, supplier: 'Demo inventory', board: 'Bed & breakfast', image: 'https://images.unsplash.com/photo-1582719478250-c89cae4dc85b?auto=format&fit=crop&w=900&q=80', amenities: ['Rooftop pool', 'Dining', 'WiFi'], distance: '3.5 km from City Center', reviews: 5341, cancellation: 'Free cancellation until 08 Sep', mappingStatus: 'mapped', availabilityStatus: 'available' },
  { id: 'demo-dubai-3', name: 'Nikki Beach Resort & Spa', city: 'Dubai', country: 'United Arab Emirates', stars: 5, rating: 4.8, price: 690, rack: 1080, rooms: 8, supplier: 'Demo inventory', board: 'Room only', image: 'https://images.unsplash.com/photo-1540541338287-41700207dee6?auto=format&fit=crop&w=900&q=80', amenities: ['Beach club', 'Spa', 'WiFi'], distance: '2.1 km from City Center', reviews: 3421, cancellation: 'Free cancellation until 06 Sep', mappingStatus: 'mapped', availabilityStatus: 'limited' },
]

export interface HotelService {
  search(criteria: HotelSearchCriteria, tenantId: string): Promise<HotelSearchResult>
  getById(id: string): Promise<Hotel | null>
}

export class ApiHotelService implements HotelService {
  private readonly baseUrl: string
  constructor(baseUrl = agentApiBase) { this.baseUrl = baseUrl }

  async search(criteria: HotelSearchCriteria, tenantId: string): Promise<HotelSearchResult> {
    if (process.env.NEXT_PUBLIC_ENABLE_DEMO_INVENTORY === 'true' && process.env.NODE_ENV !== 'production') {
      const hotels = DEMO_HOTELS.filter((hotel) =>
        !criteria.destination || `${hotel.name} ${hotel.city}`.toLowerCase().includes(criteria.destination.toLowerCase()),
      )
      return { hotels, total: hotels.length, isDemo: true, source: 'mock', status: 'demo' }
    }

    if (!this.baseUrl) return { hotels: [], total: 0, isDemo: false, source: 'api', status: 'provider_unavailable' }
    try {
      const response = await fetch(`${this.baseUrl}/agent/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-fbeds-tenant-id': tenantId },
        credentials: 'include',
        body: JSON.stringify(criteria),
      })
      if (response.status === 401) return { hotels: [], total: 0, isDemo: false, source: 'api', status: 'auth_required' }
      if (response.status === 403) return { hotels: [], total: 0, isDemo: false, source: 'api', status: 'access_denied' }
      if (!response.ok) return { hotels: [], total: 0, isDemo: false, source: 'api', status: 'provider_unavailable' }
      const envelope: unknown = await response.json()
      const data: unknown = typeof envelope === 'object' && envelope !== null && 'data' in envelope ? envelope.data : envelope
      if (typeof data !== 'object' || data === null || !('hotels' in data) || !Array.isArray(data.hotels))
        return { hotels: [], total: 0, isDemo: false, source: 'api', status: 'provider_unavailable' }
      // The API currently returns rateId + roomName + board strings. Those cannot
      // establish authoritative room/rate/board mappings or a bookable total.
      // Empty results are honest; populated but incomplete offers are blocked.
      if (data.hotels.length > 0)
        return { hotels: [], total: 0, isDemo: false, source: 'api', status: 'mapping_unavailable' }
      return { hotels: [], total: 0, isDemo: false, source: 'api', status: 'empty' }
    } catch {
      return { hotels: [], total: 0, isDemo: false, source: 'api', status: 'provider_unavailable' }
    }
  }

  async getById(id: string): Promise<Hotel | null> {
    if (process.env.NEXT_PUBLIC_ENABLE_DEMO_INVENTORY === 'true' && process.env.NODE_ENV !== 'production')
      return DEMO_HOTELS.find((hotel) => hotel.id === id) ?? null
    return null
  }
}
