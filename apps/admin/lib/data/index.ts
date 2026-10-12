// Authoritative Admin API access. No mock or fallback data lives in this module.

import { routes, supplyRoutes, type TenantSettingsView, type UpdateTenantSettingsRequest, type SellabilityRequest, type SellabilityResult, type SupplyCapabilities } from '@bedbanks/contracts'
import { apiRequest } from '../api/client'
import type { AdminDashboardView, DashboardQuery } from '../types/dashboard'

export async function getDashboard({ range }: DashboardQuery): Promise<AdminDashboardView> {
  return apiRequest<AdminDashboardView>(`/admin/dashboard?range=${encodeURIComponent(range)}`)
}

export async function getTenantSettings(tenantId?: string) { return apiRequest<TenantSettingsView>(routes.admin.settings, tenantId ? { headers: { 'x-fbeds-tenant-id': tenantId } } : {}) }
export async function updateTenantSettings(input: UpdateTenantSettingsRequest, idempotencyKey: string, tenantId?: string) {
  return apiRequest<TenantSettingsView>(routes.admin.settings, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey, ...(tenantId ? { 'x-fbeds-tenant-id': tenantId } : {}) }, body: JSON.stringify(input) })
}

export async function createPlatformRole(input: { id: string; name: string; description?: string }) { return apiRequest('/platform/access/roles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }); }
export async function updatePlatformRole(roleId: string, input: { id: string; name: string; description?: string }) { return apiRequest(`/platform/access/roles/${roleId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }); }
export async function setPlatformRolePermissions(roleId: string, permissionIds: string[]) { return apiRequest(`/platform/access/roles/${roleId}/permissions`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ permissionIds }) }); }
export async function assignPlatformRole(input: { userId: string; roleId: string }) { return apiRequest('/platform/access/assignments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }); }
export async function revokePlatformRole(userId: string, roleId: string) { return apiRequest(`/platform/access/assignments/${userId}/${roleId}`, { method: 'DELETE' }); }
export interface HotelRecord { id: string; name: string; city: string; countryCode: string; timeZone: string; contentStatus: string }
export async function getHotels() { return apiRequest<HotelRecord[]>('/supply/hotels'); }
export async function getHotel(id: string) { return apiRequest(`/supply/hotels/${id}`); }
export async function getRooms() { return apiRequest<RoomTypeRecord[]>('/supply/room-types'); }
export async function getRoomsByHotel(hotelId: string) { return apiRequest(`/supply/hotels/${hotelId}/rooms`); }
export interface SupplySupplier { id: string; type: string; status: string; legalName: string; displayName: string; countryCode: string; defaultCurrency: string; contactMetadata: Record<string, unknown>; createdAt: string; updatedAt: string }
export interface SupplierList { items: SupplySupplier[]; page: number; pageSize: number; total: number }
export interface BoardBasisRecord { id: string; code: string; name: string; description: string | null; isActive: boolean; createdAt: string; updatedAt: string }
export async function getSuppliers(query = '') { return apiRequest<SupplierList>(`/supply/suppliers${query ? `?${query}` : ''}`); }
export async function getSupplier(id: string) { return apiRequest<SupplySupplier>(`/supply/suppliers/${id}`); }
export async function createSupplier(input: Omit<SupplySupplier, 'id' | 'createdAt' | 'updatedAt'>) { return apiRequest<SupplySupplier>('/supply/suppliers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }); }
export async function updateSupplier(id: string, input: Partial<Omit<SupplySupplier, 'id' | 'createdAt' | 'updatedAt'>>) { return apiRequest<SupplySupplier>(`/supply/suppliers/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }); }
export async function getBoardBasesAdmin() { return apiRequest<BoardBasisRecord[]>('/supply/board-bases/admin'); }
export async function createBoardBasis(input: { code: string; name: string; description?: string; isActive?: boolean }) { return apiRequest<BoardBasisRecord>('/supply/board-bases', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }); }
export async function updateBoardBasis(id: string, input: { name?: string; description?: string | null; isActive?: boolean }) { return apiRequest<BoardBasisRecord>(`/supply/board-bases/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }); }
const json = { 'Content-Type': 'application/json' }
export interface AdminContract {
  id: string; code: string; validFrom: string; validTo: string; settlementCurrency: string; status: string; supplierId: string; supplierHotelMappingId: string | null;
  salesMarkets?: string[]; nationalities?: string[]; paymentPolicyRef?: string | null;
  supplier: { id: string; displayName: string };
  supplierHotelMapping?: { id: string; hotelId: string; status: string } | null;
}
export interface CancellationPolicyRecord { id: string; policySet?: string | null; daysBeforeCheckin: number; penaltyPercent: number | null; penaltyMinor: string | null; currency: string | null }
export interface ChildPolicyRecord { id: string; minAge: number; maxAge: number; extraBedAllowed: boolean; supplementMinor: string | null; currency: string | null }
export interface LeadTimeRuleRecord { id: string; minLeadHours: number; maxLeadDays: number | null }
export interface AdminContractDetail extends AdminContract { cancellationPolicies: CancellationPolicyRecord[]; childPolicies: ChildPolicyRecord[]; leadTimeRules: LeadTimeRuleRecord | LeadTimeRuleRecord[] | null }
export interface ContractInput { supplierId: string; supplierHotelMappingId?: string | null; code: string; status?: string; validFrom: string; validTo: string; settlementCurrency: string; salesMarkets?: string[]; nationalities?: string[] }
export async function getContracts() { return apiRequest<AdminContract[]>('/supply/contracts'); }
export async function getContract(id: string) { return apiRequest<AdminContractDetail>(`/supply/contracts/${id}`); }
export async function createContract(input: ContractInput) { return apiRequest<AdminContract>('/supply/contracts', { method: 'POST', headers: json, body: JSON.stringify(input) }); }
export async function updateContract(id: string, input: Partial<ContractInput>) { return apiRequest<AdminContract>(`/supply/contracts/${id}`, { method: 'PATCH', headers: json, body: JSON.stringify(input) }); }
export async function createCancellationPolicy(contractId: string, input: { daysBeforeCheckin: number; penaltyPercent: number; currency?: string; policySet?: string | null }) { return apiRequest(`/supply/contracts/${contractId}/policies/cancellation`, { method: 'POST', headers: json, body: JSON.stringify(input) }); }
export async function createChildPolicy(contractId: string, input: { minAge: number; maxAge: number; extraBedAllowed: boolean }) { return apiRequest(`/supply/contracts/${contractId}/policies/child`, { method: 'POST', headers: json, body: JSON.stringify(input) }); }
export async function setLeadTimeRule(contractId: string, input: { minLeadHours: number; maxLeadDays?: number | null }) { return apiRequest(`/supply/contracts/${contractId}/policies/lead-time`, { method: 'POST', headers: json, body: JSON.stringify(input) }); }
export interface HotelMappingRecord { id: string; supplierId: string; hotelId: string; supplierHotelId: string; status: string }
export async function getHotelMappings() { return apiRequest<HotelMappingRecord[]>('/supply/mappings/hotels'); }
export async function getBoardBases() { return apiRequest<BoardBasisRecord[]>('/supply/board-bases'); }
export interface RoomTypeRecord { id: string; hotelId: string; name: string; code: string; maxAdults: number; maxChildren: number; maxOccupancy: number; isActive: boolean }
export interface AdminDailyRate {
  id: string; tenantId: string; ratePlanId: string; stayDate: string; updatedAt: string; occupancy: number; amountMinor: string; amountBasis: 'NET' | 'SELL' | null; currency: string;
  ratePlan: { id: string; code: string; roomType: { id: string; name: string; hotel: { id: string; name: string } }; boardBasis: { id: string; code: string; name: string } };
}
export async function getDailyRates(from: string, to = from, ratePlanId?: string) { return apiRequest<AdminDailyRate[]>(`/supply/daily-rates?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}${ratePlanId ? `&ratePlanId=${encodeURIComponent(ratePlanId)}` : ''}`); }
export async function updateDailyRate(input: { ratePlanId: string; stayDate: string; occupancy: number; amountMinor: string; amountBasis: 'NET' | 'SELL'; currency: string }) { return apiRequest('/supply/daily-rates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }); }
export async function bulkUpdateDailyRates(rows: Array<{ ratePlanId: string; stayDate: string; occupancy: number; amountMinor: string; amountBasis: 'NET' | 'SELL'; currency: string }>) { return apiRequest('/supply/daily-rates/bulk', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rows }) }); }
export async function checkSellability(input: SellabilityRequest) { return apiRequest<SellabilityResult>(supplyRoutes.sellability, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }); }
export async function getCapabilities() { return apiRequest<SupplyCapabilities>(supplyRoutes.capabilities); }

export interface AdminAvailabilityRow {
  id: string; tenantId: string; ratePlanId: string; stayDate: string; updatedAt: string; allotment: number; sold: number; held: number; stopSell: boolean; minStay: number;
  ratePlan: { id: string; code: string; releaseDays: number; roomType: { id: string; name: string; hotel: { id: string; name: string } }; boardBasis: { id: string; code: string; name: string } };
}
export async function getInventory(from: string, to = from, ratePlanId?: string) { return apiRequest<AdminAvailabilityRow[]>(`/supply/availability?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}${ratePlanId ? `&ratePlanId=${encodeURIComponent(ratePlanId)}` : ''}`); }
export async function updateAvailability(input: { ratePlanId: string; stayDate: string; allotment: number; sold?: number; stopSell?: boolean; minStay?: number }) { return apiRequest('/supply/availability', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }); }
export async function bulkUpdateAvailability(rows: Array<{ ratePlanId: string; stayDate: string; allotment: number; sold?: number; stopSell?: boolean; minStay?: number }>) { return apiRequest('/supply/availability/bulk', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rows }) }); }
export interface AdminRatePlan {
  id: string; tenantId: string; contractId: string; roomTypeId: string; boardBasisId: string; code: string; status: string; occupancy: number; currency: string;
  refundable: boolean; taxesIncluded: boolean; feesIncluded: boolean; minStay: number; maxStay: number | null; releaseDays: number;
  /** Optional sale window (ISO instants at midnight UTC) and payment type; null means inherit the contract term / not recorded. */
  validFrom?: string | null; validTo?: string | null; paymentType?: 'PREPAID' | 'PAY_AT_HOTEL' | null;
  /** Name of the contract's cancellation rule set this plan uses; null = the contract default rules. */
  cancellationPolicySet?: string | null;
  /** Buyer markets and guest nationalities this plan is sold to, on top of the contract's own lists. Empty = no extra restriction. */
  salesMarkets?: string[]; nationalities?: string[];
  /** Set when the plan sells from a shared inventory pool: its own allotment value is then not used. */
  inventoryPoolId?: string | null;
  /** Row version: activate and suspend must echo it so a stale view cannot overwrite a concurrent change. */
  updatedAt?: string;
  contract: { id: string; code: string; supplier: { id: string; displayName: string }; status?: string; validFrom?: string; validTo?: string; salesMarkets?: unknown };
  roomType: { id: string; name: string; hotel: { id: string; name: string } };
  boardBasis: { id: string; code: string; name: string };
}
export async function getRatePlans() { return apiRequest<AdminRatePlan[]>('/supply/rate-plans'); }
export async function getRatePlan(id: string) { return apiRequest<AdminRatePlan>(`/supply/rate-plans/${id}`); }
export interface RatePlanInput { contractId: string; roomTypeId: string; boardBasisId: string; code: string; occupancy: number; currency: string; refundable?: boolean; taxesIncluded?: boolean; feesIncluded?: boolean; minStay?: number; maxStay?: number | null; releaseDays?: number; validFrom?: string | null; validTo?: string | null; paymentType?: 'PREPAID' | 'PAY_AT_HOTEL' | null; cancellationPolicySet?: string | null; salesMarkets?: string[]; nationalities?: string[] }
export async function createRatePlan(input: RatePlanInput) { return apiRequest<AdminRatePlan>('/supply/rate-plans', { method: 'POST', headers: json, body: JSON.stringify(input) }); }
export async function updateRatePlan(id: string, input: Partial<RatePlanInput>) { return apiRequest<AdminRatePlan>(`/supply/rate-plans/${id}`, { method: 'PATCH', headers: json, body: JSON.stringify(input) }); }
export async function getRates() { return getRatePlans(); }

import type { CalendarEdit, CalendarPreview, RatePlanReadiness, RatePlanCloneRequest, RatePlanCapabilities } from '@bedbanks/contracts'
export type { CalendarEdit, CalendarPreview } from '@bedbanks/contracts'
export const previewCalendar = (input: CalendarEdit) => apiRequest<CalendarPreview>(supplyRoutes.calendarPreview, { method: 'POST', headers: json, body: JSON.stringify(input) })
export const applyCalendar = (input: CalendarEdit) => apiRequest<CalendarPreview>(supplyRoutes.calendarApply, { method: 'POST', headers: json, body: JSON.stringify(input) })

export async function getRatePlanPortfolio(input: { search?: string; status?: string; page: number; pageSize: number }) {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(input)) if (value !== undefined && value !== '') query.set(key, String(value))
  return apiRequest<{ items: AdminRatePlan[]; total: number; page: number; pageSize: number; hasMore: boolean; statusCounts?: Record<'DRAFT' | 'ACTIVE' | 'SUSPENDED' | 'EXPIRED', number> }>(`${supplyRoutes.ratePlanPortfolio}?${query}`)
}

// Rate-plan lifecycle (activation readiness, activate/suspend, clone). The API owns every rule; the browser only displays the verdict.
export type { RatePlanReadiness } from '@bedbanks/contracts'
const planPath = (path: string, ratePlanId: string) => path.replace(':ratePlanId', encodeURIComponent(ratePlanId))
export const getRatePlanCapabilities = () => apiRequest<RatePlanCapabilities>(supplyRoutes.ratePlanCapabilities)
export const getRatePlanReadiness = (ratePlanId: string) => apiRequest<RatePlanReadiness>(planPath(supplyRoutes.ratePlanReadiness, ratePlanId))
export const activateRatePlan = (ratePlanId: string, expectedUpdatedAt: string) => apiRequest<AdminRatePlan>(planPath(supplyRoutes.ratePlanActivate, ratePlanId), { method: 'POST', headers: json, body: JSON.stringify({ expectedUpdatedAt }) })
export const suspendRatePlan = (ratePlanId: string, expectedUpdatedAt: string, reason: string) => apiRequest<AdminRatePlan>(planPath(supplyRoutes.ratePlanSuspend, ratePlanId), { method: 'POST', headers: json, body: JSON.stringify({ expectedUpdatedAt, reason }) })
export const cloneRatePlan = (ratePlanId: string, input: RatePlanCloneRequest) => apiRequest<AdminRatePlan>(planPath(supplyRoutes.ratePlanClone, ratePlanId), { method: 'POST', headers: json, body: JSON.stringify(input) })
export async function getHotelRatePlans(hotelId: string, input: { search?: string; status?: string; page: number; pageSize: number }) {
  const query = new URLSearchParams({ hotelId })
  for (const [key, value] of Object.entries(input)) if (value !== undefined && value !== '') query.set(key, String(value))
  return apiRequest<{ items: AdminRatePlan[]; total: number; page: number; pageSize: number; hasMore: boolean; statusCounts?: Record<'DRAFT' | 'ACTIVE' | 'SUSPENDED' | 'EXPIRED', number> }>(`${supplyRoutes.ratePlanPortfolio}?${query}`)
}
