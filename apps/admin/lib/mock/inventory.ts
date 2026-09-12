import type { InventoryRow } from '../types/admin';

export const inventory: InventoryRow[] = [
  { id: 'inv_1', hotel: 'Atlantis The Palm', room: 'Deluxe Ocean View', date: '2026-09-15', allotment: 20, available: 6, stopSell: false, release: 3, status: 'active' },
  { id: 'inv_2', hotel: 'Atlantis The Palm', room: 'Grand Suite', date: '2026-09-15', allotment: 8, available: 0, stopSell: true, release: 3, status: 'inactive' },
  { id: 'inv_3', hotel: 'JW Marriott Marquis Dubai', room: 'Executive Room', date: '2026-09-15', allotment: 30, available: 17, stopSell: false, release: 2, status: 'active' },
  { id: 'inv_4', hotel: 'Hilton Dubai Palm Jumeirah', room: 'Standard Double', date: '2026-09-15', allotment: 15, available: 4, stopSell: false, release: 1, status: 'active' },
  { id: 'inv_5', hotel: 'Hoxton Shoreditch', room: 'Loft Room', date: '2026-09-15', allotment: 12, available: 9, stopSell: false, release: 2, status: 'active' },
];
