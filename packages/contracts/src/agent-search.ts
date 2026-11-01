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
