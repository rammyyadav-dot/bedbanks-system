// Authoritative supply/dashboard API access; remaining legacy areas below still use mocks.

import * as mock from '../mock';
import { apiRequest } from '../api/client'
import type { AdminDashboardView, DashboardQuery } from '../types/dashboard'

export async function getDashboard({ range }: DashboardQuery): Promise<AdminDashboardView> {
  return apiRequest<AdminDashboardView>(`/admin/dashboard?range=${encodeURIComponent(range)}`)
}

export async function getTenants() { return mock.tenants; }
export async function getTenant(id: string) { return mock.tenants.find((t) => t.id === id) ?? null; }
export async function getUsers() { return mock.users; }
export async function getUser(id: string) { return mock.users.find((u) => u.id === id) ?? null; }
export async function getRoles() { return apiRequest('/platform/access/roles'); }
export async function getRole(id: string) { const roles = await getRoles() as Array<{ id: string }>; return roles.find((role) => role.id === id) ?? null; }
export async function getPlatformPermissions() { return apiRequest('/platform/access/permissions'); }
export async function getPlatformAssignments() { return apiRequest('/platform/access/assignments'); }
export async function createPlatformRole(input: { id: string; name: string; description?: string }) { return apiRequest('/platform/access/roles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }); }
export async function updatePlatformRole(roleId: string, input: { id: string; name: string; description?: string }) { return apiRequest(`/platform/access/roles/${roleId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }); }
export async function setPlatformRolePermissions(roleId: string, permissionIds: string[]) { return apiRequest(`/platform/access/roles/${roleId}/permissions`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ permissionIds }) }); }
export async function assignPlatformRole(input: { userId: string; roleId: string }) { return apiRequest('/platform/access/assignments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }); }
export async function revokePlatformRole(userId: string, roleId: string) { return apiRequest(`/platform/access/assignments/${userId}/${roleId}`, { method: 'DELETE' }); }
export async function getPermissionResources() { return mock.permissionResources; }
export async function getAuditEvents() { return mock.auditEvents; }
export async function getHotels(): Promise<Array<{ id: string }>> { return apiRequest<Array<{ id: string }>>('/supply/hotels'); }
export async function getHotel(id: string) { return apiRequest(`/supply/hotels/${id}`); }
export async function getRooms() { return apiRequest('/supply/room-types'); }
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
export interface AdminContract {
  id: string; code: string; validFrom: string; validTo: string; settlementCurrency: string; status: string;
  supplier: { id: string; displayName: string };
}
export async function getContracts() { return apiRequest<AdminContract[]>('/supply/contracts'); }
export interface AdminDailyRate {
  id: string; tenantId: string; ratePlanId: string; stayDate: string; occupancy: number; amountMinor: string; amountBasis: 'NET' | 'SELL'; currency: string;
  ratePlan: { id: string; code: string; roomType: { id: string; name: string; hotel: { id: string; name: string } }; boardBasis: { id: string; code: string; name: string } };
}
export async function getDailyRates(from: string, to = from, ratePlanId?: string) { return apiRequest<AdminDailyRate[]>(`/supply/daily-rates?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}${ratePlanId ? `&ratePlanId=${encodeURIComponent(ratePlanId)}` : ''}`); }
export async function updateDailyRate(input: { ratePlanId: string; stayDate: string; occupancy: number; amountMinor: string; amountBasis: 'NET' | 'SELL'; currency: string }) { return apiRequest('/supply/daily-rates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }); }
export async function bulkUpdateDailyRates(rows: Array<{ ratePlanId: string; stayDate: string; occupancy: number; amountMinor: string; amountBasis: 'NET' | 'SELL'; currency: string }>) { return apiRequest('/supply/daily-rates/bulk', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rows }) }); }
export async function checkSellability(input: { ratePlanId: string; stayDate: string; occupancy: number }) { return apiRequest<{ eligible: boolean; status: string; reasons: string[] }>('/supply/sellability', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }); }

export interface AdminAvailabilityRow {
  id: string; tenantId: string; ratePlanId: string; stayDate: string; allotment: number; sold: number; held: number; stopSell: boolean; minStay: number;
  ratePlan: { id: string; code: string; releaseDays: number; roomType: { id: string; name: string; hotel: { id: string; name: string } }; boardBasis: { id: string; code: string; name: string } };
}
export async function getInventory(from: string, to = from) { return apiRequest<AdminAvailabilityRow[]>(`/supply/availability?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`); }
export async function updateAvailability(input: { ratePlanId: string; stayDate: string; allotment: number; sold?: number; stopSell?: boolean; minStay?: number }) { return apiRequest('/supply/availability', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }); }
export async function bulkUpdateAvailability(rows: Array<{ ratePlanId: string; stayDate: string; allotment: number; sold?: number; stopSell?: boolean; minStay?: number }>) { return apiRequest('/supply/availability/bulk', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rows }) }); }
export interface AdminRatePlan {
  id: string; tenantId: string; contractId: string; roomTypeId: string; boardBasisId: string; code: string; status: string; occupancy: number; currency: string;
  refundable: boolean; taxesIncluded: boolean; feesIncluded: boolean; minStay: number; maxStay: number | null; releaseDays: number;
  contract: { id: string; code: string; supplier: { id: string; displayName: string } };
  roomType: { id: string; name: string; hotel: { id: string; name: string } };
  boardBasis: { id: string; code: string; name: string };
}
export async function getRatePlans() { return apiRequest<AdminRatePlan[]>('/supply/rate-plans'); }
export async function getRatePlan(id: string) { return apiRequest<AdminRatePlan>(`/supply/rate-plans/${id}`); }
export async function updateRatePlan(id: string, input: Partial<Pick<AdminRatePlan, 'status' | 'occupancy' | 'currency' | 'refundable' | 'taxesIncluded' | 'feesIncluded' | 'minStay' | 'maxStay' | 'releaseDays'>>) { return apiRequest<AdminRatePlan>(`/supply/rate-plans/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }); }
export async function getRates() { return getRatePlans(); }
export async function getSearchComparison() { return mock.searchComparison; }
export async function getBookings() { return mock.bookings; }
export async function getBooking(id: string) { return mock.bookings.find((b) => b.id === id) ?? null; }
export async function getCancellations() { return mock.cancellations; }
export async function getWallets() { return mock.wallets; }
export async function getLedger() { return mock.ledger; }
export async function getPayments() { return mock.payments; }
export async function getEmailLogs() { return mock.emailLogs; }

export async function getSystemStatus() {
  return [
    { name: 'API', state: 'healthy' as const, detail: '/api/v1 — 99.98% uptime (30d)' },
    { name: 'Database', state: 'healthy' as const, detail: 'Postgres — 4ms p50 query time' },
    { name: 'Supplier Connections', state: 'degraded' as const, detail: '1 of 4 suppliers degraded' },
    { name: 'Email', state: 'healthy' as const, detail: 'SES — delivering normally' },
  ];
}

export async function getDashboardKpis() {
  const [tenants, hotels, suppliers, bookings] = await Promise.all([
    getTenants(), getHotels(), getSuppliers(), getBookings(),
  ]);
  return {
    activeTenants: tenants.filter((t) => t.status === 'active').length,
    activeAgents: mock.users.filter((u) => u.status === 'active').length,
    hotels: hotels.length,
    suppliers: suppliers.total,
    bookingsToday: bookings.length,
    revenueToday: bookings.reduce((sum, b) => sum + b.amount, 0),
    pendingBookings: bookings.filter((b) => b.status === 'pending').length,
    supplierErrors: 0,
  };
}
