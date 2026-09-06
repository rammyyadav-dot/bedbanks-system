import type { TenantContext } from '@/lib/architecture'
export type ApiEnvelope<T> = { requestId: string; tenant: TenantContext; data: T; errors?: { code: string; message: string }[] }
export type HotelSearchRequest = { destination: string; checkIn: string; checkOut: string; rooms: number; guests: number }
export type BookingRequest = { hotelId: string; roomId: string; guestName: string }
export type FinanceSummary = { availableBalance: number; currency: string }
export interface SearchService { search(input: HotelSearchRequest): Promise<ApiEnvelope<unknown[]>> }
export interface BookingService { create(input: BookingRequest): Promise<ApiEnvelope<{ reference: string }>> }
export interface FinanceService { summary(): Promise<ApiEnvelope<FinanceSummary>> }
export interface SupplierAdapter { provider: string; search(input: HotelSearchRequest): Promise<unknown[]> }
// Implementations belong behind route handlers/server actions in a later delivery.
