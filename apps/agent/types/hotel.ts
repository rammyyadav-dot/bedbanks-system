import type { SearchCriteria, SearchHotelOffer, SearchPagination } from '@bedbanks/domain'

export type HotelSearchCriteria = SearchCriteria
export type HotelSearchResult = {
  liveHotels: SearchHotelOffer[]
  total: number
  status: 'available' | 'partial' | 'empty' | 'provider_unavailable' | 'mapping_unavailable' | 'auth_required' | 'access_denied' | 'agency_suspended' | 'destination_unavailable'
  failureMessage?: string
  request: SearchCriteria
  pagination?: SearchPagination
  /** Search that returned each hotel. Recheck must use that search, not a later page. */
  hotelSearchIds?: Record<string, string>
  searchId?: string
  requestId?: string
  generatedAt?: string
  providerSummary?: { queried: number; succeeded: number; failed: number }
}

export type OfferRecheckResult = {
  offerId: string
  searchId: string
  requestId: string
  status: 'rechecked' | 'unavailable' | 'price_changed' | 'offer_expired' | 'mapping_invalid' | 'provider_unavailable' | 'rejected' | 'auth_required' | 'access_denied' | 'agency_suspended'
  currency?: string
  sellAmountMinor?: number
  expiresAt?: string
}
