import type { RateRow } from '../types/admin';

export const rates: RateRow[] = [
  { id: 'rt_1', hotel: 'Atlantis The Palm', room: 'Deluxe Ocean View', mealPlan: 'Bed & Breakfast', date: '2026-09-15', supplierCost: 410, markup: 18, sellRate: 483.8, currency: 'USD', status: 'active' },
  { id: 'rt_2', hotel: 'JW Marriott Marquis Dubai', room: 'Executive Room', mealPlan: 'Room Only', date: '2026-09-15', supplierCost: 260, markup: 15, sellRate: 299, currency: 'USD', status: 'active' },
  { id: 'rt_3', hotel: 'Hilton Dubai Palm Jumeirah', room: 'Standard Double', mealPlan: 'Bed & Breakfast', date: '2026-09-15', supplierCost: 180, markup: 20, sellRate: 216, currency: 'USD', status: 'active' },
  { id: 'rt_4', hotel: 'Hoxton Shoreditch', room: 'Loft Room', mealPlan: 'Room Only', date: '2026-09-15', supplierCost: 155, markup: 15, sellRate: 178.25, currency: 'GBP', status: 'pending' },
];
