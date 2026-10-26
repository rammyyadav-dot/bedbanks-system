import { HOTEL_SEARCH_FILTERS_ERROR_CODE, type ErrorEnvelope, type HotelSearchFilters, type SuccessEnvelope } from '@bedbanks/contracts/agent'
import { parseHotelSearchFilters } from '../schemas/hotel-search-filter.schema.ts'

const HEADERS = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' } as const

/**
 * GET routes.agentLocal.searchFilters. Pure so it is testable without Next: 200 with the normalised filters, or 400 with the
 * standard ErrorEnvelope listing each rejected parameter. It never throws and never echoes the rejected values.
 */
export function searchFiltersResponse(url: URL, requestId: string, now: Date = new Date()): Response {
  const result = parseHotelSearchFilters(url.searchParams)
  if (result.ok) {
    const body: SuccessEnvelope<HotelSearchFilters> = { success: true, data: result.value }
    return new Response(JSON.stringify(body), { status: 200, headers: HEADERS })
  }
  const body: ErrorEnvelope = {
    success: false,
    error: { code: HOTEL_SEARCH_FILTERS_ERROR_CODE, message: 'One or more search filters are invalid.', details: result.errors },
    meta: { timestamp: now.toISOString(), path: url.pathname, requestId },
  }
  return new Response(JSON.stringify(body), { status: result.status, headers: HEADERS })
}
