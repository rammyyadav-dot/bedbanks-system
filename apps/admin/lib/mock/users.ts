import type { User } from '../types/admin';

export const users: User[] = [
  { id: 'u_jordan', name: 'Jordan Davis', email: 'jordan@atlas.example', tenantId: 't_atlas', tenantName: 'Atlas Getaways', role: 'Platform Admin', status: 'active', lastActive: '2026-09-09T08:12:00Z', createdAt: '2025-02-11' },
  { id: 'u_maya', name: 'Maya Chen', email: 'maya@travelrepublic.example', tenantId: 't_travel', tenantName: 'Travel Republic', role: 'Tenant Admin', status: 'active', lastActive: '2026-09-09T07:40:00Z', createdAt: '2025-02-14' },
  { id: 'u_omar', name: 'Omar Khan', email: 'omar@holidaylines.example', tenantId: 't_holiday', tenantName: 'Holiday Lines', role: 'Operations Agent', status: 'suspended', lastActive: '2026-08-28T11:02:00Z', createdAt: '2024-11-25' },
  { id: 'u_priya', name: 'Priya Nair', email: 'priya@globalholidays.example', tenantId: 't_global', tenantName: 'Global Holidays', role: 'Finance Viewer', status: 'active', lastActive: '2026-09-08T18:20:00Z', createdAt: '2024-09-02' },
  { id: 'u_leo', name: 'Leo Fischer', email: 'leo@sunrisetours.example', tenantId: 't_sunrise', tenantName: 'Sunrise Tours', role: 'Operations Agent', status: 'pending', lastActive: '—', createdAt: '2026-01-30' },
  { id: 'u_amara', name: 'Amara Okafor', email: 'amara@enterprisetravel.example', tenantId: 't_enterprise', tenantName: 'Enterprise Travel Group', role: 'Tenant Admin', status: 'active', lastActive: '2026-09-09T06:55:00Z', createdAt: '2024-06-03' },
];
