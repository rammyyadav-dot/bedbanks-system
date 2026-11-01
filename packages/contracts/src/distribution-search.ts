// B2B Distribution API v1, hotel search (ADR 0075). PROPOSED: no route serves this contract yet.
//
// Machine partners (agency systems, OTAs) call this with an API key or an OAuth2 client-credentials token. The tenant and
// the agency come from that credential only (CLAUDE.md invariant 1); this payload carries neither. Responses use the
// standard `ApiEnvelope` from ./envelope, and `X-Request-ID` is echoed on every response.

export const DISTRIBUTION_SEARCH_LIMITS = {
  maxRooms: 9,
  maxAdultsPerRoom: 9,
  maxChildrenPerRoom: 4,
  maxChildAge: 17,
  maxNights: 30,
  maxHotelIds: 100,
  maxPageSize: 100,
  defaultPageSize: 25,
} as const

/** Integer minor units as a decimal string (`"125050"` = 1,250.50 AED), so no client parses money as a float. */
export interface DistributionMoney { amountMinor: string; currency: string }

/** WGS-84 decimal degrees as strings, exactly as stored in the catalogue. */
export interface DistributionGeoBox { north: string; south: string; east: string; west: string }

export type DistributionDestination =
  | { type: 'city'; cityId: string }
  /** Multi-property query: canonical fBeds hotel ids, 1 to 100. */
  | { type: 'hotels'; hotelIds: string[] }
  /** Geo bounding box. The server rejects boxes wider than its configured span instead of truncating them. */
  | { type: 'geo_box'; box: DistributionGeoBox }

export type DistributionBoardBasis = 'RO' | 'BB' | 'HB' | 'FB' | 'AI'
export type DistributionSortKey = 'price' | 'stars' | 'name'

export interface DistributionRoomRequest { adults: number; childAges: number[] }

export interface DistributionSearchRequest {
  /** Property-local dates, `YYYY-MM-DD`; checkOut is after checkIn. */
  checkIn: string
  checkOut: string
  destination: DistributionDestination
  rooms: DistributionRoomRequest[]
  /** ISO 3166-1 alpha-2 lead-guest nationality. Required: supplier prices and sales markets depend on it. */
  nationality: string
  /** ISO-4217. Prices are converted at the tenant's controlled FX rate, never a live float rate. */
  currency: string
  /** BCP 47 tag for names and descriptions, for example `en` or `ar-AE`. Unknown languages fall back to `en`, flagged in the response. */
  language?: string
  filters?: {
    starRatings?: number[]
    boardBasis?: DistributionBoardBasis[]
    /** Only offers that are free to cancel at the time of search. */
    refundableOnly?: boolean
    /** Upper bound on the stay total, in the requested currency. */
    maxTotal?: DistributionMoney
  }
  /** Omitted: price ascending. */
  sort?: { by: DistributionSortKey; direction: 'asc' | 'desc' }
  /** Pass `nextCursor` from the previous page with the same request body; a cursor is bound to its search. */
  page?: { size?: number; cursor?: string }
}

export interface DistributionCancellationDeadline {
  /** Offset-qualified ISO-8601 timestamp from which `penalty` applies. */
  from: string
  penalty: DistributionMoney
}

export interface DistributionOffer {
  /** Opaque. Pass to CheckRate. Valid until `expiresAt`. */
  offerId: string
  roomIndex: number
  roomName: string
  boardBasis: DistributionBoardBasis
  /** `on_request` is priced but not confirmed inventory and cannot be booked instantly. */
  availability: 'available' | 'limited' | 'on_request'
  /** Sell price for the whole stay, for this room, including the agency's markup. */
  total: DistributionMoney
  /** Present when `total` was converted; the contract currency it was priced in. */
  sourceCurrency?: string
  taxesIncluded: boolean | null
  refundable: boolean
  cancellationDeadlines: DistributionCancellationDeadline[]
  expiresAt: string
}

export interface DistributionHotel {
  hotelId: string
  name: string
  starRating: number
  cityId: string
  latitude?: string
  longitude?: string
  address?: string
  /** Absolute URL of the primary published image; omitted when there is none, never a placeholder. */
  primaryImageUrl?: string
  /** Cheapest first within the hotel. */
  offers: DistributionOffer[]
}

export interface DistributionSearchResponse {
  searchId: string
  language: string
  currency: string
  hotels: DistributionHotel[]
  page: { size: number; totalMatched: number; nextCursor: string | null }
  /**
   * Supplier coverage for this search. `complete` is false when any supplier failed or timed out, so a partner never
   * mistakes a partial answer for "no availability" (invariant 5).
   */
  suppliers: { queried: number; succeeded: number; failed: number; complete: boolean }
}

/** Machine-readable error codes for the distribution API, carried in `ErrorEnvelope.error.code`. */
export type DistributionErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'QUOTA_EXCEEDED'
  | 'CURSOR_INVALID'
  | 'NO_SUPPLIER_AVAILABLE'
