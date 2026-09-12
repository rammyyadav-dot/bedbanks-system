import type { Contract } from '../types/admin';

export const contracts: Contract[] = [
  { id: 'c_1', supplier: 'Supplier One', name: 'Dubai Preferred 2026', validFrom: '2026-01-01', validTo: '2026-12-31', currency: 'USD', markup: 18, commission: 12, status: 'active' },
  { id: 'c_2', supplier: 'Supplier Two', name: 'UK Standard 2026', validFrom: '2026-01-01', validTo: '2026-12-31', currency: 'GBP', markup: 15, commission: 10, status: 'active' },
  { id: 'c_3', supplier: 'Global Hotel Supply', name: 'MEA Volume 2026', validFrom: '2026-03-01', validTo: '2027-02-28', currency: 'USD', markup: 20, commission: 14, status: 'active' },
  { id: 'c_4', supplier: 'Regional DMC', name: 'Barcelona Boutique', validFrom: '2025-06-01', validTo: '2026-05-31', currency: 'EUR', markup: 22, commission: 9, status: 'pending' },
];
