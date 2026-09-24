import type { Money } from '@bedbanks/money'

export interface CanonicalHotel { id: string; name: string; destinationId: string; providerRefs: Record<string, string> }
export interface SearchCriteria {
  destination: string
  checkIn: string
  checkOut: string
  rooms: number
  adults: number
  children: number
  childAges: number[]
  nationality: string
  currency: string
}
export interface CanonicalRate { id: string; hotelId: string; currency: string; totalMinor: number; refundable: boolean }

export interface SearchOccupancy { rooms: number; adults: number; children: number; childAges: number[] }
export interface SearchCancellationPolicy { refundable: boolean; summary: string; deadline?: string }
export interface SearchRateOffer {
  offerId: string
  hotelId: string
  roomTypeId: string
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
  cancellation: SearchCancellationPolicy
  /** Authoritative total for the complete stay and submitted occupancy. */
  total: Money
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
  status: 'available' | 'no_availability' | 'provider_unavailable' | 'mapping_unavailable'
  request: SearchCriteria
  hotels: SearchHotelOffer[]
  total: number
}
