import type { Booking, Property, SupplierContext, SupplierDashboard } from './types'

export const supplierContexts: SupplierContext[] = [
  { id: 'sup-hotel-001', name: 'Meridian Hospitality Group', type: 'HOTEL', market: 'United Arab Emirates', onboardingProgress: 86 },
  { id: 'sup-dmc-001', name: 'Gulf Horizons DMC', type: 'DMC', market: 'Middle East', onboardingProgress: 72 },
  { id: 'sup-cm-001', name: 'Nexus Channel Connect', type: 'CHANNEL_MANAGER', market: 'Global', onboardingProgress: 64 },
]

export const properties: Property[] = [
  { id: 'FBH-10482', supplierReference: 'MHG-DXB-01', name: 'Meridian Grand Dubai', destination: 'Dubai', country: 'UAE', stars: 5, contentScore: 92, rooms: 8, contractStatus: 'Active', inventoryStatus: 'Loaded', mappingStatus: 'Mapped', lastUpdated: '16 Sep 2026 · 17:42', status: 'Live preview' },
  { id: 'FBH-10483', supplierReference: 'MHG-AUH-03', name: 'Meridian Corniche Abu Dhabi', destination: 'Abu Dhabi', country: 'UAE', stars: 5, contentScore: 78, rooms: 6, contractStatus: 'Review due', inventoryStatus: '7 gaps', mappingStatus: 'Mapped', lastUpdated: '16 Sep 2026 · 15:18', status: 'Needs attention' },
  { id: 'FBH-10916', supplierReference: 'GH-RAK-14', name: 'Al Noor Beach Resort', destination: 'Ras Al Khaimah', country: 'UAE', stars: 4, contentScore: 63, rooms: 4, contractStatus: 'Draft', inventoryStatus: 'Not loaded', mappingStatus: 'Unmapped', lastUpdated: '15 Sep 2026 · 11:05', status: 'Draft' },
  { id: 'FBH-11207', supplierReference: 'GH-MCT-07', name: 'Harbour View Muscat', destination: 'Muscat', country: 'Oman', stars: 4, contentScore: 88, rooms: 5, contractStatus: 'Active', inventoryStatus: 'Loaded', mappingStatus: 'Pending', lastUpdated: '14 Sep 2026 · 19:25', status: 'Mapping review' },
]

export const bookings: Booking[] = [
  { id: 'FBS-260916-1842', property: 'Meridian Grand Dubai', arrival: '20 Sep 2026', departure: '24 Sep 2026', room: 'Deluxe King · BB', status: 'Confirmed', payableMinor: 284500, currency: 'AED' },
  { id: 'FBS-260916-1798', property: 'Meridian Corniche Abu Dhabi', arrival: '18 Sep 2026', departure: '21 Sep 2026', room: 'Executive Sea View · HB', status: 'Action required', payableMinor: 196000, currency: 'AED' },
  { id: 'FBS-260915-1664', property: 'Harbour View Muscat', arrival: '23 Sep 2026', departure: '26 Sep 2026', room: 'Superior Twin · RO', status: 'Confirmed', payableMinor: 148600, currency: 'OMR' },
]

export const dashboard: SupplierDashboard = {
  metrics: [
    { label: 'Active properties', value: '12', detail: '2 require review', trend: 'up' },
    { label: 'Rooms configured', value: '74', detail: 'Across 12 properties', trend: 'up' },
    { label: 'Inventory coverage', value: '93.4%', detail: 'Next 90 days', trend: 'up' },
    { label: 'Active contracts', value: '18', detail: '3 expiring in 30 days', trend: 'flat' },
    { label: 'Arrivals today', value: '16', detail: '22 rooms', trend: 'up' },
    { label: 'Pending actions', value: '7', detail: '2 time-sensitive', trend: 'down' },
  ],
  properties,
  bookings,
  alerts: [
    { id: 'a1', title: 'Inventory gap detected', detail: 'Meridian Corniche · 03–09 Oct', time: '18 min ago', tone: 'danger' },
    { id: 'a2', title: 'Contract expiring soon', detail: 'Winter 2026 FIT · 28 days', time: '2 hr ago', tone: 'warning' },
    { id: 'a3', title: 'Mapping review requested', detail: 'Harbour View Muscat · 2 rooms', time: 'Yesterday', tone: 'info' },
  ],
}
