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

export async function getTenants() { return mock.tenants; }
export async function getTenant(id: string) { return mock.tenants.find((t) => t.id === id) ?? null; }
export async function getUsers() { return mock.users; }
export async function getUser(id: string) { return mock.users.find((u) => u.id === id) ?? null; }
export async function getRoles() { return mock.roles; }
export async function getRole(id: string) { return mock.roles.find((r) => r.id === id) ?? null; }
export async function getPermissionResources() { return mock.permissionResources; }
export async function getAuditEvents() { return mock.auditEvents; }
export async function getHotels() { return mock.hotels; }
export async function getHotel(id: string) { return mock.hotels.find((h) => h.id === id) ?? null; }
export async function getRooms() { return mock.rooms; }
export async function getRoomsByHotel(hotelId: string) { return mock.rooms.filter((r) => r.hotelId === hotelId); }
export async function getSuppliers() { return mock.suppliers; }
export async function getSupplier(id: string) { return mock.suppliers.find((s) => s.id === id) ?? null; }
export async function getContracts() { return mock.contracts; }
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
    suppliers: suppliers.length,
    bookingsToday: bookings.length,
    revenueToday: bookings.reduce((sum, b) => sum + b.amount, 0),
    pendingBookings: bookings.filter((b) => b.status === 'pending').length,
    supplierErrors: suppliers.filter((s) => s.connection === 'down').length,
  };
}
