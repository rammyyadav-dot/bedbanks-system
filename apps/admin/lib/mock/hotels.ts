import type { Hotel } from '../types/admin';

export const hotels: Hotel[] = [
  { id: 'h_1', name: 'Atlantis The Palm', code: 'GIATA-001042', destination: 'Dubai', country: 'United Arab Emirates', stars: 5, supplier: 'Global Hotel Supply', status: 'active', updatedAt: '2026-09-07' },
  { id: 'h_2', name: 'JW Marriott Marquis Dubai', code: 'GIATA-002981', destination: 'Dubai', country: 'United Arab Emirates', stars: 5, supplier: 'Supplier One', status: 'active', updatedAt: '2026-09-05' },
  { id: 'h_3', name: 'Address Beach Resort', code: 'GIATA-007730', destination: 'Dubai', country: 'United Arab Emirates', stars: 5, supplier: 'Supplier Two', status: 'active', updatedAt: '2026-09-02' },
  { id: 'h_4', name: 'Rixos Premium Dubai', code: 'GIATA-004410', destination: 'Dubai', country: 'United Arab Emirates', stars: 5, supplier: 'Regional DMC', status: 'inactive', updatedAt: '2026-08-19' },
  { id: 'h_5', name: 'Hilton Dubai Palm Jumeirah', code: 'GIATA-005502', destination: 'Dubai', country: 'United Arab Emirates', stars: 4, supplier: 'Global Hotel Supply', status: 'active', updatedAt: '2026-09-08' },
  { id: 'h_6', name: 'Hoxton Shoreditch', code: 'GIATA-001042-L', destination: 'London', country: 'United Kingdom', stars: 4, supplier: 'Supplier One', status: 'active', updatedAt: '2026-09-01' },
  { id: 'h_7', name: 'CitizenM Tower', code: 'GIATA-002981-L', destination: 'London', country: 'United Kingdom', stars: 4, supplier: 'Supplier Two', status: 'active', updatedAt: '2026-08-27' },
  { id: 'h_8', name: 'Hotel Arts Barcelona', code: 'GIATA-007730-B', destination: 'Barcelona', country: 'Spain', stars: 5, supplier: 'Regional DMC', status: 'pending', updatedAt: '2026-09-03' },
];
