import type { HotelSearchCriteria, HotelSearchResult, OfferRecheckResult } from '../types/hotel.ts'
import type { SearchRateOffer } from '@bedbanks/domain'
import { agentApiBase } from '../lib/api-config.mjs'
import { validSearchCriteria, validateAgentSearchResponse } from '@bedbanks/domain/search-offers'

export interface HotelService {
  search(criteria: HotelSearchCriteria, tenantId: string): Promise<HotelSearchResult>
  recheckOffer(rate: SearchRateOffer, searchId: string, tenantId: string): Promise<OfferRecheckResult>
}

export class ApiHotelService implements HotelService {
  private readonly baseUrl: string
  constructor(baseUrl = agentApiBase) { this.baseUrl = baseUrl }

  async search(criteria: HotelSearchCriteria, tenantId: string): Promise<HotelSearchResult> {
    const empty = (status: HotelSearchResult['status']): HotelSearchResult =>
      ({ liveHotels: [], total: 0, status, request: criteria })
    if (!validSearchCriteria(criteria)) return empty('mapping_unavailable')
    if (!this.baseUrl) return empty('provider_unavailable')
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 10_000)
      let response: Response
      try {
        response = await fetch(`${this.baseUrl}/agent/search`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-fbeds-tenant-id': tenantId },
          credentials: 'include',
          body: JSON.stringify(criteria),
          signal: controller.signal,
        })
      } finally {
        clearTimeout(timeout)
      }
      if (response.status === 401) return empty('auth_required')
      if (response.status === 403) return empty('access_denied')
      if (!response.ok) return empty('provider_unavailable')
      const envelope: unknown = await response.json()
      const data: unknown = typeof envelope === 'object' && envelope !== null && 'data' in envelope ? envelope.data : envelope
      const validated = validateAgentSearchResponse(data, criteria)
      if (!validated.ok) return empty('mapping_unavailable')
      const { status, hotels, request, pagination } = validated.response
      return { liveHotels: hotels, total: hotels.length,
        status: status === 'no_availability' ? 'empty' : status, request,
        ...(pagination ? { pagination } : {}),
        searchId: validated.response.searchId, requestId: validated.response.requestId,
        generatedAt: validated.response.generatedAt, providerSummary: validated.response.providerSummary }
    } catch {
      return empty('provider_unavailable')
    }
  }

  async recheckOffer(rate: SearchRateOffer, searchId: string, tenantId: string): Promise<OfferRecheckResult> {
    const fallback = (status: OfferRecheckResult['status']): OfferRecheckResult => ({ offerId: rate.offerId, searchId, requestId: 'unavailable', status })
    if (!this.baseUrl || !rate.offerId || !searchId || !tenantId) return fallback('provider_unavailable')
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 7_000)
      let response: Response
      try {
        response = await fetch(`${this.baseUrl}/agent/rates/recheck`, {
          method: 'POST', credentials: 'include', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', 'x-fbeds-tenant-id': tenantId },
          body: JSON.stringify({ offerId: rate.offerId, searchId, expectedCurrency: rate.total.currency,
            expectedSellAmountMinor: rate.sellAmountMinor }),
        })
      } finally { clearTimeout(timeout) }
      if (response.status === 401) return fallback('auth_required')
      if (response.status === 403) return fallback('access_denied')
      const envelope: unknown = await response.json().catch(() => null)
      const data: unknown = typeof envelope === 'object' && envelope !== null && 'data' in envelope ? envelope.data : envelope
      return validateRecheckResult(data, rate.offerId, searchId) ?? fallback('provider_unavailable')
    } catch { return fallback('provider_unavailable') }
  }
}

function validateRecheckResult(value: unknown, offerId: string, searchId: string): OfferRecheckResult | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  const statuses: OfferRecheckResult['status'][] = ['rechecked', 'unavailable', 'price_changed', 'offer_expired', 'mapping_invalid', 'provider_unavailable', 'rejected']
  if (row.offerId !== offerId || row.searchId !== searchId || typeof row.requestId !== 'string' || !row.requestId ||
      typeof row.status !== 'string' || !statuses.includes(row.status as OfferRecheckResult['status'])) return null
  const result: OfferRecheckResult = { offerId, searchId, requestId: row.requestId, status: row.status as OfferRecheckResult['status'] }
  if (row.currency !== undefined) { if (typeof row.currency !== 'string' || !/^[A-Z]{3}$/.test(row.currency)) return null; result.currency = row.currency }
  if (row.sellAmountMinor !== undefined) { if (!Number.isSafeInteger(row.sellAmountMinor) || Number(row.sellAmountMinor) < 0) return null; result.sellAmountMinor = Number(row.sellAmountMinor) }
  if (row.expiresAt !== undefined) { if (typeof row.expiresAt !== 'string' || !Number.isFinite(Date.parse(row.expiresAt))) return null; result.expiresAt = row.expiresAt }
  return result
}
