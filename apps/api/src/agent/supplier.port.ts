export interface HotelSearchCriteria {
  destination: string
  checkIn: string
  checkOut: string
  rooms: number
  adults: number
  children: number
  nationality: string
  currency: string
}

export interface HotelRate {
  rateId: string
  roomName: string
  board: string
  currency: string
  totalMinor: number
  cancellationDeadline?: string
  refundable: boolean
}

export interface HotelAvailability {
  hotelId: string
  name: string
  destination: string
  rates: HotelRate[]
  supplier: string
}

export interface RecheckRequest { hotelId: string; rateId: string; criteria: HotelSearchCriteria }
export interface PrebookRequest extends RecheckRequest { idempotencyKey: string }
export interface SupplierAdapter {
  readonly name: string
  search(criteria: HotelSearchCriteria): Promise<HotelAvailability[]>
  recheck(request: RecheckRequest): Promise<HotelRate>
  prebook(request: PrebookRequest): Promise<{ supplierReference: string; rate: HotelRate }>
  cancel(supplierReference: string): Promise<{ refundMinor: number }>
}

/** No credentials means the API stays honest instead of returning fake inventory. */
export class UnconfiguredSupplierAdapter implements SupplierAdapter {
  readonly name = 'unconfigured'
  async search(): Promise<HotelAvailability[]> { return [] }
  async recheck(): Promise<HotelRate> { throw new Error('No supplier adapter configured') }
  async prebook(): Promise<{ supplierReference: string; rate: HotelRate }> { throw new Error('No supplier adapter configured') }
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

export interface AgentPricingQuote { currency: string; subtotalMinor: number; markupMinor: number; totalMinor: number }
export function priceRate(rate: HotelRate, markupMinor = 0): AgentPricingQuote {
  return { currency: rate.currency, subtotalMinor: rate.totalMinor, markupMinor, totalMinor: rate.totalMinor + markupMinor }
}
