import type { SearchCriteria, SearchHotelOffer } from '@bedbanks/domain'

export type HotelSearchCriteria = SearchCriteria
export type HotelSearchResult = {
  liveHotels: SearchHotelOffer[]
  total: number
  status: 'available' | 'partial' | 'empty' | 'provider_unavailable' | 'mapping_unavailable' | 'auth_required' | 'access_denied'
  request: SearchCriteria
  searchId?: string
  requestId?: string
  generatedAt?: string
  providerSummary?: { queried: number; succeeded: number; failed: number }
}

export type OfferRecheckResult = {
  offerId: string
  searchId: string
  requestId: string
  status: 'rechecked' | 'unavailable' | 'price_changed' | 'offer_expired' | 'mapping_invalid' | 'provider_unavailable' | 'rejected' | 'auth_required' | 'access_denied'
  currency?: string
  sellAmountMinor?: number
  expiresAt?: string
}
