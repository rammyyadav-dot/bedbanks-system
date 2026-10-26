import type { NextRequest } from 'next/server'
import { searchFiltersResponse } from '@/lib/search-filters-route'

// Contract: routes.agentLocal.searchFilters in @bedbanks/contracts/agent. Validation only: no session, tenant or supplier data is read.
export function GET(request: NextRequest): Response {
  return searchFiltersResponse(request.nextUrl, crypto.randomUUID())
}
