import type { AgentSearchResponse, SearchCriteria, SearchHotelOffer } from './index'

export function cityDestinationId(countryCode: string, cityName: string): string
export function validSearchCriteria(criteria: unknown): criteria is SearchCriteria
export function validateSearchHotels(input: unknown, criteria: SearchCriteria, now?: number, expectedTenantId?: string, paginate?: boolean):
  | { ok: true; hotels: SearchHotelOffer[]; matchedTotal: number }
  | { ok: false; reason: 'mapping_unavailable' }
export function validateAgentSearchResponse(input: unknown, criteria: SearchCriteria, now?: number):
  | { ok: true; response: AgentSearchResponse }
  | { ok: false; reason: 'mapping_unavailable' }
