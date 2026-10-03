import type { Money } from '@bedbanks/money'

export interface CanonicalHotel { id: string; name: string; destinationId: string; providerRefs: Record<string, string> }

/** Canonical destination. There is no area entity in the hotel master, so area is not a resolution type. */
export type DestinationRef =
  | { type: 'city'; id: string; countryCode: string }
  | { type: 'hotel'; id: string }

export type DestinationResolution =
  | { type: 'city'; id: string; name: string; countryCode: string }
  | { type: 'hotel'; id: string; name: string; cityId: string; cityName: string; countryCode: string }

/** One room's occupancy. Child ages are mandatory for every child in the room. */
export interface SearchRoomStay {
  adults: number
  children: { age: number }[]
}

export type SearchSort = 'default' | 'price' | 'stars' | 'name'

export interface SearchCriteria {
  destination: string
  /** When present, the server resolves this id and overwrites destination. Free text is not a destination. */
  destinationRef?: DestinationRef
  canonicalHotelIds?: string[]
  checkIn: string
  checkOut: string
  /** Room count. With roomStays, this is the number of room stays. */
  rooms: number
  /**
   * Per-room adults when every room stay matches, otherwise the sum of room-stay adults.
   * Contracted inventory prices only the uniform per-room case.
   */
  adults: number
  children: number
  childAges: number[]
  roomStays?: SearchRoomStay[]
  nationality: string
  currency: string
  limit?: number
  /** Zero-based index into the stable sellable-hotel order. Omitted means the first page. */
  offset?: number
  /** Omitted means the supplier's stable order. Price, stars and name are applied before pagination. */
  sort?: SearchSort
  filters?: {
    starRatings?: number[]
    boardBasisIds?: string[]
    refundableOnly?: boolean
    minPriceMinor?: number
    maxPriceMinor?: number
    propertyTypes?: string[]
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
  contractId?: string
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
/** Primary image of a published hotel (ADR 0027). No URL: the transport layer builds one from the hotel and image ids. */
export interface SearchHotelImage { imageId: string; altText: string; width: number; height: number }
export interface SearchHotelOffer {
  hotelId: string
  name: string
  destination: string
  starRating: number
  /** Stored hotel master fields. Omitted when the catalogue has no value. */
  propertyType?: string
  address?: string
  latitude?: string
  longitude?: string
  timeZone?: string
  /** Omitted when the hotel has no image; never a placeholder. */
  primaryImage?: SearchHotelImage
  supplierId: string
  supplierHotelId: string
  rooms: SearchRoomOffer[]
}
export interface SearchPagination {
  limit: number
  offset: number
  /** Sellable hotels matching the criteria before the page window. */
  total: number
  hasMore: boolean
  nextOffset?: number
}
export interface AgentSearchResponse {
  version: 1
  searchId: string
  requestId: string
  generatedAt: string
  status: 'available' | 'partial' | 'no_availability' | 'provider_unavailable' | 'mapping_unavailable'
  request: SearchCriteria
  hotels: SearchHotelOffer[]
  /** Hotels in this page. The matched count lives on `pagination.total`. */
  total: number
  pagination?: SearchPagination
  providerSummary: { queried: number; succeeded: number; failed: number }
}

export type InventoryHoldStatus = 'PENDING_RECHECK' | 'RECHECKED' | 'HOLD_PENDING' | 'HELD' | 'RELEASED' | 'EXPIRED' | 'FAILED'
export interface InventoryHoldRequest {
  offerId: string
  searchId: string
  ratePlanId: string
  canonicalHotelId: string
  canonicalRoomTypeId: string
  boardBasisId: string
  checkIn: string
  checkOut: string
  rooms: number
  currency: string
  sellAmountMinor: number
  offerExpiresAt: string
  idempotencyKey: string
}
export interface InventoryHoldResponse {
  holdId: string
  requestId: string
  status: 'held' | 'already_held'
  expiresAt: string
  currency: string
  sellAmountMinor: number
}

export type OfferHoldOutcome = 'rechecked' | 'held' | 'unavailable' | 'price_changed' | 'offer_expired' | 'mapping_invalid' | 'provider_unavailable' | 'rejected'
export interface OfferHoldRequest {
  offerId: string
  searchId: string
  expectedCurrency: string
  expectedSellAmountMinor: number
  idempotencyKey: string
}
export interface OfferHoldResponse {
  offerId: string
  searchId: string
  requestId: string
  status: OfferHoldOutcome
  currency?: string
  sellAmountMinor?: number
  holdId?: string
  expiresAt?: string
}


export interface BookingTransactionCommand {
  tenantId: string
  userId: string
  requestId: string
  idempotencyKey: string
  offerId: string
  searchId: string
  inventoryHoldId: string
  canonicalHotelId: string
  canonicalRoomTypeId: string
  ratePlanId: string
  boardBasisId: string
  checkIn: string
  checkOut: string
  rooms: number
  adults: number
  children: number
  childAges: number[]
  currency: string
  totalMinor: number
  leadGuest: {
    firstName: string
    lastName: string
  }
  /** Non-commercial checkout notes. They do not change price, occupancy, or idempotency equality. */
  agencyReference?: string
  specialRequests?: string
  roomGuests?: {
    roomIndex: number
    guests: { type: 'adult' | 'child'; firstName: string; lastName: string }[]
  }[]
}

/**
 * Internal orchestration states. These deliberately do not replace Prisma BookingStatus.
 * InventoryHold remains the temporary inventory authority. UNKNOWN means the supplier
 * mutation outcome was not observed; it is not a failure and it is not a confirmation.
 */
export type BookingTransactionState =
  | 'RECHECKED'
  | 'INVENTORY_HELD'
  | 'FINANCE_AUTHORIZED'
  | 'PREBOOKED'
  | 'BOOKING_PENDING'
  | 'CONFIRMED'
  | 'FAILED'
  | 'UNKNOWN'
