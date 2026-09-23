export type SupplyId = string
export type SupplyDate = string

export interface HotelRead { id: string; tenantId: string; name: string; propertyType: string; starRating: number | null; address: string | null; city: string; countryCode: string; timeZone: string; contentStatus: string; externalRef: string | null; createdAt?: string; updatedAt?: string }
export interface HotelWrite { name: string; propertyType: string; starRating?: number | null; address?: string | null; city: string; countryCode: string; timeZone?: string; externalRef?: string | null }
export interface HotelUpdate extends Partial<HotelWrite> {}
export interface RoomTypeRead { id: string; hotelId: string; name: string; code: string; maxAdults: number; maxChildren: number; maxOccupancy: number; beddingMetadata?: Record<string, unknown>; isActive: boolean; createdAt?: string; updatedAt?: string }
export interface RoomTypeWrite { name: string; code: string; maxAdults: number; maxChildren?: number; maxOccupancy: number; beddingMetadata?: Record<string, unknown>; isActive?: boolean }
export interface RoomTypeUpdate extends Partial<RoomTypeWrite> {}
export type MappingStatus = 'PENDING' | 'MAPPED' | 'REJECTED'
export interface HotelMappingRead { id: string; tenantId: string; supplierId: string; hotelId: string; supplierHotelId: string; status: MappingStatus; confidence: number | null; sourceMetadata: Record<string, unknown> }
export interface RoomMappingRead { id: string; tenantId: string; supplierHotelMappingId: string; hotelId: string; supplierRoomId: string; roomTypeId: string; status: MappingStatus; confidence: number | null; sourceMetadata: Record<string, unknown> }
export interface HotelMappingWrite { supplierId: string; hotelId: string; supplierHotelId: string; confidence?: number | null; sourceMetadata?: Record<string, unknown> }
export interface RoomMappingWrite { supplierRoomId: string; roomTypeId: string; confidence?: number | null; sourceMetadata?: Record<string, unknown> }
export type MappingMetadataUpdate = Pick<HotelMappingWrite, 'confidence' | 'sourceMetadata'>
export interface BoardBasisRead { id: string; tenantId: string; code: string; name: string; description: string | null; isActive: boolean }
export interface ContractRead { id: string; tenantId: string; supplierId: string; supplierHotelMappingId: string | null; code: string; status: string; validFrom: SupplyDate; validTo: SupplyDate; settlementCurrency: string }
export interface RatePlanRead { id: string; tenantId: string; contractId: string; roomTypeId: string; boardBasisId: string; code: string; status: string; occupancy: number; currency: string }
export interface DailyRateRead { id: string; tenantId: string; ratePlanId: string; stayDate: SupplyDate; occupancy: number; amountMinor: string; currency: string }
export interface DailyAvailabilityRead { id: string; tenantId: string; ratePlanId: string; stayDate: SupplyDate; allotment: number; sold: number; stopSell: boolean; minStay: number }
export interface SellabilityResult { eligible: boolean; status: 'ELIGIBLE_FOR_FUTURE_SEARCH' | 'NOT_ELIGIBLE'; reasons: string[] }

export const supplyRoutes = {
  hotelMappings: '/supply/mappings/hotels', hotelMapping: '/supply/mappings/hotels/:mappingId', roomMappings: '/supply/mappings/hotels/:mappingId/rooms', roomMapping: '/supply/mappings/hotels/:mappingId/rooms/:roomMappingId',
  mappingOptions: '/supply/mappings/options', mappingRoomOptions: '/supply/mappings/options/rooms/:mappingId',
  hotelMappingApprove: '/supply/mappings/hotels/:mappingId/approve', hotelMappingReject: '/supply/mappings/hotels/:mappingId/reject', hotelMappingReopen: '/supply/mappings/hotels/:mappingId/reopen',
  roomMappingApprove: '/supply/mappings/hotels/:mappingId/rooms/:roomMappingId/approve', roomMappingReject: '/supply/mappings/hotels/:mappingId/rooms/:roomMappingId/reject', roomMappingReopen: '/supply/mappings/hotels/:mappingId/rooms/:roomMappingId/reopen',
  hotels: '/supply/hotels', hotelRooms: '/supply/hotels/:hotelId/rooms', hotelRoom: '/supply/hotels/:hotelId/rooms/:roomId', roomTypes: '/supply/room-types', boardBases: '/supply/board-bases', contracts: '/supply/contracts', ratePlans: '/supply/rate-plans', dailyRates: '/supply/daily-rates', availability: '/supply/availability', sellability: '/supply/sellability',
} as const

export const supplyPermissions = {
  mappingsRead: 'supply.mappings.read', mappingsManage: 'supply.mappings.manage',
  hotelsRead: 'supply.hotels.read', hotelsManage: 'supply.hotels.manage', roomsRead: 'supply.rooms.read', roomsManage: 'supply.rooms.manage', contractsRead: 'supply.contracts.read', contractsManage: 'supply.contracts.manage', ratesRead: 'supply.rates.read', ratesManage: 'supply.rates.manage', availabilityRead: 'supply.availability.read', availabilityManage: 'supply.availability.manage',
} as const
export type SupplyPermission = (typeof supplyPermissions)[keyof typeof supplyPermissions]

export function serializeSupply<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item)) as T
}
