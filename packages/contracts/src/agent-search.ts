// Agent Smart Search (ADR 0065): POST routes.agent.smartSearchParse. The pasted text is never stored, cached or logged.

export const SMART_SEARCH_TEXT_MAX = 2000

export interface SmartSearchParseRequest {
  /** The client's request as pasted by the agent, 1 to 2,000 characters. */
  text: string
}

export type SmartSearchField = 'destination' | 'dates' | 'occupancy' | 'stars' | 'nationality'

/** A canonical catalogue destination, the same shape the destinations typeahead returns. */
export type SmartSearchDestination =
  | { type: 'city'; id: string; name: string; countryCode: string }
  | { type: 'hotel'; id: string; name: string; cityId: string; cityName: string; countryCode: string }

export interface SmartSearchParseResponse {
  /** The business date the relative dates were read against (Asia/Dubai). */
  today: string
  /** Resolved against the tenant's published catalogue; absent when the text names no known city or hotel. */
  destination?: SmartSearchDestination
  /** Other catalogue matches for the same text, for the agent to choose from. */
  alternatives: SmartSearchDestination[]
  /** What the text said, when it did not resolve to a catalogue destination. */
  destinationText?: string
  checkIn?: string
  checkOut?: string
  nights?: number
  starRatings?: number[]
  rooms?: Array<{ adults: number; childAges: number[] }>
  /** ISO 3166-1 alpha-2, supported guest markets only. */
  nationality?: string
  /** Fields the text did not settle. The agent's current values stay; nothing is defaulted. */
  unresolved: SmartSearchField[]
  notes: string[]
}

// Hotel search filter validation (ADR 0075). GET routes.agentLocal.searchFilters validates and normalises the filter query
// parameters of the Agent portal. It is served by the portal itself (not the API behind /api/v1), is stateless, reads no tenant
// data and authorises nothing: tenant identity and the `agent.search` permission are still enforced by POST routes.agent.search.

/** Bounds enforced on every search filter parameter. Shared so the portal, the API and their tests cannot drift apart. */
export const HOTEL_SEARCH_FILTER_LIMITS = {
  /** Largest accepted price, in major units of the search currency. */
  maxPriceMajor: 1_000_000,
  maxPage: 10_000,
  defaultPage: 1,
  maxLimit: 100,
  defaultLimit: 25,
  maxRadiusKm: 200,
  maxTextLength: 150,
  /** Raw text above this is refused before any normalisation work is done. */
  maxRawTextLength: 600,
} as const

export const HOTEL_SEARCH_FILTERS_ERROR_CODE = 'INVALID_SEARCH_FILTERS'

/** Validated, normalised filters. Prices are integer minor units of `currency` (never floats). */
export interface HotelSearchFilters {
  stars?: number[]
  currency?: string
  minPriceMinor?: number
  maxPriceMinor?: number
  latitude?: number
  longitude?: number
  radiusKm?: number
  page: number
  limit: number
  /** Zero-based offset derived from page and limit, matching SearchCriteria.offset. */
  offset: number
  destination?: string
  hotelName?: string
}

/** One rejected parameter. The message never repeats the rejected value. */
export interface HotelSearchFilterIssue { field: string; message: string }
