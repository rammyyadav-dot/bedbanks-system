import type { Supplier } from '../types/admin';

export const suppliers: Supplier[] = [
  { id: 'sup_one', name: 'Supplier One', type: 'API', connection: 'healthy', hotels: 3120, lastSync: '2026-09-09T07:50:00Z', successRate: 99.4, status: 'active' },
  { id: 'sup_two', name: 'Supplier Two', type: 'API', connection: 'healthy', hotels: 2480, lastSync: '2026-09-09T08:00:00Z', successRate: 98.7, status: 'active' },
  { id: 'sup_global', name: 'Global Hotel Supply', type: 'XML', connection: 'degraded', hotels: 5900, lastSync: '2026-09-09T05:12:00Z', successRate: 92.1, status: 'active' },
  { id: 'sup_regional_dmc', name: 'Regional DMC', type: 'DMC', connection: 'down', hotels: 640, lastSync: '2026-09-08T14:02:00Z', successRate: 71.3, status: 'inactive' },
];
