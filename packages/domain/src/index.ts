import type { Money } from '@bedbanks/money'

export interface CanonicalHotel { id: string; name: string; destinationId: string; providerRefs: Record<string, string> }
export interface SearchCriteria {
  destination: string
  canonicalHotelIds?: string[]
  checkIn: string
  checkOut: string
  rooms: number
  adults: number
  children: number
  childAges: number[]
  nationality: string
  currency: string
  limit?: number
  filters?: {
    starRatings?: number[]
    boardBasisIds?: string[]
    refundableOnly?: boolean
    minPriceMinor?: number
    maxPriceMinor?: number
  }
}
export interface CanonicalRate { id: string; hotelId: string; currency: string; totalMinor: number; refundable: boolean }

export interface SearchOccupancy { rooms: number; adults: number; children: number; childAges: number[] }
export interface SearchCancellationPolicy { refundable: boolean; summary: string; deadline?: string }
export interface SearchRateOffer {
  offerId: string
  tenantId: string
  providerId: string
  hotelId: string
  canonicalHotelId: string
  roomTypeId: string
  canonicalRoomTypeId: string
  supplierId: string
  supplierRoomId: string
  ratePlanId: string
  ratePlanName: string
  boardBasisId: string
  boardBasisName: string
  supplierRateId: string
  offerToken?: string
  expiresAt: string
  occupancy: SearchOccupancy
  availability: 'available' | 'limited' | 'sold_out'
  available: boolean
  cancellation: SearchCancellationPolicy
  /** Authoritative total for the complete stay and submitted occupancy. */
  total: Money
  netAmountMinor: number
  taxAmountMinor: number
  feeAmountMinor: number
  totalAmountMinor: number
  markupAmountMinor: number
  sellAmountMinor: number
  paymentType: 'prepaid' | 'pay_at_hotel' | 'credit'
  source: 'hotel_direct' | 'dmc' | 'bedbank' | 'channel_manager' | 'gds'
}
export interface SearchRoomOffer {
  roomTypeId: string
  name: string
  supplierRoomId: string
  rates: SearchRateOffer[]
}
export interface SearchHotelOffer {
  hotelId: string
  name: string
  destination: string
  supplierId: string
  supplierHotelId: string
  rooms: SearchRoomOffer[]
}
export interface AgentSearchResponse {
  version: 1
  searchId: string
  requestId: string
  generatedAt: string
  status: 'available' | 'partial' | 'no_availability' | 'provider_unavailable' | 'mapping_unavailable'
  request: SearchCriteria
  hotels: SearchHotelOffer[]
  total: number
  providerSummary: { queried: number; succeeded: number; failed: number }
}
