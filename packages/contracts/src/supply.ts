export type SupplyId = string
export type SupplyDate = string

export interface HotelRead { id: string; tenantId: string; name: string; propertyType: string; starRating: number | null; address: string | null; city: string; countryCode: string; timeZone: string; contentStatus: string; externalRef: string | null }
export interface RoomTypeRead { id: string; hotelId: string; name: string; code: string; maxAdults: number; maxChildren: number; maxOccupancy: number; isActive: boolean }
export interface BoardBasisRead { id: string; tenantId: string; code: string; name: string; description: string | null; isActive: boolean }
export interface ContractRead { id: string; tenantId: string; supplierId: string; supplierHotelMappingId: string | null; code: string; status: string; validFrom: SupplyDate; validTo: SupplyDate; settlementCurrency: string }
export interface RatePlanRead { id: string; tenantId: string; contractId: string; roomTypeId: string; boardBasisId: string; code: string; status: string; occupancy: number; currency: string }
export interface DailyRateRead { id: string; tenantId: string; ratePlanId: string; stayDate: SupplyDate; occupancy: number; amountMinor: string; currency: string }
export interface DailyAvailabilityRead { id: string; tenantId: string; ratePlanId: string; stayDate: SupplyDate; allotment: number; sold: number; stopSell: boolean; minStay: number }
export interface SellabilityResult { eligible: boolean; status: 'ELIGIBLE_FOR_FUTURE_SEARCH' | 'NOT_ELIGIBLE'; reasons: string[] }

export const supplyRoutes = {
  hotels: '/supply/hotels', roomTypes: '/supply/room-types', boardBases: '/supply/board-bases', contracts: '/supply/contracts', ratePlans: '/supply/rate-plans', dailyRates: '/supply/daily-rates', availability: '/supply/availability', sellability: '/supply/sellability',
} as const

export const supplyPermissions = {
  hotelsRead: 'supply.hotels.read', hotelsManage: 'supply.hotels.manage', roomsRead: 'supply.rooms.read', roomsManage: 'supply.rooms.manage', contractsRead: 'supply.contracts.read', contractsManage: 'supply.contracts.manage', ratesRead: 'supply.rates.read', ratesManage: 'supply.rates.manage', availabilityRead: 'supply.availability.read', availabilityManage: 'supply.availability.manage',
} as const
export type SupplyPermission = (typeof supplyPermissions)[keyof typeof supplyPermissions]

export function serializeSupply<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item)) as T
}
