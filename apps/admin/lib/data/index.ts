// FBEDS Admin — mock data-access layer (spec section 40).
//
// Every function here returns mock data today. The signatures and
// return shapes are exactly what the equivalent `/api/v1/*` endpoint
// will return once the backend exists — swapping the body of each
// function for a `fetch()` call is the entire migration; no page using
// these functions should need to change.
//
// Deliberately NOT actually async work — a resolved Promise is enough
// to let pages already be written against `await getX()` /
// React Server Component data-fetching, without pretending there's a
// network call that isn't really happening yet.

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
export async function getHotels() { return apiRequest('/supply/hotels'); }
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
export async function getContracts() { return apiRequest('/supply/contracts'); }
export async function getInventory() { return mock.inventory; }
export async function getRates() { return mock.rates; }
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
