import type { SearchCriteria, SearchHotelOffer, SearchRateOffer } from '@bedbanks/domain'

export type HotelSearchCriteria = SearchCriteria
export type HotelAvailability = SearchHotelOffer
export interface SupplierSearchContext { tenantId: string; requestId: string }
export interface SupplierSearchResult {
  offers: SearchHotelOffer[]
  providerSummary: { queried: number; succeeded: number; failed: number }
}
export interface RecheckRequest { offerId: string; criteria: SearchCriteria; supplierOfferToken: string }
export interface PrebookRequest extends RecheckRequest { idempotencyKey: string }
export interface SupplierAdapter {
  readonly name: string
  /** Return canonical offers with independently keyed relationships; never synthesize IDs from labels. */
  search(criteria: SearchCriteria, context: SupplierSearchContext): Promise<SupplierSearchResult>
  recheck(request: RecheckRequest): Promise<SearchRateOffer>
  prebook(request: PrebookRequest): Promise<{ supplierReference: string; rate: SearchRateOffer }>
  cancel(supplierReference: string): Promise<{ refundMinor: number }>
}

/** No credentials means the API stays honest instead of returning fake inventory. */
export class UnconfiguredSupplierAdapter implements SupplierAdapter {
  readonly name = 'unconfigured'
  async search(): Promise<SupplierSearchResult> {
    return { offers: [], providerSummary: { queried: 0, succeeded: 0, failed: 0 } }
  }
  async recheck(): Promise<SearchRateOffer> { throw new Error('No supplier adapter configured') }
  async prebook(): Promise<{ supplierReference: string; rate: SearchRateOffer }> { throw new Error('No supplier adapter configured') }
  async cancel(): Promise<{ refundMinor: number }> { throw new Error('No supplier adapter configured') }
}

export const SUPPLIER_ADAPTER = Symbol('SUPPLIER_ADAPTER')
export const PERMISSIONS = {
  search: 'hotel.search',
  prebook: 'booking.prebook',
  createBooking: 'booking.create',
  cancelBooking: 'booking.cancel',
  viewFinance: 'finance.read',
} as const
export type AgentPermission = typeof PERMISSIONS[keyof typeof PERMISSIONS]
