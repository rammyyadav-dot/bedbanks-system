import type { Hotel, HotelSearchCriteria, HotelSearchResult } from '@/types/hotel'

export interface HotelService {
  search(criteria: HotelSearchCriteria): Promise<HotelSearchResult>
  getById(id: string): Promise<Hotel | null>
}

// ── Demo data ─────────────────────────────────────────────────────────────────
// Shown when NEXT_PUBLIC_API_URL is not set or the API is unreachable.
// Labelled isDemo: true so the UI can surface a clear "demo mode" banner.
const DEMO_HOTELS: Hotel[] = [
  {
    id: 'demo-1',
    name: 'Atlantis The Palm',
    city: 'Dubai',
    country: 'United Arab Emirates',
    stars: 5,
    rating: 4.8,
    price: 483.80,
    rack: 620.00,
    rooms: 1,
    supplier: 'Global Hotel Supply (demo)',
    board: 'Bed & Breakfast',
    image: '',
    amenities: ['Pool', 'Spa', 'Free Wi-Fi', 'Beach', 'Kids Club'],
    distance: '0.3 km from city centre',
    reviews: 2841,
    cancellation: 'Free cancellation until 48h before check-in',
    mappingStatus: 'mapped',
    availabilityStatus: 'available',
  },
  {
    id: 'demo-2',
    name: 'JW Marriott Marquis Dubai',
    city: 'Dubai',
    country: 'United Arab Emirates',
    stars: 5,
    rating: 4.7,
    price: 299.00,
    rack: 380.00,
    rooms: 1,
    supplier: 'Supplier One (demo)',
    board: 'Room Only',
    image: '',
    amenities: ['Pool', 'Gym', 'Free Wi-Fi', 'Concierge', 'Restaurant'],
    distance: '1.2 km from city centre',
    reviews: 1944,
    cancellation: 'Free cancellation until 24h before check-in',
    mappingStatus: 'mapped',
    availabilityStatus: 'limited',
  },
  {
    id: 'demo-3',
    name: 'Address Beach Resort',
    city: 'Dubai',
    country: 'United Arab Emirates',
    stars: 5,
    rating: 4.6,
    price: 391.00,
    rack: 495.00,
    rooms: 1,
    supplier: 'Supplier Two (demo)',
    board: 'Half Board',
    image: '',
    amenities: ['Private Beach', 'Pool', 'Spa', 'Free Wi-Fi'],
    distance: '2.1 km from city centre',
    reviews: 1102,
    cancellation: 'Non-refundable',
    mappingStatus: 'partial',
    availabilityStatus: 'available',
  },
]

function demoPriceForCriteria(base: number, nights: number): number {
  return Math.round(base * Math.max(1, nights) * 100) / 100
}

// ── Live API implementation ───────────────────────────────────────────────────

export class ApiHotelService implements HotelService {
  constructor(private readonly baseUrl = (process.env.NEXT_PUBLIC_API_URL ?? '').trim()) {}

  async search(criteria: HotelSearchCriteria): Promise<HotelSearchResult> {
    // No API configured → return clearly-labelled demo data, never silent empty
    if (!this.baseUrl) {
      const nights = Math.max(
        1,
        Math.round(
          (new Date(criteria.checkOut).getTime() - new Date(criteria.checkIn).getTime()) /
            86_400_000,
        ),
      )
      return {
        hotels: DEMO_HOTELS.map((h) => ({
          ...h,
          price: demoPriceForCriteria(h.price, nights),
          rack: demoPriceForCriteria(h.rack, nights),
        })),
        total: DEMO_HOTELS.length,
        isDemo: true,
        source: 'mock',
      }
    }

    try {
      const response = await fetch(`${this.baseUrl}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(criteria),
      })
      if (!response.ok) {
        // API reachable but returned an error → fall back to demo with a flag
        console.warn(`[HotelService] search returned ${response.status} — showing demo data`)
        return { hotels: DEMO_HOTELS, total: DEMO_HOTELS.length, isDemo: true, source: 'mock' }
      }
      return (await response.json()) as HotelSearchResult
    } catch {
      // Network error → fall back to demo
      console.warn('[HotelService] search network error — showing demo data')
      return { hotels: DEMO_HOTELS, total: DEMO_HOTELS.length, isDemo: true, source: 'mock' }
    }
  }

  async getById(id: string): Promise<Hotel | null> {
    // Demo ID → return demo data without hitting the API
    if (id.startsWith('demo-')) {
      return DEMO_HOTELS.find((h) => h.id === id) ?? null
    }

    if (!this.baseUrl) return null

    try {
      const response = await fetch(`${this.baseUrl}/hotels/${encodeURIComponent(id)}`, {
        credentials: 'include',
      })
      if (response.status === 404) return null
      if (!response.ok) {
        console.warn(`[HotelService] getById ${id} returned ${response.status}`)
        return null
      }
      return (await response.json()) as Hotel
    } catch {
      console.warn(`[HotelService] getById ${id} network error`)
      return null
    }
  }
}
