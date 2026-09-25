import type { SearchCriteria, SearchHotelOffer } from '@bedbanks/domain'

/** Presentation-only demo hotel. Live search uses the canonical shared offer contract. */
export type Hotel = {
  id: string
  name: string
  city: string
  country?: string
  stars: number
  rating: number
  price: number
  rack: number
  rooms: number
  supplier: string
  board: string
  image: string
  amenities: string[]
  distance: string
  reviews: number
  cancellation: string
  mappingStatus?: 'mapped' | 'partial' | 'unmapped'
  availabilityStatus?: 'available' | 'limited' | 'sold-out'
}

export type HotelSearchCriteria = SearchCriteria
export type HotelSearchResult = {
  hotels: Hotel[]
  liveHotels: SearchHotelOffer[]
  total: number
  isDemo: boolean
  source: 'mock' | 'api'
  status: 'demo' | 'available' | 'partial' | 'empty' | 'provider_unavailable' | 'mapping_unavailable' | 'auth_required' | 'access_denied'
  request: SearchCriteria
  searchId?: string
  requestId?: string
  generatedAt?: string
  providerSummary?: { queried: number; succeeded: number; failed: number }
}
