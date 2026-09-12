import type { Booking } from '../types/admin';

export const bookings: Booking[] = [
  { id: 'bk_1', reference: 'FB260908000124', tenant: 'Travel Republic', agent: 'Maya Chen', hotel: 'Atlantis The Palm', checkIn: '2026-10-02', checkOut: '2026-10-06', supplier: 'Global Hotel Supply', amount: 1935.2, currency: 'USD', status: 'confirmed', createdAt: '2026-09-08T10:22:00Z', guest: 'R. Fernandez', supplierReference: 'GHS-88214', cost: 1640, margin: 295.2 },
  { id: 'bk_2', reference: 'FB260908000125', tenant: 'Atlas Getaways', agent: 'Jordan Davis', hotel: 'JW Marriott Marquis Dubai', checkIn: '2026-09-20', checkOut: '2026-09-23', supplier: 'Supplier One', amount: 897, currency: 'USD', status: 'pending', createdAt: '2026-09-08T11:05:00Z', guest: 'S. Malik' },
  { id: 'bk_3', reference: 'FB260907000098', tenant: 'Global Holidays', agent: 'Priya Nair', hotel: 'Hilton Dubai Palm Jumeirah', checkIn: '2026-09-18', checkOut: '2026-09-21', supplier: 'Global Hotel Supply', amount: 648, currency: 'USD', status: 'failed', createdAt: '2026-09-07T16:40:00Z', guest: 'T. Nkemdirim' },
  { id: 'bk_4', reference: 'FB260906000071', tenant: 'Enterprise Travel Group', agent: 'Amara Okafor', hotel: 'Hoxton Shoreditch', checkIn: '2026-09-14', checkOut: '2026-09-16', supplier: 'Supplier One', amount: 356.5, currency: 'GBP', status: 'cancelled', createdAt: '2026-09-06T09:12:00Z', guest: 'L. Novak' },
  { id: 'bk_5', reference: 'FB260909000201', tenant: 'Travel Republic', agent: 'Maya Chen', hotel: 'Hotel Arts Barcelona', checkIn: '2026-11-01', checkOut: '2026-11-05', supplier: 'Regional DMC', amount: 1420, currency: 'EUR', status: 'confirmed', createdAt: '2026-09-09T07:30:00Z', guest: 'D. Kovac' },
];
