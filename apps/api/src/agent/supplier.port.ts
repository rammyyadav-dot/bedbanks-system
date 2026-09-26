import type { SearchCriteria, SearchHotelOffer, SearchRateOffer } from '@bedbanks/domain'

export type HotelSearchCriteria = SearchCriteria
export type HotelAvailability = SearchHotelOffer
export interface SupplierSearchContext { tenantId: string; requestId: string }
export interface SupplierSearchResult {
  offers: SearchHotelOffer[]
  providerSummary: { queried: number; succeeded: number; failed: number }
}
export interface SupplierRecheckRequest { offerId: string; searchId: string }
export interface SupplierRequestContext { tenantId: string; userId: string; requestId: string }
export interface RecheckedOfferAuthority {
  offerId: string; searchId: string; supplierId: string; supplierHotelId: string; supplierRoomId: string
  canonicalHotelId: string; canonicalRoomTypeId: string; ratePlanId: string; boardBasisId: string
  checkIn: string; checkOut: string; rooms: number; adults: number; children: number; childAges: number[]
  currency: string; sellAmountMinor: number; expiresAt: string
}
export type SupplierRecheckResult =
  | { status: 'available'; offer: RecheckedOfferAuthority; metadata?: { providerRequestId?: string; durationMs?: number } }
  | { status: 'unavailable' | 'offer_expired'; metadata?: { providerRequestId?: string; durationMs?: number } }
export interface PrebookRequest extends SupplierRecheckRequest { idempotencyKey: string }
export interface SupplierAdapter {
  readonly name: string
  /** Return canonical offers with independently keyed relationships; never synthesize IDs from labels. */
  search(criteria: SearchCriteria, context: SupplierSearchContext): Promise<SupplierSearchResult>
  recheck(request: SupplierRecheckRequest, context: SupplierRequestContext): Promise<SupplierRecheckResult>
  prebook(request: PrebookRequest, context: SupplierRequestContext): Promise<{ supplierReference: string; rate: SearchRateOffer }>
  cancel(supplierReference: string): Promise<{ refundMinor: number }>
}

/** No credentials means the API stays honest instead of returning fake inventory. */
export class UnconfiguredSupplierAdapter implements SupplierAdapter {
  readonly name = 'unconfigured'
  async search(): Promise<SupplierSearchResult> {
    return { offers: [], providerSummary: { queried: 0, succeeded: 0, failed: 0 } }
  }
  async recheck(): Promise<SupplierRecheckResult> { throw new SupplierProviderError('unconfigured') }
  async prebook(): Promise<{ supplierReference: string; rate: SearchRateOffer }> { throw new Error('No supplier adapter configured') }
  async cancel(): Promise<{ refundMinor: number }> { throw new Error('No supplier adapter configured') }
}

export type SupplierProviderErrorCode = 'unconfigured' | 'timeout' | 'authentication' | 'transport' | 'malformed_response'
export class SupplierProviderError extends Error {
  constructor(readonly code: SupplierProviderErrorCode) { super('Supplier provider unavailable'); this.name = 'SupplierProviderError' }
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
