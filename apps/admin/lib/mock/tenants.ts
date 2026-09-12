import type { Tenant } from '../types/admin';

export const tenants: Tenant[] = [
  { id: 't_travel', name: 'Travel Republic', code: 'TRV-001', tier: 'Gold', plan: 'Enterprise', users: 24, status: 'active', createdAt: '2025-02-11' },
  { id: 't_atlas', name: 'Atlas Getaways', code: 'AGT-093', tier: 'Silver', plan: 'Growth', users: 9, status: 'active', createdAt: '2025-05-03' },
  { id: 't_holiday', name: 'Holiday Lines', code: 'HLY-442', tier: 'VIP', plan: 'Enterprise', users: 41, status: 'suspended', createdAt: '2024-11-22' },
  { id: 't_sunrise', name: 'Sunrise Tours', code: 'SUN-118', tier: 'Bronze', plan: 'Starter', users: 4, status: 'pending', createdAt: '2026-01-30' },
  { id: 't_global', name: 'Global Holidays', code: 'GBL-207', tier: 'Gold', plan: 'Enterprise', users: 33, status: 'active', createdAt: '2024-08-14' },
  { id: 't_enterprise', name: 'Enterprise Travel Group', code: 'ETG-305', tier: 'Platform', plan: 'Enterprise', users: 58, status: 'active', createdAt: '2024-06-01' },
];
